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
   plugin verifier on the frozen outcome, project the evidence, upload spans and links and finalize. A free-form Terminal
   session (``free_form``: its member runs any agent and prompts it themselves) has no case: it reads no result, runs no verifier and
   finalizes `ended`, keeping its model calls, commands and snapshot. Its workspace, which holds the agent CLIs' state, is kept on
   this computer to resume (nanoagent.uploaded.resume), however it ended, and a session that resumes one gets it back before its
   shell starts.

Faults of the platform itself (a sandbox that will not start, a plugin that will not install, a tool container that fails
to launch) are logged and end only that attempt: its services are revoked, its sandbox and network removed, the process
evidence the collector has is committed, and renewal stops, so the attempt expires as interrupted with its score
unavailable. The worker goes on to its next job.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import platform
import secrets
import shutil
import threading
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import AsyncExitStack
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from decimal import Decimal
from functools import partial
from pathlib import Path
from typing import Any, Protocol

import anyio
import anyio.to_thread

from nanoagent import __version__
from nanoagent.plugin.manifest import PluginManifest, load_manifest
from nanoagent.plugin.tasks import tools_prompt
from nanoagent.plugin.verifier import VerifierError, verify_task_verifier_case
from nanoagent.uploaded import records as rec
from nanoagent.uploaded.answer import read_answer
from nanoagent.uploaded.app import AttemptServices
from nanoagent.uploaded.attempt import AttemptPolicy, ServiceError, ToolPolicy
from nanoagent.uploaded.broker import PluginToolRunner, ToolError
from nanoagent.uploaded.clis import CLIS, Cli
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
    CaseFailed,
    Emitter,
    Lease,
    LeaseLost,
    RushAdmission,
    RushError,
    RushJournal,
    RushUnavailable,
    RushWorkerClient,
    Sealed,
)
from nanoagent.uploaded.sandbox import (
    AttemptNetwork,
    BuildArtifact,
    CLIS_DIR,
    PLUGIN_PREP_IMAGE,
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
from nanoagent.uploaded.reference import build_reference
from nanoagent.uploaded.resume import keep, restore, start_cli
from nanoagent.uploaded import session_result
from nanoagent.uploaded.source import SourceLimits, extract, inspect_zip
from nanoagent.uploaded.terminal import MAX_TERMINALS, Terminal
from nanoagent.uploaded.toolchains import CLOSURE_ARCHIVE, ToolchainProfile, resolve_dependencies, toolchain

LOG = logging.getLogger(__name__)
NS = 1_000_000_000
EXPECTED_SOURCES = ("worker", "gateway", "process")
EXEC_THREADS = 4  # concurrent managed commands per attempt
MISSING_ANSWER = "wrote no answer.json"  # read_answer's failure for an absent file
SNAPSHOT_EVENT_DIFF_BYTES = 128 * 1024  # of the diff a snapshot.taken event carries; the snapshot payload has all of it
BUILDS = "builds"  # under the scratch folder: each source's built harness, kept for the next attempt of it
CLIS_FOLDER = "clis"  # under the scratch folder: the terminal's CLI installs (nanoagent.uploaded.clis), mounted into every case
DOWNLOADS_FOLDER = "downloads"  # under the scratch folder: every build's checked downloads, by lock hash (toolchains.cached_fetch)
PLUGINS = "plugins"  # under the scratch folder: each plugin package a tooled attempt ran, unpacked with its environment synced
PREPARED = "prepared"  # beside a kept plugin's folder: written last, once its environment is synced
BUILT = "built.json"  # beside a kept build's harness/: its outputs and digest, written last


class Supervisor(Protocol):
    """The part of the sandbox supervisor the runner uses."""

    def create_network(self, attempt_id: str, *, internet: bool = False) -> AttemptNetwork: ...

    def ready(self, profile: ToolchainProfile) -> None: ...

    def build(self, spec: BuildSpec) -> BuildArtifact: ...

    def create_case(self, spec: CaseSpec) -> CaseHandle: ...

    def prepare_plugin(self, root: Path, timeout_s: float) -> None: ...

    def attach_tool(self, case: Any, tool: ToolContainerSpec) -> None: ...

    def tool_launcher(self, name: str) -> ToolLauncher: ...


class Plugins(Protocol):
    def load(self, data: bytes, sha256: str, plugin_id: str, folder: Path) -> PluginManifest:
        """Unpack and verify a plugin package (blocking)."""

    def unpacked(self, root: Path) -> PluginManifest:
        """The manifest of a plugin unpacked earlier at ``root``."""

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

    def unpacked(self, root: Path) -> PluginManifest:
        return load_manifest(root)

    def tool_runner(self, manifest: PluginManifest, workspace: Path, permitted: tuple[str, ...], launcher: ToolLauncher) -> PluginToolRunner:
        return PluginToolRunner(manifest, workspace, permitted, launcher=launcher)


WARM_GO = json.dumps({"wait_go": True}).encode()  # a warm terminal's request until a session hands it its own (`CaseHandle.go`)
WARM_RECIPE = "warm.json"  # under the scratch folder: the last Terminal session's limits, the warm terminal's after a start
WARM_MAX_AGE_S = 600.0  # a warm terminal nobody took is replaced after this, well within any session's wall time
SCORE_POLL_S = 2.0  # how often `rush score` reads how its run is going


class LateApp:
    """The ASGI app a warm terminal's relay serves before any session has it: 503 until `app` is the session's, whose `close` runs
    when the relay shuts down (Starlette's lifespan would, served directly)."""

    def __init__(self) -> None:
        self.app: Any = None
        self.close: Callable[[], Awaitable[None]] | None = None

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    if self.close is not None:
                        await self.close()
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if self.app is None:
            await send({"type": "http.response.start", "status": 503, "headers": [(b"content-type", b"text/plain")]})
            await send({"type": "http.response.body", "body": b"no session has this terminal yet"})
            return
        await self.app(scope, receive, send)


class HeldOutput:
    """A warm terminal's output: held until a session takes the terminal (`forward`), then passed on as it comes."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._held = bytearray()
        self._to: Callable[[bytes], None] | None = None

    def write(self, data: bytes) -> None:
        with self._lock:
            if self._to is None:
                self._held += data
                return
        self._to(data)

    def forward(self, to: Callable[[bytes], None]) -> None:
        with self._lock:
            to(bytes(self._held))
            self._held.clear()
            self._to = to


@dataclass(frozen=True)
class WarmRecipe:
    """What a Terminal session's case is made of, so the next one can be ready before it is claimed: `key` must match it."""

    key: tuple[Any, ...]
    run_limits: Mapping[str, Any]
    profile: ToolchainProfile
    run_argv: tuple[str, ...]
    artifact: BuildArtifact
    limits: Limits
    internet: bool


@dataclass
class WarmTerminal:
    """A Terminal session's case booted and its shell launched waiting for a session (`WARM_GO`), with its relay up."""

    recipe: WarmRecipe
    network: AttemptNetwork
    app: LateApp
    relay: Any
    output: HeldOutput
    handle: CaseHandle
    folder: Path
    born: float
    taken: anyio.Event = field(default_factory=anyio.Event)


class LateTools:
    """A Terminal session's plugin tools, which its shell starts without: started the first time its `nanoagent` asks
    (`/tools/start`, `AttemptRunner._late_tools`) and kept up until the session ends; what started them answers every ask after."""

    def __init__(self) -> None:
        self.asked = anyio.Event()
        self.up = anyio.Event()
        self.started: Mapping[str, Any] | None = None  # {token, system, tools}
        self.error = "the session ended before its tools came up"

    async def start(self) -> Mapping[str, Any]:
        self.asked.set()
        await self.up.wait()
        if self.started is None:
            raise ServiceError(503, "tools_unavailable", f"the plugin's tools could not start: {self.error}")
        return self.started


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
    resume_bytes: int = 4 << 30  # the Terminal sessions kept on this computer to resume, in all (nanoagent.uploaded.resume)


@dataclass(frozen=True)
class AttemptResult:
    """How the attempt ended: `finalized`, `canceled` (finalized as such), `lease_lost` (nothing finalized), `sealed`, or
    `platform_fault` (nothing finalized: the attempt expires as interrupted)."""

    outcome: str
    execution: Mapping[str, Any] | None = None
    accounting: Sequence[PendingCall] = ()


class PendingCase:
    """A session's case RUSH is still pinning as its attempt is claimed: fetched while the attempt prepares, then the job with it, or
    why it could not be pinned."""

    def __init__(self) -> None:
        self.done = anyio.Event()
        self.job: AttemptJob | None = None
        self.error: str | None = None

    def failed_reason(self) -> str:
        """The execution reason of an attempt whose case could not be pinned, with why (RUSH keeps 200 characters)."""
        return f"case_failed: {self.error}"[:200]


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


def tree_bytes(folder: Path) -> int:
    """The bytes of the regular files under ``folder``, links not followed."""
    return sum(entry.stat().st_size for entry in folder.rglob("*") if entry.is_file() and not entry.is_symlink())


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
        self._recipe: WarmRecipe | None = None  # the last Terminal session's, which the warm terminal is made of
        self._rewarm = anyio.Event()  # set when the recipe changes or the warm terminal is taken
        self._warm: WarmTerminal | None = None
        self._installs: dict[str, tuple[asyncio.Future[None], Path]] = {}  # each CLI install in flight, by key, and its scratch
        self._preinstall: asyncio.Future[None] | None = None

    # -- the warm terminal ---------------------------------------------------------------------------------------

    async def keep_warm(self) -> None:
        """Keep one Terminal session's case booted with its shell waiting, made as the last Terminal session's was, so the next
        one is handed it on claim (`_take_warm`) and its prompt shows at once; replaced when taken, when the recipe changes, and
        after WARM_MAX_AGE_S unused. Runs for the worker's life; the first Terminal session after a start finds none."""
        saved = self.config.scratch / WARM_RECIPE
        if saved.is_file():  # a session before this start left its limits: the first session after it finds a terminal warm too
            try:
                self._recipe = await in_thread(self._shell_recipe, json.loads(saved.read_text()))
                self._rewarm.set()
            except Exception:
                LOG.exception("the Terminal's build for a warm terminal at start failed")
        while True:
            await self._rewarm.wait()
            self._rewarm = anyio.Event()
            recipe = self._recipe
            assert recipe is not None
            try:
                warm = await self._boot_warm(recipe)
            except Exception:
                LOG.exception("the warm terminal could not start")
                await anyio.sleep(30)
                self._rewarm.set()
                continue
            self._warm = warm
            LOG.info("warm terminal ready: %s", warm.handle.container_id)
            if self._preinstall is None:
                self._preinstall = asyncio.ensure_future(self._install_clis(recipe.run_limits))
            with anyio.move_on_after(WARM_MAX_AGE_S):
                await first_of(warm.taken, self._rewarm)
            if not warm.taken.is_set():
                self._warm = None
                await self._discard(warm)
                self._rewarm.set()

    async def _boot_warm(self, recipe: WarmRecipe) -> WarmTerminal:
        name = f"warm-{uuid.uuid4().hex[:12]}"
        folder = self.config.scratch / name
        folder.mkdir(parents=True)
        network = self.supervisor.create_network(name, internet=recipe.internet)
        app = LateApp()
        relay = await self.relay.start(name, network, app, folder)
        output = HeldOutput()
        clis = self.config.scratch / CLIS_FOLDER
        clis.mkdir(parents=True, exist_ok=True)
        spec = CaseSpec(name, recipe.profile, recipe.run_argv, recipe.artifact, WARM_GO, "", network, folder / "case", None, recipe.limits, None, output.write, clis)
        try:
            handle = await in_thread(self.supervisor.create_case, spec)
        except BaseException:
            await shielded(relay.aclose)
            shutil.rmtree(folder, ignore_errors=True)
            raise
        warm = WarmTerminal(recipe, network, app, relay, output, handle, folder, self.clock_ns() / NS)
        try:
            await in_thread(handle.launch)
        except BaseException:
            await self._discard(warm)
            raise
        return warm

    async def _discard(self, warm: WarmTerminal) -> None:
        await shielded(lambda: in_thread(warm.handle.close))
        await shielded(warm.relay.aclose)
        shutil.rmtree(warm.folder, ignore_errors=True)

    def _shell_recipe(self, run_limits: Mapping[str, Any]) -> WarmRecipe:
        """The recipe of a Terminal session under ``run_limits``: the shell this worker's NanoAgent builds (`build_reference`, as
        the member's computer does for a session), kept like any build, or built now."""
        archive = inspect_zip(build_reference("shell"), self.config.source_limits)
        profile = toolchain(archive.manifest.toolchain)
        self.supervisor.ready(profile)
        work = self.config.scratch / f"warm-build-{uuid.uuid4().hex[:8]}"
        work.mkdir(parents=True)
        try:
            artifact = self._build("warm-build", run_limits, archive, profile, work)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return self._recipe_of(archive.source_sha256, profile, archive.manifest.run_argv, artifact, run_limits)

    def _recipe_of(
        self, source_sha256: str, profile: ToolchainProfile, run_argv: tuple[str, ...], artifact: BuildArtifact, run_limits: Mapping[str, Any],
    ) -> WarmRecipe:
        limits = case_limits(run_limits, self.config.limits)
        internet = run_limits["internet_access"]
        return WarmRecipe((source_sha256, profile.id, str(artifact.directory), limits, internet), dict(run_limits), profile, tuple(run_argv), artifact, limits, internet)

    def _take_warm(self, recipe: WarmRecipe) -> WarmTerminal | None:
        """The warm terminal, when it is made as ``recipe`` says and still young; the next one starts warming either way."""
        warm = self._warm
        if self._recipe is None or self._recipe.key != recipe.key:
            self._recipe = recipe
            self._rewarm.set()
            (self.config.scratch / WARM_RECIPE).write_text(json.dumps(recipe.run_limits))
        if warm is None or warm.recipe.key != recipe.key or self.clock_ns() / NS - warm.born > WARM_MAX_AGE_S:
            return None
        self._warm = None
        warm.taken.set()
        self._rewarm.set()
        return warm

    # -- attempts ------------------------------------------------------------------------------------------------

    async def run(self, job: AttemptJob) -> AttemptResult:
        lease = Lease(job.attempt_id, job.fence, lease_s=job.lease_seconds, clock_ns=self.clock_ns, wall_clock_ns=self.wall_clock_ns)
        journal = RushJournal(self.worker, lease)
        work = self.config.scratch / job.attempt_id
        work.mkdir(parents=True, exist_ok=True)
        pending = PendingCase() if job.case_pending else None
        try:
            async with anyio.create_task_group() as renewing:
                renewing.start_soon(self._renew, job, lease)
                if pending is not None:
                    renewing.start_soon(self._fetch_case, job, lease, pending)
                try:
                    result = await self._attempt(job, lease, journal, Emitter(journal, self.clock_ns), work, pending)
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

    async def _watch(self, lease: Lease) -> None:
        """Fails ``lease`` as soon as RUSH says the session was canceled (its member left its page or opened another), its lease lost or
        it sealed, so the case is killed in well under a second rather than at the next renewal."""
        while True:
            try:
                await self.worker.watch(lease.attempt_id, lease.fence)
            except (Canceled, LeaseLost, Sealed) as error:
                lease.fail(error)
                return

    async def _fetch_case(self, job: AttemptJob, lease: Lease, pending: PendingCase) -> None:
        """Fetch the case RUSH pins while the attempt prepares and runs, until it is pinned, its pin fails, or the lease is lost."""
        while not lease.lapsed():
            try:
                body = await self.worker.case(job.attempt_id, job.fence)
            except CaseFailed as error:
                pending.error = error.message
                pending.done.set()
                return
            except (LeaseLost, Canceled, Sealed) as error:
                lease.fail(error)
                return
            except RushUnavailable as error:
                LOG.warning("attempt %s: reading its case failed: %s", job.attempt_id, error)
                continue
            if body is not None:
                pending.job = job.pinned(body)
                pending.done.set()
                return

    async def _attempt(self, job: AttemptJob, lease: Lease, journal: RushJournal, emit: Emitter, work: Path, pending: PendingCase | None) -> AttemptResult:
        cfg = self.config
        if cfg.renew_interval_s >= job.lease_seconds:
            raise RenewalConfigError(f"poll.renew_interval_s ({cfg.renew_interval_s:g}) must be shorter than the server's lease ({job.lease_seconds:g} s)")
        run = job.run
        policy, limits = run["policy"], run["limits"]
        if policy not in POLICIES:
            raise UnsupportedPolicy(f"the run's policy {policy!r} is not one of {POLICIES}")
        check_limits(limits, cfg.capabilities)
        source = await self.worker.source(job.attempt_id, job.fence)
        # A free-form Terminal session runs nothing of its plugin: RUSH keeps no package for it, and none is fetched or unpacked.
        package = None if job.free_form else await self.worker.package(job.attempt_id, job.fence)
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
                None if job.prompt is None else job.prompt["sha256"], policy, None if archive is None else archive.manifest.toolchain, run["source_sha256"], cfg.harness_revision,
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
        except ContractError as error:
            LOG.warning("build of %s failed: %s: %s", job.attempt_id, error.code, error.message)
            return await self._finalize(job, journal, "build_failed", error.code)
        await in_thread(self.supervisor.ready, profile)  # the tracer proven in its image, once: a failure is the platform's, not the source's
        try:
            artifact = await in_thread(self._build, job.attempt_id, run["limits"], archive, profile, work)
        except ContractError as error:
            # The build is not part of the trace or the metrics; the worker log keeps its message, the attempt its code.
            LOG.warning("build of %s failed: %s: %s", job.attempt_id, error.code, error.message)
            return await self._finalize(job, journal, "build_failed", error.code)
        if (ended := await self._ended(job, lease, journal)) is not None:  # the build is a thread nothing can interrupt, so a cancel is seen after it
            return ended
        LOG.info("attempt %s: harness built", job.attempt_id)  # with the worker log's times, these lines show where a session's start goes
        manifest = None
        if package is not None:
            manifest = await in_thread(self._plugin, job.plugin, package, work, bool(tools))
            LOG.info("attempt %s: plugin ready", job.attempt_id)
            if (ended := await self._ended(job, lease, journal)) is not None:
                return ended
        if pending is not None:  # the harness reads its case as it starts
            await first_of(pending.done, lease.revoked)
            if (ended := await self._ended(job, lease, journal)) is not None:
                return ended
            if pending.job is None:
                return await self._finalize(job, journal, "execution_failed", pending.failed_reason())
            job, pending = pending.job, None
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

    def _build(self, attempt_id: str, run_limits: Mapping[str, Any], archive: Any, profile: ToolchainProfile, work: Path) -> BuildArtifact:
        """The source's built harness: the one an earlier attempt built of the same source, build image and architecture, kept under
        the scratch folder's builds/ (read-only to every case, so one serves all), or built now and kept there."""
        builds = self.config.scratch / BUILDS
        key = hashlib.sha256(f"{archive.source_sha256}\0{profile.build_image}\0{platform.machine()}".encode()).hexdigest()[:32]
        kept = builds / key
        if (kept / BUILT).is_file():
            built = json.loads((kept / BUILT).read_text())
            return BuildArtifact(kept / "harness", tuple(built["outputs"]), built["digest"], b"", b"", 0.0)
        return self._keep(self._build_now(attempt_id, run_limits, archive, profile, work), kept)

    def _plugin(self, plugin: Mapping[str, Any], package: bytes, work: Path, tooled: bool) -> PluginManifest:
        """The attempt's plugin (``{id, sha256, ...}``). Without tools it is unpacked into the attempt's folder. With them it is the one
        an earlier attempt unpacked and synced (`prepare_plugin`) of the same package, prep image and architecture, kept under the scratch folder's
        plugins/ (read-only to every tool VM, so one serves all), or unpacked and synced now and kept there: a session's tools start
        without a `uv sync` once its plugin has run here."""
        sha256, plugin_id = plugin["sha256"], plugin["id"]
        if not tooled:
            return self.plugins.load(package, sha256, plugin_id, work / "plugin")
        kept = self.config.scratch / PLUGINS / hashlib.sha256(f"{sha256}\0{PLUGIN_PREP_IMAGE}\0{platform.machine()}".encode()).hexdigest()[:32]
        if not (kept / PREPARED).is_file():
            staging = kept.parent / f".{kept.name}-{uuid.uuid4().hex[:8]}"
            staging.mkdir(parents=True)
            try:
                manifest = self.plugins.load(package, sha256, plugin_id, staging)
                self.supervisor.prepare_plugin(manifest.root, self.config.plugin_sync_timeout_s)
                (staging / PREPARED).write_text(plugin_id)
                staging.rename(kept)
            except OSError:
                if not (kept / PREPARED).is_file():
                    raise
                # an attempt beside this one kept the same plugin first: theirs serves
            finally:
                shutil.rmtree(staging, ignore_errors=True)
        return self.plugins.unpacked(kept / plugin_id)

    @staticmethod
    def _keep(artifact: BuildArtifact, kept: Path) -> BuildArtifact:
        """Moves a fresh build to ``kept`` (its harness/, and BUILT written last), where later attempts find it."""
        staging = kept.parent / f".{kept.name}-{uuid.uuid4().hex[:8]}"
        staging.mkdir(parents=True)
        shutil.move(artifact.directory, staging / "harness")
        (staging / BUILT).write_text(json.dumps({"outputs": list(artifact.outputs), "digest": artifact.digest, "duration_s": artifact.duration_s}))
        try:
            staging.rename(kept)
        except OSError:  # an attempt beside this one kept the same build first: theirs serves
            shutil.rmtree(staging, ignore_errors=True)
        return replace(artifact, directory=kept / "harness")

    async def _install_clis(self, run_limits: Mapping[str, Any]) -> None:
        """Installs every terminal CLI not installed yet, one after another, so a session that types one finds it at once (or
        waits on the install already under way)."""
        for cli in CLIS.values():
            try:
                archive, profile, key = await in_thread(self._cli_source, cli)
                if not (self.config.scratch / CLIS_FOLDER / key / BUILT).is_file():
                    await self._cli_install(cli, archive, profile, key, run_limits)[0]
            except ContractError:
                pass  # logged by the install; a session that types it tries again
            except Exception:
                LOG.exception("installing %s ahead of a session failed", cli.label)

    def _cli_source(self, cli: Cli) -> tuple[Any, ToolchainProfile, str]:
        archive = inspect_zip(build_reference(cli.reference), self.config.source_limits)
        profile = toolchain(archive.manifest.toolchain)
        return archive, profile, cli.key(profile.build_image, archive.source_sha256)

    def _cli_install(self, cli: Cli, archive: Any, profile: ToolchainProfile, key: str, run_limits: Mapping[str, Any]) -> tuple[asyncio.Future[None], Path]:
        """The install of ``cli`` under ``key`` and its scratch: the one under way, or one started now that whoever asks next
        waits on too."""
        if key in self._installs:
            return self._installs[key]
        scratch = self.config.scratch / f"cli-{uuid.uuid4().hex[:8]}"
        scratch.mkdir(parents=True)
        kept = self.config.scratch / CLIS_FOLDER / key

        async def install() -> None:
            started = time.monotonic()
            try:
                await in_thread(lambda: self._keep(self._build_now(f"cli-{cli.name}", run_limits, archive, profile, scratch), kept))
                LOG.info("installed %s %s in %.1fs", cli.label, cli.version(), time.monotonic() - started)
            except ContractError as error:
                LOG.warning("installing %s %s failed after %.1fs: %s: %s", cli.label, cli.version(), time.monotonic() - started, error.code, error.message)
                raise
            finally:
                del self._installs[key]
                await in_thread(shutil.rmtree, scratch, True)

        self._installs[key] = (asyncio.ensure_future(install()), scratch)
        return self._installs[key]

    async def _install_cli(self, job: AttemptJob, name: str, expect: str | None) -> AsyncIterator[Mapping[str, Any]]:
        """Installs the terminal's CLI ``name`` (its reference harness, built as any harness is), once per lockfile: what the
        wrapper shows while it waits, then where the install is in the case VM, or why there is none."""
        cli = CLIS.get(name)
        if cli is None:
            yield {"error": f"{name} is not a CLI the terminal installs; they are {', '.join(CLIS)}"}
            return
        archive, profile, key = await in_thread(self._cli_source, cli)
        version = cli.version()
        if expect is not None and expect != key:
            yield {"error": f"this harness was saved with another {cli.label} than this RUSH Lab installs ({version}): save it again"}
            return
        kept = self.config.scratch / CLIS_FOLDER / key
        if not (kept / BUILT).is_file():
            yield {"installing": cli.label, "version": version}
            started = time.monotonic()
            install, scratch = self._cli_install(cli, archive, profile, key, job.run["limits"])
            staged = 0
            while not install.done():
                await asyncio.wait({install}, timeout=1)
                try:
                    staged = (scratch / "deps" / CLOSURE_ARCHIVE).stat().st_size  # the verified downloads so far, unpacked
                except FileNotFoundError:
                    pass  # not begun, or built and removed: the last size stands
                yield {"bytes": staged}
            try:
                install.result()
            except ContractError as error:
                yield {"error": f"installing {cli.label} {version} failed: {error.code}: {error.message}"}
                return
            yield {"installed": cli.label, "version": version, "bytes": await in_thread(tree_bytes, kept), "seconds": round(time.monotonic() - started)}
        yield {"path": f"{CLIS_DIR}/{key}/harness", "key": key}

    async def _score(self, job: AttemptJob, name: str) -> AsyncIterator[Mapping[str, Any]]:
        """`rush score <name>` in the Terminal session ``job``: the run RUSH starts of the member's harness ``name`` on the first task of
        the session's plugin, its state each time it changes, then its one-line result as `nanoagent harness` prints it, or why there is
        none."""
        try:
            started = await self.worker.score(job.attempt_id, job.fence, name)
            yield {"run_id": started["run"]["run_id"]}
            state = None
            while not (read := await self.worker.scored(job.attempt_id, job.fence, started["attempt_id"]))["attempt"]["sealed"]:
                if read["attempt"]["state"] != state:
                    state = read["attempt"]["state"]
                    yield {"state": state}
                await asyncio.sleep(SCORE_POLL_S)
        except RushError as error:
            yield {"error": error.message}
            return
        except RushUnavailable as error:
            yield {"error": f"RUSH could not be reached: {error}"}
            return
        attempt, metrics = read["attempt"], read["attempt"].get("metrics") or {}
        result = {
            "harness": name, "plugin": job.plugin["id"], "verdict": session_result.verdict(attempt), "cost_usd": read["totals"]["settled_usd"],
            "elapsed_s": None if metrics.get("elapsed_ms") is None else metrics["elapsed_ms"] / 1000,
            "input_tokens": metrics.get("input_tokens"), "output_tokens": metrics.get("output_tokens"),
        }  # fmt: skip
        yield {"line": session_result.summary_line(result), "explanation": attempt.get("explanation") or attempt.get("verifier_error")}

    def _build_now(self, attempt_id: str, run_limits: Mapping[str, Any], archive: Any, profile: ToolchainProfile, work: Path) -> BuildArtifact:
        source_root = work / "source"
        source_root.mkdir()
        extract(archive, source_root)
        closure = resolve_dependencies(
            profile, source_root, archive.manifest.lockfiles, work / "deps", index_url=self.config.index_urls.get(profile.id),
            timeout_s=run_limits["build_wall_ms"] / 1000, index_urls=self.config.index_urls, cache=self.config.scratch / DOWNLOADS_FOLDER,
        )
        # The build has bounds of its own: its memory, its output (on a disk of the build VM's own), /tmp and wall time.
        limits = replace(
            case_limits(run_limits, self.config.limits), memory_bytes=run_limits["build_memory_mb"] << 20, workspace_bytes=run_limits["build_output_bytes"],
            workspace_files=run_limits["build_files"], tmp_bytes=run_limits["build_tmp_bytes"], wall_s=run_limits["build_wall_ms"] / 1000,
        )
        return self.supervisor.build(BuildSpec(attempt_id, profile, archive.manifest, source_root, closure, work / "build", limits))

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
        manifest: PluginManifest | None,
        tools: tuple[Mapping[str, Any], ...],
        stack: AsyncExitStack,
    ) -> AttemptResult:
        cfg, run = self.config, job.run
        run_limits = run["limits"]
        model = run["model"]
        if model not in cfg.prices:
            raise UnknownModelPrice(f"the worker's prices have no entry for {model!r}")
        input_price, output_price = cfg.prices[model]
        limits = case_limits(run_limits, cfg.limits)
        # A Terminal session takes the warm terminal when it is made as this session's case would be.
        warm = None
        if job.free_form:
            warm = self._take_warm(self._recipe_of(run["source_sha256"], profile, run_argv, artifact, run_limits))
        if warm is not None:
            folder = warm.folder
            stack.push_async_callback(shielded, lambda: anyio.to_thread.run_sync(shutil.rmtree, folder, True))
        # Only the harness VM may have the internet; the tool VM and the build never do.
        network = warm.network if warm is not None else self.supervisor.create_network(job.attempt_id, internet=run_limits["internet_access"])
        workspace = Path(WORKSPACE)  # the case workspace, at the path the harness and the tool container both see
        runner: Any = NoTools()
        tool_container = None
        if tools:
            name = f"rush-tool-{job.attempt_id}-{secrets.token_hex(4)}"
            runner = self.plugins.tool_runner(manifest, workspace, tuple(tool["name"] for tool in tools), self.supervisor.tool_launcher(name))
            tool_container = ToolContainerSpec(name, manifest.root, None, tuple(job.task["egress_hosts"]))
        token = secrets.token_urlsafe(32)
        policy = AttemptPolicy(
            attempt_id=job.attempt_id, token=token, model=model, dialects=tuple(run["dialects"]),
            prompt_user=None if job.prompt is None else job.prompt["user"], prompt_system=None if job.prompt is None else job.prompt["system"],
            max_model_calls=run_limits["max_model_calls"],
            max_output_tokens_per_call=run_limits["max_output_tokens_per_call"], input_price_bound=input_price, output_price_bound=output_price,
            tools=tuple(ToolPolicy(tool["name"], bool(tool["writes"]), tool["input_schema"], tool["output_schema"]) for tool in tools),
            prompt_bound=run["prompt_bound"],
        )
        commands = CaseCommands(limits)
        late = LateTools() if job.free_form else None  # a Terminal session's `nanoagent` asks for the plugin's tools
        services = self.services_factory(
            policy=policy, endpoint=cfg.endpoint, admission=RushAdmission(self.worker, lease), journal=journal, tool_runner=runner,
            command_runner=commands, workspace=workspace, clock_ns=self.clock_ns,
            save_harness=lambda data: self.worker.save_harness(job.attempt_id, job.fence, data),
            install_cli=lambda name, expect: self._install_cli(job, name, expect),
            score_harness=lambda name: self._score(job, name),
            start_tools=None if late is None else late.start,
        )
        services.attempt.lease_lapsed = lease.lapsed  # the services refuse new work once the lease's known expiry passes
        if warm is not None:
            warm.app.app, warm.app.close, relay = services.app, services.aclose, warm.relay
        else:
            relay = await self.relay.start(job.attempt_id, network, services.app, work)
        stack.push_async_callback(shielded, relay.aclose)
        request = self._request(job, tools, relay.base_url)
        terminal = Terminal(self.worker, job.attempt_id, job.fence, terminals=MAX_TERMINALS if job.free_form else 1)
        offset = self.wall_clock_ns() - self.clock_ns()
        if warm is not None:
            handle = warm.handle
        else:
            clis = cfg.scratch / CLIS_FOLDER
            clis.mkdir(parents=True, exist_ok=True)
            spec = CaseSpec(
                job.attempt_id, profile, run_argv, artifact, json.dumps(request).encode(), token, network, work / "case", None, limits, tool_container,
                partial(terminal.write, 0), clis,
            )
            handle = await in_thread(self.supervisor.create_case, spec)
            LOG.info("attempt %s: case VMs up", job.attempt_id)
        stack.push_async_callback(shielded, lambda: in_thread(handle.close))
        stack.push_async_callback(shielded, lambda: self._revoke(services))  # a fault after this leaves no in-flight call or tool behind
        if late is not None:  # closed before the case (the stack unwinds in reverse), the tools' session first
            group = await stack.enter_async_context(anyio.create_task_group())
            stack.callback(group.cancel_scope.cancel)
            group.start_soon(self._late_tools, late, job, work, handle, services)
        if job.resume is not None:  # the session it resumes, back in its workspace before the shell starts
            said = await in_thread(restore, cfg.scratch, job.resume, handle.workspace)
            LOG.info("attempt %s: resuming %s: %s", job.attempt_id, job.resume.attempt_id, said["line"])
        if job.start is not None:  # the agent CLI its first terminal runs, as a resumed one runs its agent's resume command
            await in_thread(start_cli, handle.workspace, job.start)
        if tools:
            await stack.enter_async_context(runner)  # the plugin is up before the harness can call it
            LOG.info("attempt %s: plugin tools up", job.attempt_id)
        if warm is not None:  # launched already: the shell starts on its request and token
            warm.output.forward(partial(terminal.write, 0))
            await in_thread(handle.go, json.dumps(request).encode(), token)
            LOG.info("attempt %s: warm terminal %s handed over", job.attempt_id, handle.container_id)
        else:
            await in_thread(handle.launch)
            LOG.info("attempt %s: harness launched", job.attempt_id)
        commands.handle = handle
        await emit.emit(rec.CaseLaunched(handle.container_id, self.clock_ns(), list(run_argv)))

        recorded: list[bool] = []  # set once the collector's process evidence is committed
        try:
            outcome = await self._wait(lease, handle, services, terminal, interactive=run["interactive"], free_form=job.free_form)
            await self._revoke(services)
            lease.lapsed()  # a lease that ran out while the computer slept is dropped on waking, not finalized late
            if lease.reason in ("lease_lost", "sealed"):
                return AttemptResult("lease_lost")
            if outcome is not None:  # a canceled attempt has no observed exit
                await terminal.flush(handle)
                await emit.emit(rec.CaseExited(termination_wire(outcome.termination), int(outcome.exited_at * NS)), occurred_ns=int(outcome.exited_at * NS))
            # Quiescence (no call or tool left in flight) is reached after the exit, so it is recorded after it.
            await emit.emit(rec.CaseQuiesced(self.clock_ns()))
            if outcome is None:  # a scored run canceled mid-run
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
            if job.free_form:  # no case: the member ended the session (by its last exit, Stop or leaving its page), and nothing scores it
                await self._record_processes(emit, await in_thread(handle.evidence), lambda wall: wall - offset, commands.outcomes)
                recorded.append(True)
                resumable = await self._keep_session(job, handle)
                if lease.reason == "canceled":
                    return await self._finalize(job, journal, "canceled", None, result=AttemptResult("canceled"), resumable=resumable)
                timed_out = outcome.termination.kind is TerminationKind.TIMED_OUT  # it ran to the session's wall time
                return await self._finalize(job, journal, "ended", "timed_out" if timed_out else None, resumable=resumable)
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

    async def _keep_session(self, job: AttemptJob, handle: CaseHandle) -> bool:
        """Keeps the ended free-form session's workspace on this computer to resume; whether it was kept (RUSH learns only that)."""
        kept = await in_thread(keep, self.config.scratch, job.attempt_id, handle.workspace, datetime.now(timezone.utc), self.config.resume_bytes)
        LOG.info("attempt %s: %s", job.attempt_id, "kept to resume" if kept else "not kept to resume: larger than resume_bytes")
        return kept

    async def _record_fault_evidence(self, emit: Emitter, handle: CaseHandle, to_monotonic_ns: Callable[[int], int], commands: Sequence[ExecOutcome]) -> None:
        """After a platform fault: stop the case and commit the process evidence the collector has, so the interrupted
        attempt keeps it. A failure here is logged and does not replace the fault being handled."""
        try:
            await in_thread(handle.close)
            await self._record_processes(emit, await in_thread(handle.evidence), to_monotonic_ns, commands)
        except Exception:
            LOG.exception("the process evidence of the faulted case could not be recorded")

    def _request(self, job: AttemptJob, tools: Sequence[Mapping[str, Any]], base: str) -> dict[str, Any]:
        run, task, case, prompt = job.run, job.task, job.case, job.prompt
        request = {
            "protocol": "rush.harness.v1",
            "attempt_id": job.attempt_id,
            "policy": run["policy"],
            "task": None if task is None else {key: task[key] for key in ("id", "kind", "description", "instructions", "plugin_name")},
            "free_form": job.free_form,
            "case": None if case is None else {key: case[key] for key in ("case_id", "arguments", "context", "input_schema", "output_schema")},
            "prompt": None if prompt is None else {key: prompt[key] for key in ("system", "user", "sha256")},
            "workspace": WORKSPACE,
            "openrouter": {"base_url": f"{base}/api/v1", "model": run["model"], "dialects": list(run["dialects"])},
            "tools": {
                "url": f"{base}/tools",
                "available": [{key: tool[key] for key in ("name", "description", "input_schema", "output_schema")} for tool in tools],
            },
            "exec_url": f"{base}/exec",
            "events_url": f"{base}/events",
            "limits": dict(run["limits"]),
            "interactive": run["interactive"],
        }
        validate("Request", request)
        return request

    async def _late_tools(self, late: LateTools, job: AttemptJob, work: Path, handle: CaseHandle, services: AttemptServices) -> None:
        """Once the session's `nanoagent` asks (`late.asked`): the first task of the session's plugin, as RUSH opens it on the member's
        computer, its plugin prepared (`_plugin`), its tool VM booted beside the case and its tools' session open until the session ends,
        served by the broker to the token handed to that `nanoagent` alone. Why they could not come up answers each ask instead."""
        await late.asked.wait()
        try:
            opened = await self.worker.tools(job.attempt_id, job.fence)
            task = opened["task"]
            manifest = await in_thread(self._plugin, opened["plugin"], base64.b64decode(opened["package"]), work, True)
            name = f"rush-tool-{job.attempt_id}-{secrets.token_hex(4)}"
            await in_thread(self.supervisor.attach_tool, handle, ToolContainerSpec(name, manifest.root, None, tuple(task["egress_hosts"])))
            names = tuple(tool["name"] for tool in task["tools"])
            runner = self.plugins.tool_runner(manifest, Path(WORKSPACE), names, self.supervisor.tool_launcher(name))
            async with runner:
                token = secrets.token_urlsafe(32)
                policies = tuple(ToolPolicy(tool["name"], bool(tool["writes"]), tool["input_schema"], tool["output_schema"]) for tool in task["tools"])
                services.broker.serve(policies, runner, token)
                late.started = {
                    "token": token,
                    "system": tools_prompt(task["plugin_name"], task["description"], task["instructions"]),
                    "tools": [{key: tool[key] for key in ("name", "description", "input_schema", "output_schema")} for tool in task["tools"]],
                }
                late.up.set()
                LOG.info("attempt %s: plugin tools up for nanoagent", job.attempt_id)
                await anyio.sleep_forever()
        except Exception as error:
            LOG.warning("attempt %s: the plugin's tools could not start: %s", job.attempt_id, error)
            late.error = error.message if isinstance(error, RushError) else f"{type(error).__name__}: {error}"
        finally:
            late.up.set()

    async def _wait(self, lease: Lease, handle: CaseHandle, services: AttemptServices, terminal: Terminal, *, interactive: bool, free_form: bool) -> Any:
        """The case's outcome, or None if the lease was lost or canceled first (the case is killed and drained). A free-form session's
        cancel is how its member ends it (Stop, leaving its page, opening another): its case ends as at an exit, so its outcome comes,
        and it is recorded as one that exited is. The harness's terminal output goes to RUSH as it comes meanwhile, and, when someone is
        at it, to their page over the session's link (RUSH told where), which brings back what they type."""
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
            group.start_soon(terminal.pump, handle)
            if interactive:
                port = await group.start(terminal.serve, handle)
                await self.worker.terminal_link(lease.attempt_id, lease.fence, port, terminal.token)
                group.start_soon(self._watch, lease)
            await first_of(done, lease.revoked)
            ended = free_form and lease.reason == "canceled"
            if not done.is_set():
                await self._revoke(services)
                # Ending kills its processes under the tracer and keeps the VM; closing kills the sandbox. Either ends wait().
                await in_thread(handle.end if ended else handle.close)
                await done.wait()
            await terminal.close()
            group.cancel_scope.cancel()
        return box[0] if box and (ended or not lease.revoked.is_set()) else None

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
        losses = set(evidence.loss_reasons)
        if "journal_overflow" in losses:
            losses -= {"journal_overflow", "root_exit_missing"}  # overflow can drop the root exit too; neither may unscore the harness's crash
        if outcome["status"] == "execution_failed" and outcome["reason"] in ("nonzero_exit", "signaled") and not evidence.complete and losses:
            return None  # the exit could not be observed reliably for a reason independent of the harness's journal overflow
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
        result: AttemptResult | None = None, resumable: bool | None = None,
    ) -> AttemptResult:
        """Seals the attempt. ``resumable``, for a free-form session that ran, is whether this computer kept it to resume."""
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
        if resumable is not None:
            body["resumable"] = resumable
        await self.worker.finalize(job.attempt_id, body)
        journal.close()
        return result or AttemptResult("finalized", {"status": status, "reason": reason})
