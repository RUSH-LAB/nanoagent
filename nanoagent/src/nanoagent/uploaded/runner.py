"""The attempt runner: one leased attempt from claim to finalize (docs/plans/uploaded-harness-benchmarks.md, "Architecture").

Everything it touches is injected: the sandbox supervisor, the worker API client, the service relay, the clocks, the
verifier, the services factory, the plugin loader and projection. The lifecycle and the API calls it makes:

1. fetch source and package under the fence; `inspect_zip`; record `attempt.started`. A rejected source, an unknown
   toolchain, a dependency or build failure finalizes `build_failed` with the error code and runs nothing.
2. attempt network, attempt services behind the relay, `Request`, `start_case`. The lease is renewed in the background for
   the whole attempt, build included, and fenced locally: once its known expiry passes without a successful renewal the
   gateway, tool broker, command service and event intake refuse new work, as the server does. Lease loss revokes
   admission, kills the case and finalizes nothing (RUSH interrupts the attempt). A cancel (`409 canceled` on renew or
   admission) revokes, stops and finalizes `canceled` without a score.
3. on exit or the wall limit: revoke and drain the services, freeze and snapshot the workspace, read the result: the
   task tools policy's `RUSH_RESULT`, or the coding policy's `answer.json` of the frozen workspace
   (`answered`, `refused`, or `execution_failed` with its exact reason), commit the collector's process evidence, run the
   plugin verifier on the frozen outcome, project the evidence, upload spans and links and finalize.

Faults of the platform itself (a sandbox that will not start, a plugin that will not install, a tool container that fails
to launch) are logged and end only that attempt: its services are revoked, its sandbox and network removed, the process
evidence the collector has is committed, and renewal stops, so the attempt expires as interrupted with its score
unavailable. The worker goes on to its next job.
"""

from __future__ import annotations

import base64
import json
import logging
import secrets
import shutil
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import AsyncExitStack
from dataclasses import dataclass, field, replace
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

import anyio
import anyio.to_thread

from nanoagent import __version__
from nanoagent.plugin.manifest import PluginManifest, load_manifest
from nanoagent.plugin.verifier import VerifierError, verify_task_verifier_case
from nanoagent.uploaded import records as rec
from nanoagent.uploaded.answer import read_answer
from nanoagent.uploaded.app import AttemptServices
from nanoagent.uploaded.attempt import AttemptPolicy, ToolPolicy
from nanoagent.uploaded.broker import PluginToolRunner, ToolError
from nanoagent.uploaded.collector import ProcessEvent, ProcessEventKind, ProcessEvidence, launched_processes
from nanoagent.uploaded.contract import Answered, ContractError, Refused, validate, validate_result
from nanoagent.uploaded.endpoint import EndpointProfile
from nanoagent.uploaded.execservice import ExecError
from nanoagent.uploaded.plugin_package import unpack_package
from nanoagent.uploaded.reconcile import PendingCall, pending_calls
from nanoagent.uploaded.relay import ServiceRelay
from nanoagent.uploaded.rush_worker import (
    AttemptJob,
    Canceled,
    Emitter,
    Lease,
    LeaseLost,
    RushAdmission,
    RushJournal,
    RushUnavailable,
    RushWorkerClient,
    Sealed,
)
from nanoagent.uploaded.sandbox import (
    AttemptNetwork,
    BuildArtifact,
    BuildSpec,
    CaseHandle,
    CaseSpec,
    ExecOutcome,
    Limits,
    SandboxError,
    Termination,
    TerminationKind,
    ToolContainerSpec,
    ToolLauncher,
    WORKSPACE,
)
from nanoagent.uploaded.source import SourceLimits, extract, inspect_zip
from nanoagent.uploaded.toolchains import ToolchainProfile, resolve_dependencies, toolchain

LOG = logging.getLogger(__name__)
NS = 1_000_000_000
EXPECTED_SOURCES = ("worker", "gateway", "process")
EXEC_THREADS = 4  # concurrent managed commands per attempt
MISSING_ANSWER = "wrote no answer.json"  # read_answer's failure for an absent file
SNAPSHOT_EVENT_DIFF_BYTES = 128 * 1024  # of the diff a snapshot.taken event carries; the snapshot payload has all of it


class Supervisor(Protocol):
    """The part of the sandbox supervisor the runner uses."""

    def create_network(self, attempt_id: str, *, internet: bool = False) -> AttemptNetwork: ...

    def build(self, spec: BuildSpec) -> BuildArtifact: ...

    def create_case(self, spec: CaseSpec) -> CaseHandle: ...

    def prepare_plugin(self, root: Path, timeout_s: float) -> None: ...

    def tool_launcher(self, name: str) -> ToolLauncher: ...


class Plugins(Protocol):
    def load(self, data: bytes, sha256: str, plugin_id: str, folder: Path) -> PluginManifest:
        """Unpack and verify a plugin package (blocking)."""

    def tool_runner(self, manifest: PluginManifest, workspace: Path, permitted: tuple[str, ...], launcher: ToolLauncher) -> Any:
        """A `ToolRunner` for the permitted tools that is also an async context manager: the plugin's session opens on entry.

        The plugin runs through ``launcher`` in the case's tool container, where ``workspace`` is the case workspace.
        """


class SyncedPlugins:
    """The real loader: unpack, and serve tools through a [PluginToolRunner] in the case's tool container.

    The plugin's environment is prepared by the supervisor (`prepare_plugin`) inside the pinned toolchain image.
    """

    def load(self, data: bytes, sha256: str, plugin_id: str, folder: Path) -> PluginManifest:
        return load_manifest(unpack_package(data, sha256, plugin_id, folder))

    def tool_runner(self, manifest: PluginManifest, workspace: Path, permitted: tuple[str, ...], launcher: ToolLauncher) -> PluginToolRunner:
        return PluginToolRunner(manifest, workspace, permitted, launcher=launcher)


class NoTools:
    """The runner of an attempt that permits no tools (the coding policy)."""

    async def run(self, name: str, arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
        raise ToolError("tool_not_available", f"{name!r} is not a permitted tool", 403)


@dataclass(frozen=True)
class RunnerConfig:
    worker_id: str
    endpoint: EndpointProfile
    prices: Mapping[str, tuple[Decimal, Decimal]]  # model -> (input, output) USD per token, upper bounds
    scratch: Path
    limits: Limits = Limits()  # the worker's own bounds for what a run's limits do not set (captured output, snapshot size)
    capabilities: Mapping[str, Any] = field(default_factory=dict)  # the worker's maximum for each numeric limit, and internet support
    source_limits: SourceLimits = SourceLimits()
    index_urls: Mapping[str, str] = field(default_factory=dict)  # toolchain id -> dependency index
    reference_tokens_per_second: float = 100.0
    clock_tolerance_ns: int = 1_000_000
    drain_timeout_s: float = 10.0
    plugin_sync_timeout_s: float = 600.0
    renew_interval_s: float = 15.0
    harness_revision: str = __version__


@dataclass(frozen=True)
class AttemptResult:
    """How the attempt ended: `finalized`, `canceled` (finalized as such), `lease_lost` (nothing finalized), `sealed`, or
    `platform_fault` (nothing finalized: the attempt expires as interrupted)."""

    outcome: str
    execution: Mapping[str, Any] | None = None
    accounting: Sequence[PendingCall] = ()


class UnknownModelPrice(RuntimeError):
    pass


class RenewalConfigError(RuntimeError):
    pass


def default_project(records: list[dict[str, Any]], payloads: Mapping[str, bytes], redactions: Mapping[str, str]) -> Any:
    """The seam to trace projection: records, payload bytes and each payload's redaction status in, a `Projection` out."""
    from nanoagent.uploaded.projection import project

    return project(records, payloads, redactions)


def termination_wire(termination: Termination) -> dict[str, Any]:
    match termination.kind:
        case TerminationKind.TIMED_OUT:
            return {"status": "timed_out"}
        case TerminationKind.SIGNALED:
            return {"status": "signaled", "signal": termination.signal}
        case TerminationKind.EXITED | TerminationKind.NONZERO_EXIT:
            return {"status": "exited", "exit_code": termination.exit_code}


def exec_result(outcome: ExecOutcome) -> dict[str, Any]:
    def stream(data: bytes, truncated: bool) -> dict[str, Any]:
        return {"base64": base64.b64encode(data).decode("ascii"), "truncated": truncated}

    return {
        "termination": termination_wire(outcome.termination),
        "stdout": stream(outcome.stdout, outcome.stdout_truncated),
        "stderr": stream(outcome.stderr, outcome.stderr_truncated),
    }


class CaseCommands:
    """The command service's runner: managed commands run inside the case sandbox, once it has started."""

    def __init__(self, limits: Limits) -> None:
        self._limits = limits
        self.handle: CaseHandle | None = None
        self.outcomes: list[ExecOutcome] = []
        self._threads = anyio.CapacityLimiter(EXEC_THREADS)  # a harness's commands cannot starve the shared thread pool

    async def exec(self, argv: Sequence[str], cwd: str, timeout_ms: int, span_id: str | None) -> tuple[dict[str, Any], str]:
        handle = self.handle
        if handle is None:
            raise ExecError("case_not_started", "the case sandbox is not running", 503)
        try:
            outcome = await anyio.to_thread.run_sync(lambda: handle.exec_in_case(argv, cwd, timeout_ms, self._limits), abandon_on_cancel=True, limiter=self._threads)
        except ContractError as error:
            raise ExecError(error.code, error.message, 400 if error.code == "invalid_cwd" else 500) from error
        self.outcomes.append(outcome)
        return exec_result(outcome), outcome.launch_id


async def in_thread(function: Callable[..., Any], *args: Any) -> Any:
    return await anyio.to_thread.run_sync(function, *args)


async def shielded(cleanup: Callable[[], Awaitable[Any]]) -> None:
    """Run one cleanup even in a cancelled attempt (worker shutdown, a sibling's fault): unshielded, its thread would never
    start, leaving containers, the network and volumes behind. Each callback is shielded on its own, never the whole exit
    stack, whose entered contexts (the plugin's MCP session) must unwind their own cancel scopes in order."""
    with anyio.CancelScope(shield=True):
        await cleanup()


async def first_of(*events: anyio.Event) -> None:
    async with anyio.create_task_group() as group:

        async def watch(event: anyio.Event) -> None:
            await event.wait()
            group.cancel_scope.cancel()

        for event in events:
            group.start_soon(watch, event)


def process_facts(evidence: ProcessEvidence, to_monotonic_ns: Callable[[int], int], commands: Sequence[ExecOutcome]) -> tuple[list[rec.Fact], list[int]]:
    """The collector's events as process records, on the worker monotonic clock, ordered by time."""
    issued = {command.launch_id for command in commands}
    launch_ids = {identity: launch_id for identity, launch_id in launched_processes(evidence).items() if launch_id in issued}
    facts: list[tuple[int, rec.Fact]] = []
    for event in evidence.events:
        when = to_monotonic_ns(event.time_ns)
        match event.kind:
            case ProcessEventKind.CLONE if event.created_identity is not None:
                facts.append((when, rec.ProcessClone(event.created_thread_group_id, event.created_thread_group_start_time_ns, event.thread_group_id, event.thread_group_start_time_ns, when)))  # type: ignore[arg-type]
            case ProcessEventKind.EXEC | ProcessEventKind.CONTAINER_START:
                facts.append((when, rec.ProcessExec(event.thread_group_id, event.thread_group_start_time_ns, list(event.argv), event.cwd, when, launch_ids.get(event.identity))))
            case ProcessEventKind.TASK_EXIT if event.thread_id == event.thread_group_id:
                facts.append((when, _exit_fact(event, when)))
    facts.sort(key=lambda pair: pair[0])
    return [fact for _, fact in facts], [when for when, _ in facts]


def _exit_fact(event: ProcessEvent, when: int) -> rec.ProcessExit:
    if event.exit_signal is not None:
        return rec.ProcessExit(event.thread_group_id, event.thread_group_start_time_ns, when, signal=event.exit_signal)
    return rec.ProcessExit(event.thread_group_id, event.thread_group_start_time_ns, when, exit_code=event.exit_code or 0)


NUMERIC_LIMITS = (
    "wall_time_ms", "max_model_calls", "max_output_tokens_per_call", "max_cost_usd", "cpus", "memory_mb", "pids", "workspace_bytes", "workspace_files",
    "tmp_bytes", "build_wall_ms", "build_memory_mb", "build_output_bytes", "build_files", "build_tmp_bytes",
)
POLICIES = ("coding", "task_tools")


class UnsupportedPolicy(RuntimeError):
    """A claimed run pins a participant policy this worker does not know."""


class UnsupportedLimits(RuntimeError):
    """A claimed run asks for more than the worker advertised it can give."""


def check_limits(limits: Mapping[str, Any], capabilities: Mapping[str, Any]) -> None:
    """Raise [UnsupportedLimits] when ``limits`` exceed what ``capabilities`` advertises."""
    over = [f"{name} {limits[name]} > {capabilities[name]}" for name in NUMERIC_LIMITS if limits[name] > capabilities[name]]
    if limits["internet_access"] and not capabilities["internet_access"]:
        over.append("internet_access is not supported")
    if over:
        raise UnsupportedLimits("the run's limits exceed this worker's capabilities: " + "; ".join(over))


def case_limits(limits: Mapping[str, Any], worker: Limits) -> Limits:
    """The sandbox bounds of one attempt: the run's limits, and the worker's own for captured output."""
    return replace(
        worker, cpus=float(limits["cpus"]), memory_bytes=limits["memory_mb"] << 20, pids=limits["pids"], workspace_bytes=limits["workspace_bytes"],
        workspace_files=limits["workspace_files"], tmp_bytes=limits["tmp_bytes"], wall_s=limits["wall_time_ms"] / 1000,
    )


class AttemptRunner:
    def __init__(
        self,
        config: RunnerConfig,
        *,
        supervisor: Supervisor,
        worker: RushWorkerClient,
        relay: ServiceRelay,
        plugins: Plugins,
        clock_ns: Callable[[], int] = time.monotonic_ns,
        wall_clock_ns: Callable[[], int] = time.time_ns,
        services_factory: Callable[..., AttemptServices] = AttemptServices,
        verify_task_case: Callable[..., Any] = verify_task_verifier_case,
        project: Callable[[list[dict[str, Any]], Mapping[str, bytes], Mapping[str, str]], Any] = default_project,
    ) -> None:
        self.config = config
        self.supervisor = supervisor
        self.worker = worker
        self.relay = relay
        self.plugins = plugins
        self.clock_ns = clock_ns
        self.wall_clock_ns = wall_clock_ns
        self.services_factory = services_factory
        self.verify_task_case = verify_task_case
        self.project = project

    # -- attempts ------------------------------------------------------------------------------------------------

    async def run(self, job: AttemptJob) -> AttemptResult:
        lease = Lease(job.attempt_id, job.fence, lease_s=job.lease_seconds, clock_ns=self.clock_ns, wall_clock_ns=self.wall_clock_ns)
        journal = RushJournal(self.worker, lease)
        work = self.config.scratch / job.attempt_id
        work.mkdir(parents=True, exist_ok=True)
        try:
            async with anyio.create_task_group() as renewing:
                renewing.start_soon(self._renew, job, lease)
                try:
                    result = await self._attempt(job, lease, journal, Emitter(journal, self.clock_ns), work)
                except (LeaseLost, Canceled) as error:
                    lease.fail(error)
                    result = AttemptResult("lease_lost" if isinstance(error, LeaseLost) else "canceled")
                except Sealed:
                    result = AttemptResult("sealed")
                except Exception as error:  # a fault of the platform, not of the member's harness: it ends this attempt only
                    LOG.exception("attempt %s: platform fault, the attempt is left to expire as interrupted", job.attempt_id)
                    result = AttemptResult("platform_fault", {"error": f"{type(error).__name__}: {error}"})
                finally:
                    renewing.cancel_scope.cancel()  # a finished, lost or failed attempt stops renewing its lease
        finally:
            journal.close()
            shutil.rmtree(work, ignore_errors=True)
        return replace(result, accounting=pending_calls(journal.records))

    async def _renew(self, job: AttemptJob, lease: Lease) -> None:
        """Renew the lease every `renew_interval_s` until it is lost or the attempt ends. A renewal that cannot reach the
        server is retried at the next interval; the lease stays usable only until its known expiry, then it is failed."""
        while True:
            wait = self.config.renew_interval_s
            if lease.valid_until_ns is not None:
                wait = min(wait, max((lease.valid_until_ns - self.clock_ns()) / 1e9, 0.0))
            await anyio.sleep(wait)
            if lease.lapsed():
                return
            requested = self.clock_ns()
            try:
                seconds = await self.worker.renew(job.attempt_id, job.fence)
            except (LeaseLost, Canceled, Sealed) as error:
                lease.fail(error)
                return
            except RushUnavailable as error:
                LOG.warning("attempt %s: lease renewal failed: %s", job.attempt_id, error)
                if lease.lapsed():
                    return
                continue
            lease.extend(seconds, requested)

    async def _attempt(self, job: AttemptJob, lease: Lease, journal: RushJournal, emit: Emitter, work: Path) -> AttemptResult:
        cfg = self.config
        if cfg.renew_interval_s >= job.lease_seconds:
            raise RenewalConfigError(f"poll.renew_interval_s ({cfg.renew_interval_s:g}) must be shorter than the server's lease ({job.lease_seconds:g} s)")
        run = job.run
        policy, limits = run["policy"], run["limits"]
        if policy not in POLICIES:
            raise UnsupportedPolicy(f"the run's policy {policy!r} is not one of {POLICIES}")
        check_limits(limits, cfg.capabilities)
        source = await self.worker.source(job.attempt_id, job.fence)
        package = await self.worker.package(job.attempt_id, job.fence)
        if (ended := await self._ended(job, lease, journal)) is not None:
            return ended
        rejection: ContractError | None = None
        archive = None
        try:
            archive = inspect_zip(source, cfg.source_limits)
        except ContractError as error:
            rejection = error
        tools = self._tools(job)
        await emit.emit(
            rec.AttemptStarted(
                job.attempt_id, cfg.worker_id, {"label": cfg.endpoint.label, "mode": cfg.endpoint.mode}, run["model"], list(run["dialects"]),
                job.prompt["sha256"], policy, None if archive is None else archive.manifest.toolchain, run["source_sha256"], cfg.harness_revision,
                dict(limits), list(job.task["egress_hosts"]) if policy == "task_tools" else None,
                {"reference_tokens_per_second": cfg.reference_tokens_per_second, "clock_tolerance_ns": cfg.clock_tolerance_ns},
                [*EXPECTED_SOURCES, *(["tool_broker"] if tools else [])],
            )
        )
        if archive is None:
            assert rejection is not None
            return await self._finalize(job, journal, "build_failed", rejection.code)
        try:
            profile = toolchain(archive.manifest.toolchain)
            artifact = await in_thread(self._build, job, archive, profile, work)
        except ContractError as error:
            # The build is not part of the trace or the metrics; the worker log keeps its message, the attempt its code.
            LOG.warning("build of %s failed: %s: %s", job.attempt_id, error.code, error.message)
            return await self._finalize(job, journal, "build_failed", error.code)
        if (ended := await self._ended(job, lease, journal)) is not None:  # the build is a thread nothing can interrupt, so a cancel is seen after it
            return ended
        manifest = await in_thread(self.plugins.load, package, job.plugin["sha256"], job.plugin["id"], work / "plugin")
        if tools:
            await in_thread(self.supervisor.prepare_plugin, manifest.root, cfg.plugin_sync_timeout_s)
        if (ended := await self._ended(job, lease, journal)) is not None:
            return ended
        async with AsyncExitStack() as stack:
            return await self._case(job, lease, journal, emit, work, archive.manifest.run_argv, profile, artifact, manifest, tools, stack)

    async def _ended(self, job: AttemptJob, lease: Lease, journal: RushJournal) -> AttemptResult | None:
        """The result of an attempt whose lease was lost or canceled while it was preparing, before any case ran: canceled is
        finalized as such, as a cancel during the case is; a lost lease finalizes nothing. None while the lease holds."""
        if not lease.lapsed():
            return None
        if lease.reason == "canceled":
            return await self._finalize(job, journal, "canceled", None, result=AttemptResult("canceled"))
        return AttemptResult("lease_lost")

    @staticmethod
    def _tools(job: AttemptJob) -> tuple[Mapping[str, Any], ...]:
        """The plugin tools the attempt may call: the task's, under the task tools policy; none under the coding policy."""
        return tuple(job.task["tools"]) if job.run["policy"] == "task_tools" else ()

    def _build(self, job: AttemptJob, archive: Any, profile: ToolchainProfile, work: Path) -> BuildArtifact:
        source_root = work / "source"
        source_root.mkdir()
        extract(archive, source_root)
        closure = resolve_dependencies(
            profile, source_root, archive.manifest.lockfiles, work / "deps", index_url=self.config.index_urls.get(profile.id),
            timeout_s=job.run["limits"]["build_wall_ms"] / 1000,
        )
        run_limits = job.run["limits"]
        # The build's output volume is a tmpfs charged to the build's memory, so the build has bounds of its own.
        limits = replace(
            case_limits(run_limits, self.config.limits), memory_bytes=run_limits["build_memory_mb"] << 20, workspace_bytes=run_limits["build_output_bytes"],
            workspace_files=run_limits["build_files"], tmp_bytes=run_limits["build_tmp_bytes"], wall_s=run_limits["build_wall_ms"] / 1000,
        )
        return self.supervisor.build(BuildSpec(job.attempt_id, profile, archive.manifest, source_root, closure, work / "build", limits))

    async def _case(
        self,
        job: AttemptJob,
        lease: Lease,
        journal: RushJournal,
        emit: Emitter,
        work: Path,
        run_argv: tuple[str, ...],
        profile: ToolchainProfile,
        artifact: BuildArtifact,
        manifest: PluginManifest,
        tools: tuple[Mapping[str, Any], ...],
        stack: AsyncExitStack,
    ) -> AttemptResult:
        cfg, run = self.config, job.run
        run_limits = run["limits"]
        model = run["model"]
        if model not in cfg.prices:
            raise UnknownModelPrice(f"the worker's prices have no entry for {model!r}")
        input_price, output_price = cfg.prices[model]
        # Only the harness container may have the internet; the tool container and the build never do.
        network = await in_thread(lambda: self.supervisor.create_network(job.attempt_id, internet=run_limits["internet_access"]))
        stack.push_async_callback(shielded, lambda: in_thread(network.remove))
        workspace = Path(WORKSPACE)  # the case workspace, at the path the harness and the tool container both see
        runner: Any = NoTools()
        tool_container = None
        names = tuple(tool["name"] for tool in tools)
        if tools:
            name = f"rush-tool-{job.attempt_id}-{secrets.token_hex(4)}"
            runner = self.plugins.tool_runner(manifest, workspace, names, self.supervisor.tool_launcher(name))
            tool_container = ToolContainerSpec(name, manifest.root, None, tuple(job.task["egress_hosts"]))
        token = secrets.token_urlsafe(32)
        policy = AttemptPolicy(
            attempt_id=job.attempt_id, token=token, model=model, dialects=tuple(run["dialects"]), prompt_user=job.prompt["user"],
            prompt_system=job.prompt["system"], max_model_calls=run_limits["max_model_calls"],
            max_output_tokens_per_call=run_limits["max_output_tokens_per_call"], input_price_bound=input_price, output_price_bound=output_price,
            tools=tuple(ToolPolicy(tool["name"], bool(tool["writes"]), tool["input_schema"], tool["output_schema"]) for tool in tools),
        )
        limits = case_limits(run_limits, cfg.limits)
        commands = CaseCommands(limits)
        services = self.services_factory(
            policy=policy, endpoint=cfg.endpoint, admission=RushAdmission(self.worker, lease), journal=journal, tool_runner=runner,
            command_runner=commands, workspace=workspace, clock_ns=self.clock_ns,
        )
        services.attempt.lease_lapsed = lease.lapsed  # the services refuse new work once the lease's known expiry passes
        relay = await self.relay.start(job.attempt_id, network, services.app, work)
        stack.push_async_callback(shielded, relay.aclose)
        request = self._request(job, tools, relay.base_url)
        spec = CaseSpec(job.attempt_id, profile, run_argv, artifact, json.dumps(request).encode(), token, network, work / "case", None, limits, tool_container)
        offset = self.wall_clock_ns() - self.clock_ns()
        handle = await in_thread(self.supervisor.create_case, spec)
        stack.push_async_callback(shielded, lambda: in_thread(handle.close))
        stack.push_async_callback(shielded, lambda: self._revoke(services))  # a fault after this leaves no in-flight call or tool behind
        if tools:
            await stack.enter_async_context(runner)  # the plugin is up before the harness can call it
        await in_thread(handle.launch)
        commands.handle = handle
        await emit.emit(rec.CaseLaunched(handle.container_id, self.clock_ns(), list(run_argv)))

        recorded: list[bool] = []  # set once the collector's process evidence is committed
        try:
            outcome = await self._wait(lease, handle, services)
            await self._revoke(services)
            lease.lapsed()  # a lease that ran out while the computer slept is dropped on waking, not finalized late
            if lease.reason in ("lease_lost", "sealed"):
                return AttemptResult("lease_lost")
            if outcome is not None:  # a canceled attempt has no observed exit
                await emit.emit(rec.CaseExited(termination_wire(outcome.termination), int(outcome.exited_at * NS)), occurred_ns=int(outcome.exited_at * NS))
            # Quiescence (no call or tool left in flight) is reached after the exit, so it is recorded after it.
            await emit.emit(rec.CaseQuiesced(self.clock_ns()))
            if outcome is None:  # the attempt was canceled mid-run
                await in_thread(handle.close)
                return await self._finalize(job, journal, "canceled", None, result=AttemptResult("canceled"))
            try:
                snapshot = await in_thread(handle.stop_and_drain)
            except SandboxError as error:
                if error.code != "snapshot_too_large":
                    raise
                snapshot = None  # the harness left more than the workspace bound: a failed case, not a platform fault
                LOG.info("attempt %s: %s", job.attempt_id, error.message)
            if snapshot is not None:
                await self._record_snapshot(journal, emit, snapshot)
            if counters := handle.cpu_counters():  # empty when a container's cgroup was unreadable: CPU stays Unknown
                await emit.emit(rec.CpuCounters(counters))
            if snapshot is None:
                status, case_outcome = "execution_failed", {"status": "execution_failed", "reason": "invalid_result"}
                frozen = work / "overflow"  # the verifier gets an empty workspace: nothing was frozen
                frozen.mkdir()
            else:
                status, case_outcome = await self._read_outcome(handle, outcome.termination, job, snapshot.directory, snapshot.skipped)
                frozen = snapshot.directory
            evidence = await in_thread(handle.evidence)
            await self._record_processes(emit, evidence, lambda wall: wall - offset, commands.outcomes)
            recorded.append(True)
            await emit.emit(rec.ResultRead(case_outcome))
            verdict = await self._verify(manifest, job, case_outcome, frozen, evidence)
            reason = case_outcome.get("reason") if status == "execution_failed" else None
            return await self._finalize(job, journal, status, reason, verdict=verdict)
        except (LeaseLost, Canceled, Sealed):
            raise
        except Exception:
            if not recorded:
                await self._record_fault_evidence(emit, handle, lambda wall: wall - offset, commands.outcomes)
            raise

    async def _record_fault_evidence(self, emit: Emitter, handle: CaseHandle, to_monotonic_ns: Callable[[int], int], commands: Sequence[ExecOutcome]) -> None:
        """After a platform fault: stop the case and commit the process evidence the collector has, so the interrupted
        attempt keeps it. A failure here is logged and does not replace the fault being handled."""
        try:
            await in_thread(handle.close)
            await self._record_processes(emit, await in_thread(handle.evidence), to_monotonic_ns, commands)
        except Exception:
            LOG.exception("the process evidence of the faulted case could not be recorded")

    def _request(self, job: AttemptJob, tools: Sequence[Mapping[str, Any]], base: str) -> dict[str, Any]:
        run, task, case = job.run, job.task, job.case
        request = {
            "protocol": "rush.harness.v1",
            "attempt_id": job.attempt_id,
            "policy": run["policy"],
            "task": {key: task[key] for key in ("id", "kind", "description", "instructions", "plugin_name")},
            "case": {key: case[key] for key in ("case_id", "arguments", "context", "input_schema", "output_schema")},
            "prompt": {key: job.prompt[key] for key in ("system", "user", "sha256")},
            "workspace": WORKSPACE,
            "openrouter": {"base_url": f"{base}/api/v1", "model": run["model"], "dialects": list(run["dialects"])},
            "tools": {
                "url": f"{base}/tools",
                "available": [{key: tool[key] for key in ("name", "description", "input_schema", "output_schema")} for tool in tools],
            },
            "exec_url": f"{base}/exec",
            "events_url": f"{base}/events",
            "limits": dict(run["limits"]),
        }
        validate("Request", request)
        return request

    async def _wait(self, lease: Lease, handle: CaseHandle, services: AttemptServices) -> Any:
        """The case's outcome, or None if the lease was lost or canceled first (the case is killed and drained)."""
        done = anyio.Event()
        box: list[Any] = []

        async def waiter() -> None:
            # Abandoned when the attempt is cancelled, so its cleanup can close the case (which ends wait()) instead of waiting
            # out the harness's wall time.
            try:
                box.append(await anyio.to_thread.run_sync(handle.wait, abandon_on_cancel=True))
            except SandboxError as error:
                if error.code != "closed":  # closed by the revoke below: the attempt is canceled, not faulted
                    raise
            done.set()

        async with anyio.create_task_group() as group:
            group.start_soon(waiter)
            await first_of(done, lease.revoked)
            if not done.is_set():
                await self._revoke(services)
                await in_thread(handle.close)  # kills the sandbox, which ends wait()
                await done.wait()
            group.cancel_scope.cancel()
        return None if lease.revoked.is_set() else box[0]

    async def _revoke(self, services: AttemptServices) -> None:
        """Reject new calls, stop in-flight model streams, tools and commands, and wait for the calls to settle."""
        await services.revoke(self.config.drain_timeout_s)

    async def _record_snapshot(self, journal: RushJournal, emit: Emitter, snapshot: Any) -> None:
        diff = []
        for change, paths in (("added", snapshot.added), ("modified", snapshot.modified), ("deleted", snapshot.deleted)):
            for path in paths:
                entry: dict[str, Any] = {"path": path, "change": change}
                if change != "deleted":
                    entry |= {"sha256": snapshot.files[path], "size": (snapshot.directory / path).stat().st_size}
                diff.append(entry)
        payload = await journal.put_payload(json.dumps({"files": dict(snapshot.files), "skipped": dict(snapshot.skipped), "diff": diff}, sort_keys=True).encode(), "clean")
        # The whole diff is in the payload; the event keeps what fits, as at the file limit it would outgrow an event (RUSH refuses
        # data past 256 KiB).
        shown, size = [], 0
        for entry in diff:
            size += len(json.dumps(entry))
            if size > SNAPSHOT_EVENT_DIFF_BYTES:
                break
            shown.append(entry)
        await emit.emit(rec.SnapshotTaken(shown, payload, diff_truncated=len(shown) < len(diff)), payloads=[payload])

    async def _read_outcome(self, handle: CaseHandle, termination: Termination, job: AttemptJob, workspace: Path, skipped: Mapping[str, str]) -> tuple[str, dict[str, Any]]:
        """The attempt's outcome. A harness that did not exit cleanly is an execution failure; otherwise the task tools policy
        reads `RUSH_RESULT` and the coding policy reads `answer.json` from the frozen workspace (`RUSH_RESULT` is ignored)."""

        def failed(reason: str) -> tuple[str, dict[str, Any]]:
            return "execution_failed", {"status": "execution_failed", "reason": reason}

        match termination.kind:
            case TerminationKind.TIMED_OUT:
                return failed("timed_out")
            case TerminationKind.SIGNALED:
                return failed("signaled")
            case TerminationKind.NONZERO_EXIT:
                return failed("nonzero_exit")
            case TerminationKind.EXITED if termination.exit_code:
                return failed("nonzero_exit")
        if job.run["policy"] == "coding":
            if "answer.json" in skipped:  # the snapshot never materializes links, which read_answer refuses as not a regular file
                LOG.info("attempt %s: answer.json is not a regular file (%s)", job.attempt_id, skipped["answer.json"])
                return failed("invalid_result")
            answer, refusal, failure = await in_thread(read_answer, workspace)
            if failure is not None:
                LOG.info("attempt %s: %s", job.attempt_id, failure)
                return failed("missing_result" if failure == MISSING_ANSWER else "invalid_result")
            if refusal is not None:
                return "refused", {"status": "refused", "reason": refusal}
            return "answered", {"status": "answered", "answer": answer}
        try:
            raw = await in_thread(handle.read_result)
            parsed = validate_result(raw, dict(job.case["output_schema"]))
        except ContractError as error:
            if error.code not in ("missing_result", "invalid_result", "snapshot_too_large"):
                raise
            return failed("invalid_result" if error.code == "snapshot_too_large" else error.code)
        match parsed:
            case Answered(answer):
                return "answered", {"status": "answered", "answer": answer}
            case Refused(reason):
                return "refused", {"status": "refused", "reason": reason}

    async def _record_processes(self, emit: Emitter, evidence: ProcessEvidence, to_monotonic_ns: Callable[[int], int], commands: Sequence[ExecOutcome]) -> None:
        await emit.emit(rec.CollectorHealth(evidence.complete, list(evidence.loss_reasons), evidence.frames, evidence.dropped))
        facts, times = process_facts(evidence, to_monotonic_ns, commands)
        await emit.emit_many(facts, times)

    async def _verify(
        self, manifest: PluginManifest, job: AttemptJob, outcome: dict[str, Any], workspace: Path, evidence: ProcessEvidence
    ) -> dict[str, Any] | None:
        """The plugin verifier's verdict on the frozen outcome, or None when the score stays unavailable."""
        if outcome["status"] == "execution_failed" and outcome["reason"] in ("nonzero_exit", "signaled") and not evidence.complete and set(evidence.loss_reasons) - {"journal_overflow"}:
            return None  # the exit could not be observed reliably; the harness's own overflow of the collector does not count, or it could unscore its crash
        try:
            verdict = await in_thread(
                self.verify_task_case, manifest, job.task["id"], dict(job.case["arguments"]), outcome, job.private_reference, workspace
            )
        except (VerifierError, ValueError) as error:
            LOG.warning("verifier of %s: %s", job.attempt_id, error)
            # Private: the verifier's diagnostics stay in the worker log; the attempt only learns that it errored.
            # The server takes a verifier error only on an answered or refused attempt; elsewhere the case stays unscored.
            return {"verifier_error": "verifier_error"} if outcome["status"] in ("answered", "refused") else None
        return {"verdict": verdict.verdict, "explanation": verdict.explanation}

    async def _trace(self, job: AttemptJob, journal: RushJournal, status: str) -> tuple[dict[str, Any], dict[str, Any]]:
        """Projects the journal, uploads its spans and returns the coverage and metrics to finalize with. A projection or span upload
        that fails (a refused request, a malformed harness value) leaves the trace unavailable but never the verdict unsent;
        a lost lease, a cancel, a seal or an unreachable RUSH still end the attempt."""
        try:
            projection = self.project(list(journal.records), dict(journal.payloads), dict(journal.redactions))
            for request in projection.spans_requests(job.fence):
                await self.worker.spans(job.attempt_id, request)
        except (LeaseLost, Canceled, Sealed, RushUnavailable):
            raise
        except Exception as error:
            LOG.exception("attempt %s: the trace is unavailable, the attempt is finalized without it", job.attempt_id)
            reason = f"trace_unavailable: {type(error).__name__}"
            coverage = {"status": "partial", "reasons": [reason], "expected_sources": [], "observed_sources": [], "missing_sources": [], "collector_complete": None,
                        "loss_reasons": [], "truncated": [], "redacted": [], "rejected": []}  # fmt: skip
            return coverage, {"usage_complete": False, "timing_unavailable": reason}
        coverage = projection.coverage.to_dict()
        if journal.over_budget:  # evidence past the event budget was never journaled: the trace is partial, and says why
            coverage |= {"status": "partial", "reasons": [*coverage["reasons"], f"event_budget_exceeded: {journal.over_budget} events dropped"],
                         "loss_reasons": [*coverage["loss_reasons"], "event_budget"]}  # fmt: skip
        return coverage, projection.metrics.to_dict("the source did not build, so no case ran" if status == "build_failed" else None)

    async def _finalize(
        self, job: AttemptJob, journal: RushJournal, status: str, reason: str | None, *, verdict: Mapping[str, Any] | None = None,
        result: AttemptResult | None = None,
    ) -> AttemptResult:
        coverage, metrics = await self._trace(job, journal, status)
        body: dict[str, Any] = {
            "fence": job.fence,
            "execution": {"status": status, "reason": reason},
            "verdict": None,
            "explanation": None,
            "verifier_error": None,
            "coverage": coverage,
            "metrics": metrics,
            "final_cursor_expected": journal.high_water,
        }
        if verdict is not None:
            body |= {key: verdict.get(key) for key in ("verdict", "explanation", "verifier_error")}
        await self.worker.finalize(job.attempt_id, body)
        journal.close()
        return result or AttemptResult("finalized", {"status": status, "reason": reason})
