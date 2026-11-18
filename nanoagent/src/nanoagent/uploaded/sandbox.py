"""The sandbox supervisor: builds a pinned artifact and runs each case in a fresh microVM (microsandbox).

Every sandbox is its own lightweight Linux virtual machine, booted from a pinned OCI image by the `microsandbox` package
the worker depends on: no Docker, no daemon, no privileged container. Its only network is the policy it is created
with, deny by default.

* Build: a VM from the toolchain's pinned build image with no network, the source and the verified dependency closure
  mounted read-only, and a bounded writable `/build-out`. Only the manifest's declared `build.outputs` are accepted,
  with no links, and they become the worker-owned `/harness` of every run.
* Case: a fresh VM from the pinned runtime image. The harness runs on a PTY, as an unprivileged uid beneath the worker's static
  `strace` (root), which records every process it starts (`nanoagent.uploaded.collector`). `/rush/request.json` is
  written into the VM read-only, `/harness` is mounted read-only, and `/rush/out` and `/rush/workspace` are bounded
  host directories. Its network reaches the attempt's services on the worker (the relay's port of
  `host.microsandbox.internal`) and nothing else, or, when the run grants internet access, also public addresses.
* Tools: when the suite permits plugin tools, a second VM from the pinned prep image runs the plugin's MCP server
  (`msb exec` from the broker). Its only network is the egress proxy of the hosts its plugin declares; it mounts the
  prepared plugin and approved fixtures read-only, and the case's workspace at the same path the harness sees. It never
  mounts the request, the result directory, private references or verifier files.
* Freeze: `stop_and_drain` reads each VM's CPU time, kills the tool VM and pauses the whole harness VM so no process can
  write, then copies the bounded workspace without following links.

Every failure is a [SandboxError] with a stable `code`; nothing falls back to a weaker mode.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import shutil
import socket
import threading
import time
import uuid
from collections.abc import Awaitable, Callable, Coroutine, Iterator, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field, replace
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol, TypeVar

import microsandbox
from microsandbox import (
    Action,
    Destination,
    DestGroup,
    ExecEventType,
    ExecHandle,
    ExecSink,
    MountConfig,
    MountKind,
    Network,
    NetworkPolicy,
    PatchConfig,
    PatchKind,
    Protocol as NetProtocol,
    PullEventType,
    Rlimit,
    RlimitResource,
    Rule,
    Sandbox,
    Stdin,
)

from nanoagent.plugin.egress import egress_port
from nanoagent.plugin.install import INSTALL_HOSTS
from nanoagent.uploaded.archive import ArchiveError, Extracted, copy_tree
from nanoagent.uploaded.collector import STRACE_FLAGS, CollectorError, ProcessEvent, ProcessEvidence, TraceSession, launch_argv, launched_processes, parse_trace
from nanoagent.uploaded.contract import ContractError, HarnessManifest, is_canonical_relative_path, path_problem, read_result_file, validate_argv
from nanoagent.uploaded.toolchains import DependencyClosure, ToolchainProfile

UID = 10001
GID = 10001
CASE_USER = f"{UID}:{GID}"
WORKSPACE = "/rush/workspace"
OUT_DIR = "/rush/out"
REQUEST_PATH = "/rush/request.json"
HARNESS_DIR = "/harness"
PLUGIN_DIR = "/plugin"
PLUGIN_SOURCE_DIR = "/plugin-source"  # the prep VM's read-only view of the plugin, copied into PLUGIN_DIR to build
FIXTURES_DIR = "/fixtures"
TOOLS_DIR = "/opt/rush-tools"  # the worker's guest tools (strace, uv), read-only in every VM
CLIS_DIR = "/opt/rush/clis"  # the worker's installs of the reference CLIs (nanoagent.uploaded.clis), read-only in a case VM
TRACE_DIR = "/rush-trace"  # root-owned: the case user cannot write the evidence
UV_BIN = f"{TOOLS_DIR}/uv"
STRACE_BIN = f"{TOOLS_DIR}/strace"
FIXTURES_ENV = "NANOAGENT_FIXTURES"
RESULT_NAME = "result.json"
GUEST_HOST = "host.microsandbox.internal"  # the worker, as every VM addresses it
EXEC_KILL_GRACE_S = 2
DRAIN_S = 15.0  # how long a killed command's tracer is given to write its last lines
MAX_RESULT_BYTES = 1 << 20
MIB = 1 << 20
# python:3.12-trixie: the runtime image's Debian release and Python, plus git, which uv needs for git-sourced
# dependencies. Plugins are synced here so their virtual environment matches the tool VM's runtime.
PLUGIN_PREP_IMAGE = "python@sha256:cad37dd20c7cac861af9003af8796d03ea7a998ec1e3a664429740fc9d7d2691"
# Every sandbox the supervisor creates is named `rush-…` (rush-case-, rush-tool-, rush-build-, rush-prep-, rush-probe-,
# rush-pull-, rush-tools-), so that prefix is exactly what a dead run leaves behind.
RESOURCE_PREFIX = "rush-"

# The guest tools, RUSH's own image (nanoagent/images/guest-tools, published by .github/workflows/nanoagent-images.yml): a
# static strace and uv's static Linux release at its root, one binary of each for every runtime image. Pinned by the digest
# of its multi-arch index, and copied out once per worker (the image has no shell: microsandbox's agent copies them).
GUEST_TOOLS_IMAGE = "ghcr.io/rush-lab/guest-tools@sha256:6d29aace475e4e70e7838c2b6369fc0a2c29cc3e69217501ea046f3c18af67cc"
GUEST_TOOLS = ("strace", "uv")


class SandboxError(ContractError):
    """A supervisor failure; `code` is stable (`start_failed`, `build_failed`, `output_invalid`, ...)."""


class TerminationKind(StrEnum):
    EXITED = "exited"  # exit status 0, or the raw code when no root-exit evidence could classify it
    NONZERO_EXIT = "nonzero_exit"
    SIGNALED = "signaled"
    TIMED_OUT = "timed_out"


@dataclass(frozen=True, slots=True)
class Limits:
    """Enforced budgets for one sandbox."""

    cpus: float = 1.0
    memory_bytes: int = 1 << 30
    pids: int = 256
    workspace_bytes: int = 256 << 20
    out_bytes: int = 4 << 20
    tmp_bytes: int = 64 << 20
    output_bytes: int = 1 << 20  # captured stdout and stderr, each
    wall_s: float = 300.0
    workspace_files: int = 20_000


@dataclass(frozen=True, slots=True)
class Termination:
    kind: TerminationKind
    exit_code: int | None
    signal: int | None
    oom_killed: bool = False


def map_termination(exit_code: int, *, oom_killed: bool, timed_out: bool) -> Termination:
    """An exit status to a termination. A signal is never inferred from the code (128 + n is also a plain exit status);
    signals come from the trace's exit evidence."""
    if timed_out:
        return Termination(TerminationKind.TIMED_OUT, None, 9)
    if oom_killed:
        return Termination(TerminationKind.SIGNALED, None, 9, oom_killed=True)
    if exit_code == 0:
        return Termination(TerminationKind.EXITED, 0, None)
    return Termination(TerminationKind.NONZERO_EXIT, exit_code, None)


def termination_from_root_exit(root_exit: ProcessEvent | None, exit_code: int, *, oom_killed: bool, timed_out: bool) -> Termination:
    """The harness's termination from the root process's exit evidence.

    Without that evidence the raw code is reported as `exited`, and the caller marks the process evidence incomplete:
    the signal-versus-exit question is left unanswered, not guessed.
    """
    if timed_out or oom_killed:
        return map_termination(exit_code, oom_killed=oom_killed, timed_out=timed_out)
    if root_exit is None:
        return Termination(TerminationKind.EXITED, exit_code, None)
    if root_exit.exit_signal is not None:
        return Termination(TerminationKind.SIGNALED, None, root_exit.exit_signal)
    return map_termination(root_exit.exit_code or 0, oom_killed=False, timed_out=False)


@dataclass(frozen=True, slots=True)
class CaseOutcome:
    termination: Termination
    launched_at: float  # injected monotonic clock, taken immediately before the harness starts
    exited_at: float
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool


@dataclass(frozen=True, slots=True)
class ExecOutcome:
    launch_id: str  # the marker in the member process's observed `execve`: see collector.launched_processes
    argv: tuple[str, ...]
    cwd: str  # as requested, relative to the workspace
    absolute_cwd: str  # what the process evidence reports
    termination: Termination
    launched_at: float
    returned_at: float
    launched_wall_ns: int
    returned_wall_ns: int
    stdout: bytes  # base64 these for the ExecResult wire shape
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool


@dataclass(frozen=True, slots=True)
class WorkspaceSnapshot:
    directory: Path
    files: Mapping[str, str]  # path to sha256
    added: tuple[str, ...]
    modified: tuple[str, ...]
    deleted: tuple[str, ...]
    skipped: Mapping[str, str]  # links and special files, listed but never materialized
    total_bytes: int


@dataclass(frozen=True, slots=True)
class BuildArtifact:
    directory: Path  # mounted read-only at /harness
    outputs: tuple[str, ...]
    digest: str  # sha256 over the sorted (path, sha256) of every file
    stdout: bytes
    stderr: bytes
    duration_s: float


@dataclass(frozen=True, slots=True)
class BuildSpec:
    attempt_id: str
    profile: ToolchainProfile
    manifest: HarnessManifest
    source_root: Path
    closure: DependencyClosure
    workdir: Path  # worker-owned scratch; the artifact lands in workdir/harness
    limits: Limits = Limits()


@dataclass(frozen=True, slots=True)
class ToolContainerSpec:
    """The per-attempt VM the plugin's MCP server runs in."""

    name: str  # the VM's name: the broker's `msb exec` addresses it before the case exists
    plugin_root: Path  # the plugin, prepared with `prepare_plugin`; mounted read-only at /plugin
    fixtures: Path | None = None  # approved fixtures; mounted read-only at /fixtures
    egress_hosts: tuple[str, ...] = ()  # the only hosts (HTTPS, port 443) the plugin's processes may reach, through the egress proxy


@dataclass
class AttemptNetwork:
    """What one attempt's case VM may reach: the worker's ports its services listen on (added by the relay before the
    case is created) and, with ``internet``, public addresses."""

    name: str
    internet: bool = False
    ports: list[int] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class CaseSpec:
    attempt_id: str
    profile: ToolchainProfile
    run_argv: tuple[str, ...]
    artifact: BuildArtifact
    request_json: bytes
    attempt_token: str
    network: AttemptNetwork
    workdir: Path
    fixtures: Path | None = None
    limits: Limits = Limits()
    tool: ToolContainerSpec | None = None
    on_output: Callable[[bytes], None] | None = None  # each chunk the harness writes to its terminal, as it comes
    clis: Path | None = None  # the worker's CLI installs, at CLIS_DIR: ones installed while the case runs appear there too


class CaseHandle(Protocol):
    @property
    def container_id(self) -> str: ...

    @property
    def workspace(self) -> Path:
        """The case workspace's host folder, which the case sees at WORKSPACE."""
        ...

    def launch(self) -> None:
        """Starts the harness. Returns once it runs; raises a SandboxError when it cannot start."""
        ...

    def wait(self) -> CaseOutcome:
        """Blocks until the harness exits or its wall budget ends (then every case process is killed)."""
        ...

    def exec_in_case(self, argv: Sequence[str], cwd: str, timeout_ms: int, limits: Limits) -> ExecOutcome: ...

    def go(self, request_json: bytes, token: str) -> None:
        """Hand a warm terminal (launched with a request of ``{"wait_go": true}``) the session's request and token: the shell starts."""
        ...

    def open_terminal(self, terminal: int, rows: int, cols: int, on_output: Callable[[bytes], None]) -> None:
        """Opens terminal ``terminal`` (1, 2, ...) of a free-form session, ``rows`` by ``cols``: the harness's ``run.argv`` again, on a
        PTY of its own in the same VM and workspace, with ``RUSH_TERMINAL`` its id, each chunk it writes handed to ``on_output``."""

    def terminal_input(self, terminal: int, data: bytes | None, rows: int | None = None, cols: int | None = None) -> None:
        """Types ``data`` at terminal ``terminal`` (0 the harness's), or resizes it to ``rows`` by ``cols``."""

    def close_terminal(self, terminal: int) -> None:
        """Closes terminal ``terminal``: every process of it is killed."""

    def ended_terminals(self) -> frozenset[int]:
        """The terminals that ran and ended: 0 once the harness exited."""

    def stop_and_drain(self) -> WorkspaceSnapshot:
        """Reads the CPU counters, kills the tool VM, freezes the harness VM, then snapshots the workspace and diffs it
        with the initial one."""
        ...

    def cpu_counters(self) -> list[dict[str, Any]]:
        """`{identity, user_ns, system_ns}` per VM, read by `stop_and_drain`; empty when any is unreadable."""
        ...

    def read_result(self) -> bytes:
        """The bytes of `/rush/out/result.json`; raises a ResultError-coded SandboxError when absent or unusable."""
        ...

    def evidence(self) -> ProcessEvidence:
        """The case's process evidence, once the harness has stopped."""
        ...

    def close(self) -> None: ...


T = TypeVar("T")


class _Loop:
    """The event loop every microsandbox call runs on: the supervisor's API is synchronous (the runner calls it from
    threads), and a sandbox belongs to the loop it was created on."""

    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        threading.Thread(target=self._loop.run_forever, name="microsandbox", daemon=True).start()

    def run(self, coroutine: Coroutine[Any, Any, T]) -> T:
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result()

    def submit(self, coroutine: Coroutine[Any, Any, T]) -> Any:
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop)


def _mib(size: int) -> int:
    return max(1, math.ceil(size / MIB))


def _bind(path: Path, *, readonly: bool = True, quota: int | None = None) -> MountConfig:
    # The case user owns what it sees of a host directory; on the host the files stay the worker's.
    return MountConfig(
        kind=MountKind.BIND, bind=str(path), readonly=readonly, quota_mib=None if quota is None else _mib(quota),
        override_uid=UID, override_gid=GID,
    )


def _tmpfs(size: int) -> MountConfig:
    return MountConfig(kind=MountKind.TMPFS, size_mib=_mib(size), noexec=True, nosuid=True)


def _network(ports: Sequence[int], *, internet: bool = False) -> Network:
    """Deny everything but these ports of the worker, and with ``internet`` public addresses (and DNS to reach them)."""
    rules = [Rule.allow(destination=Destination.group(DestGroup.HOST), protocol=NetProtocol.TCP, port=port) for port in ports]
    if internet:
        rules += [*Rule.allow_dns(), Rule.allow(destination=Destination.group(DestGroup.PUBLIC))]
    return Network(policy=NetworkPolicy(default_egress=Action.DENY, default_ingress=Action.DENY, rules=tuple(rules)))


@dataclass
class _Run:
    """One command's outcome in a VM."""

    code: int | None  # None when it did not exit (killed with its VM)
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool
    timed_out: bool


async def _run(
    sandbox: Sandbox, cmd: str, args: Sequence[str], *, user: str, cwd: str, env: Mapping[str, str] | None = None,
    timeout_s: float | None = None, capture_bytes: int = 1 << 20, rlimits: Sequence[Rlimit] = (),
    on_timeout: Callable[[], Awaitable[None]] | None = None, started: threading.Event | None = None, tty: bool = False,
    on_output: Callable[[bytes], None] | None = None, on_exec: Callable[[ExecHandle], None] | None = None,
) -> _Run:
    """Runs a command, keeping at most ``capture_bytes`` of each stream and handing every stdout chunk to ``on_output``. At
    ``timeout_s`` ``on_timeout`` stops it (or it is killed), and what it still prints while it ends is kept. Under ``tty``
    it runs on a PTY, whose one stream is stdout and whose input is ``on_exec``'s handle's stdin."""
    handle = await sandbox.exec_stream(
        cmd, list(args), user=user, cwd=cwd, env=dict(env or {}), rlimits=list(rlimits) or None, tty=tty, stdin=Stdin.pipe() if tty else None,
    )
    if on_exec is not None:
        on_exec(handle)
    out, err = bytearray(), bytearray()
    cut = {"stdout": False, "stderr": False}
    result: dict[str, Any] = {}

    def keep(buffer: bytearray, data: bytes, stream: str) -> None:
        room = capture_bytes - len(buffer)
        buffer += data[: max(room, 0)]
        cut[stream] = cut[stream] or len(data) > room

    async def pump() -> None:
        async for event in handle:
            kind = str(event.event_type)
            if kind == ExecEventType.STARTED and started is not None:
                started.set()
            elif kind == ExecEventType.STDOUT and event.data:
                keep(out, event.data, "stdout")
                if on_output is not None:
                    on_output(event.data)
            elif kind == ExecEventType.STDERR and event.data:
                keep(err, event.data, "stderr")
            elif kind == ExecEventType.EXITED:
                result["code"] = event.code
            elif kind == ExecEventType.FAILED:
                raise SandboxError("start_failed", (event.data or b"").decode("utf-8", "replace") or f"{cmd} could not start")

    timed_out = False
    task = asyncio.ensure_future(pump())
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout_s)
    except TimeoutError:
        timed_out = True
        if on_timeout is not None:
            await on_timeout()
        try:
            await asyncio.wait_for(asyncio.shield(task), DRAIN_S)
        except TimeoutError:
            await handle.kill()
            await asyncio.wait_for(task, DRAIN_S)
    return _Run(result.get("code"), bytes(out), bytes(err), cut["stdout"], cut["stderr"], timed_out)


async def _call(method: Callable[[], Awaitable[T]]) -> T:
    """Calls a microsandbox method on the loop's own thread: some create their future as they are called."""
    return await method()


async def _kill_case_processes(sandbox: Sandbox) -> None:
    """SIGKILL every process of the case user. Run as that user, `kill -1` reaches all of them but itself, and never the
    root tracer, which then records each exit."""
    await sandbox.exec("sh", ["-c", "kill -KILL -1"], user=CASE_USER, timeout=30)


async def _kill_terminal(sandbox: Sandbox, terminal: int) -> None:
    """SIGKILL every process of the case user whose environment has ``RUSH_TERMINAL`` of ``terminal``: what that terminal runs."""
    script = f'for d in /proc/[0-9]*; do tr "\\0" "\\n" < "$d/environ" 2>/dev/null | grep -qx RUSH_TERMINAL={terminal} && kill -KILL "${{d#/proc/}}"; done; true'
    await sandbox.exec("sh", ["-c", script], user=CASE_USER, timeout=30)


async def _oom_kills(sandbox: Sandbox) -> int:
    out = await sandbox.exec("cat", ["/proc/vmstat"], user="root", timeout=30)
    for line in out.stdout_text.splitlines():
        name, _, value = line.partition(" ")
        if name == "oom_kill":
            return int(value)
    raise SandboxError("inspect_failed", "the guest kernel reports no oom_kill counter")


async def _read_session(sandbox: Sandbox, directory: str) -> dict[int, bytes]:
    files: dict[int, bytes] = {}
    fs = sandbox.fs
    if not await fs.exists(directory):
        return files
    for entry in await fs.list(directory):
        name = entry.path.rsplit("/", 1)[-1]
        prefix, _, pid = name.partition(".")
        if prefix == "t" and pid.isdigit():
            files[int(pid)] = await fs.read(f"{directory}/{name}")
    return files


def _traced(session: str, argv: Sequence[str]) -> tuple[str, list[str]]:
    """``argv`` beneath the root tracer, dropped to the case user, its trace in its own session directory."""
    return STRACE_BIN, [*STRACE_FLAGS, "-o", f"{TRACE_DIR}/{session}/t", f"--user={CASE_USER}", "--", *argv]


async def _gathered(coroutines: Sequence[Coroutine[Any, Any, T]]) -> list[Any]:
    """Each coroutine's result, or what it raised, run side by side."""
    return list(await asyncio.gather(*coroutines, return_exceptions=True))


class ToolLauncher:
    """Runs a plugin's MCP server in the case's tool VM, for a `PluginSession`."""

    def __init__(self, supervisor: MicrosandboxSupervisor, name: str) -> None:
        self._supervisor = supervisor
        self._name = name

    def _case(self) -> _Case:
        case = self._supervisor._tool_cases.get(self._name)
        if case is None:
            raise SandboxError("tool_unavailable", f"no case has the tool VM {self._name}")
        return case

    @contextmanager
    def launch(self, manifest: Any, env: Mapping[str, str]) -> Iterator[tuple[list[str], dict[str, str]]]:
        """The `msb exec` that starts the plugin: only ``env`` and the sandbox's own variables reach it."""
        case = self._case()
        inside = {
            **env, "HOME": "/tmp", "UV_CACHE_DIR": "/tmp/uv-cache", "UV_NO_SYNC": "1", "UV_OFFLINE": "1",
            "PATH": f"{TOOLS_DIR}:/usr/local/bin:/usr/bin:/bin",
        }
        if case.spec.tool is not None and case.spec.tool.fixtures is not None:
            inside[FIXTURES_ENV] = FIXTURES_DIR
        if case.tool_proxy is not None:
            inside |= {key: case.tool_proxy for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")}
        argv = [str(MSB), "exec", "--stream", "-u", CASE_USER, "-w", PLUGIN_DIR]  # --stream: stdio both ways while open, as MCP needs
        for key, value in inside.items():
            argv += ["-e", f"{key}={value}"]
        yield [*argv, self._name, "--", *manifest.command], dict(os.environ)  # the environment is msb's, not the plugin's

    @contextmanager
    def workspace_view(self) -> Iterator[Path]:
        """A copy of the case workspace as it is now, for the host-side tool verifier to read.

        One at a time per case: concurrent tool calls of an attempt queue, so at most one copy is ever held."""
        case = self._case()
        with case.view_lock:
            _, directory = self._supervisor._copy_out(case.workspace, case.spec.limits, case.spec.workdir)
            try:
                yield directory
            finally:
                shutil.rmtree(directory, ignore_errors=True)


MSB = Path(microsandbox.__file__).parent / "_bundled" / "bin" / "msb"


async def reap_leftovers() -> list[str]:
    """Remove the `rush-*` sandboxes a previous run left; returns their names. Run it before any attempt exists."""
    reaped = []
    for handle in (await Sandbox.list()).sandboxes:
        if handle.name.startswith(RESOURCE_PREFIX):
            await handle.kill()
            await Sandbox.remove(handle.name)
            reaped.append(handle.name)
    return reaped


class MicrosandboxSupervisor:
    def __init__(
        self,
        *,
        tools: Path,
        clock: Callable[[], float] = time.monotonic,
        wall_clock_ns: Callable[[], int] = time.time_ns,
        internet: bool = False,
    ) -> None:
        self._tools_root = tools.resolve()  # where the guest tools are cached, per image digest (mounts may not pass a link)
        self._tools: Path | None = None
        self._internet = internet
        self._tool_cases: dict[str, _Case] = {}
        self._clock = clock
        self._wall_clock_ns = wall_clock_ns
        self._loop = _Loop()
        self._probed: set[str] = set()  # the runtime images whose tracer a probe proved

    # -- startup ---------------------------------------------------------------------------------

    def reap(self) -> list[str]:
        return self._loop.run(reap_leftovers())

    def prefetch(self, images: Sequence[str], report: Callable[[int, int], None]) -> None:
        """Pulls ``images`` into microsandbox's image cache, all at once, telling ``report(done, total)`` the bytes as they
        arrive (a cached image counts as done when it resolves). Every image is pinned by digest, which microsandbox verifies."""
        self._loop.run(self._prefetch(tuple(dict.fromkeys(images)), report))

    async def _prefetch(self, images: tuple[str, ...], report: Callable[[int, int], None]) -> None:
        totals = dict.fromkeys(images, 0)
        layers: dict[str, dict[int, int]] = {image: {} for image in images}

        async def pull(image: str) -> None:
            session = Sandbox.create_with_progress(f"rush-pull-{uuid.uuid4().hex[:12]}", image=image, memory=128, network=Network.none(), replace=True)
            try:
                async for event in session.progress:
                    if event.event_type == PullEventType.RESOLVED:
                        totals[image] = event.total_download_bytes or 0
                    elif event.event_type == PullEventType.LAYER_DOWNLOAD_PROGRESS:
                        layers[image][event.layer_index or 0] = event.downloaded_bytes or 0
                    elif event.event_type == PullEventType.COMPLETE:
                        layers[image] = {0: totals[image]}
                    else:
                        continue
                    report(sum(sum(done.values()) for done in layers.values()), sum(totals.values()))
                sandbox = await session.result()
            except microsandbox.MicrosandboxError as error:
                raise SandboxError("pull_failed", f"could not pull {image}: {error}") from error
            await self._destroy(sandbox)

        await asyncio.gather(*(pull(image) for image in images))

    def guest_tools(self) -> Path:
        """The guest tools, copied out of their pinned image once, then cached under its digest."""
        folder = self._tools_root / GUEST_TOOLS_IMAGE.rsplit(":", 1)[1]
        if not folder.is_dir():
            staging = self._tools_root / f".{uuid.uuid4().hex[:8]}"
            staging.mkdir(parents=True)
            try:
                self._loop.run(self._copy_guest_tools(staging))
                staging.rename(folder)
            finally:
                shutil.rmtree(staging, ignore_errors=True)
        self._tools = folder
        return folder

    async def _copy_guest_tools(self, staging: Path) -> None:
        sandbox = await self._create(f"rush-tools-{uuid.uuid4().hex[:12]}", GUEST_TOOLS_IMAGE, Limits(), Network.none(), {})
        try:
            for name in GUEST_TOOLS:
                await sandbox.fs.copy_to_host(f"/{name}", str(staging / name))
                (staging / name).chmod(0o755)
        except microsandbox.MicrosandboxError as error:
            raise SandboxError("guest_tools_failed", f"could not copy the guest tools out of {GUEST_TOOLS_IMAGE}: {error}") from error
        finally:
            await self._destroy(sandbox)

    def startup(self, profile: ToolchainProfile) -> ProcessEvidence:
        """Proves the tracer end to end in the profile's runtime image: a probe's exec and exit must be observed.

        Until this passes `build` and `create_case` refuse to run member source.
        """
        tools = self._tools or self.guest_tools()
        evidence = self._loop.run(self._probe(profile.runtime_image, tools))
        self._probed.add(profile.runtime_image)
        return evidence

    def ready(self, profile: ToolchainProfile) -> None:
        """Proves the tracer in the profile's runtime image as :meth:`startup` does, once per image and guest tools: a pass is kept
        under the guest tools' folder, both being pinned by digest, so a restart does not probe an unchanged image again."""
        if profile.runtime_image in self._probed:
            return
        passed = self._tools_root / "probed" / hashlib.sha256(f"{profile.runtime_image}\0{GUEST_TOOLS_IMAGE}".encode()).hexdigest()
        if passed.is_file():
            self._tools = self._tools or self.guest_tools()
            self._probed.add(profile.runtime_image)
            return
        self.startup(profile)
        passed.parent.mkdir(parents=True, exist_ok=True)
        passed.write_text(f"{profile.runtime_image}\n{GUEST_TOOLS_IMAGE}\n")

    async def _probe(self, image: str, tools: Path) -> ProcessEvidence:
        name = f"rush-probe-{uuid.uuid4().hex[:12]}"
        sandbox = await self._create(name, image, Limits(), Network.none(), {TOOLS_DIR: MountConfig(kind=MountKind.BIND, bind=str(tools), readonly=True)})
        try:
            await sandbox.exec("mkdir", ["-p", "-m", "0755", f"{TRACE_DIR}/probe"], user="root", timeout=30)
            cmd, args = _traced("probe", ["/bin/true"])
            run = await _run(sandbox, cmd, args, user="root", cwd="/", timeout_s=60)
            if run.code != 0:
                raise SandboxError("collector_self_test_failed", f"the traced probe failed: {run.stderr[-500:].decode('utf-8', 'replace')}")
            evidence = parse_trace(name, [TraceSession(await _read_session(sandbox, f"{TRACE_DIR}/probe"), "/", False)])
        finally:
            await self._destroy(sandbox)
        if not evidence.complete:
            raise SandboxError("collector_self_test_failed", f"probe evidence incomplete: {', '.join(evidence.loss_reasons)}")
        root = evidence.root()
        if root is None or root.argv != ("/bin/true",) or root.exit is None or root.exit.exit_code != 0:
            raise SandboxError("collector_self_test_failed", "the probe's exec and exit were not both observed")
        return evidence

    def _require_ready(self, image: str | None = None) -> None:
        """A build needs the tracer proven in some image, a case in its own runtime image."""
        if not self._probed if image is None else image not in self._probed:
            raise SandboxError("collector_unverified", "startup() has not proven the tracer; member source is not accepted")

    # -- networks --------------------------------------------------------------------------------

    def verify_egress(self) -> None:
        """Proves an internet-access VM cannot reach the worker beyond its services: a listener on this host that the
        case was not given must stay unreachable. Raises a SandboxError otherwise, so internet access is never advertised
        without that fence."""
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(0.1)
            port = listener.getsockname()[1]
            reached = self._loop.run(self._egress_probe(port))
            try:
                listener.accept()
                reached = True
            except OSError:
                pass
        if reached:
            raise SandboxError("egress_unverified", f"an internet-access VM reached this host's port {port}")

    async def _egress_probe(self, port: int) -> bool:
        name = f"rush-probe-{uuid.uuid4().hex[:12]}"
        sandbox = await self._create(name, PLUGIN_PREP_IMAGE, Limits(), _network((), internet=True), {})
        try:
            code = f"import socket; socket.create_connection(({GUEST_HOST!r}, {port}), timeout=3); print('reached')"
            out = await sandbox.exec("python", ["-c", code], user="root", timeout=30)
            return "reached" in out.stdout_text
        finally:
            await self._destroy(sandbox)

    def create_network(self, attempt_id: str, *, internet: bool = False) -> AttemptNetwork:
        if internet and not self._internet:
            raise SandboxError("network_failed", "internet access is not enabled on this worker")
        return AttemptNetwork(f"rush-net-{attempt_id}", internet)

    # -- build -----------------------------------------------------------------------------------

    def build(self, spec: BuildSpec) -> BuildArtifact:
        self._require_ready()
        for output in spec.manifest.build_outputs:
            if path_problem(output) is not None or not is_canonical_relative_path(output):
                raise SandboxError("output_invalid", f"declared build output {output!r} is not a canonical relative path")
        source = self._stage_source(spec)
        out = spec.workdir / f"build-out-{uuid.uuid4().hex[:8]}"
        out.mkdir(parents=True)
        try:
            run, duration = self._loop.run(self._build(spec, source, out))
            if run.timed_out:
                raise SandboxError("build_timeout", f"build exceeded {spec.limits.wall_s}s")
            if run.code != 0:
                raise SandboxError("build_failed", f"build exited {run.code}: {run.stderr[-2000:].decode('utf-8', 'replace')}")
            extracted = self._copy_out(out, spec.limits, spec.workdir)
            try:
                return self._accept_outputs(spec, extracted, run, duration)
            finally:
                shutil.rmtree(extracted[1], ignore_errors=True)
        finally:
            shutil.rmtree(out, ignore_errors=True)

    async def _build(self, spec: BuildSpec, source: Path, out: Path) -> tuple[_Run, float]:
        name = f"rush-build-{spec.attempt_id}-{uuid.uuid4().hex[:8]}"
        volumes = {
            "/src": _bind(source), spec.profile.offline.dependency_mount: _bind(spec.closure.directory),
            "/build-out": _bind(out, readonly=False, quota=spec.limits.workspace_bytes), "/tmp": _tmpfs(spec.limits.tmp_bytes),
        }
        sandbox = await self._create(name, spec.profile.build_image, spec.limits, Network.none(), volumes)
        try:
            env = {**spec.profile.offline.env, "HOME": "/tmp", "TMPDIR": "/tmp"}
            started = self._clock()
            argv = spec.manifest.build_argv
            run = await _run(
                sandbox, argv[0], argv[1:], user=CASE_USER, cwd="/src", env=env, timeout_s=spec.limits.wall_s,
                capture_bytes=spec.limits.output_bytes, rlimits=[Rlimit(RlimitResource.NPROC, spec.limits.pids, spec.limits.pids)],
                on_timeout=lambda: _kill_case_processes(sandbox),
            )
            return run, self._clock() - started
        finally:
            await self._destroy(sandbox)

    def _stage_source(self, spec: BuildSpec) -> Path:
        """A private copy with modes the unprivileged build user can read; links are refused."""
        staged = spec.workdir / "src"
        if staged.exists():
            shutil.rmtree(staged)
        for path in spec.source_root.rglob("*"):
            if path.is_symlink():
                raise SandboxError("output_invalid", f"source contains a link: {path.relative_to(spec.source_root)}")
        shutil.copytree(spec.source_root, staged, symlinks=False)
        for path in [staged, *staged.rglob("*")]:
            executable = path.is_dir() or os.access(path, os.X_OK)
            path.chmod(0o755 if executable else 0o644)
        return staged

    def _accept_outputs(self, spec: BuildSpec, extracted: tuple[Extracted, Path], run: _Run, duration: float) -> BuildArtifact:
        tree, root = extracted
        artifact = spec.workdir / "harness"
        if artifact.exists():
            shutil.rmtree(artifact)
        artifact.mkdir(parents=True)
        accepted: dict[str, str] = {}
        for output in spec.manifest.build_outputs:
            prefix = output + "/"
            covered = {p: h for p, h in tree.files.items() if p == output or p.startswith(prefix)}
            if any(p == output or p.startswith(prefix) for p in tree.skipped):
                raise SandboxError("output_invalid", f"build output {output} contains a link or special file")
            if not covered and output not in tree.directories:
                raise SandboxError("output_invalid", f"declared build output {output} was not produced")
            accepted.update(covered)
            source = root / output
            target = artifact / output
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target, dirs_exist_ok=True)
            else:
                shutil.copy2(source, target)
        for path in [artifact, *artifact.rglob("*")]:
            executable = path.is_dir() or os.access(path, os.X_OK)
            path.chmod(0o755 if executable else 0o644)
        digest = hashlib.sha256("".join(f"{p}\0{h}\n" for p, h in sorted(accepted.items())).encode()).hexdigest()
        return BuildArtifact(artifact, spec.manifest.build_outputs, digest, run.stdout, run.stderr, duration)

    # -- case ------------------------------------------------------------------------------------

    def start_case(self, spec: CaseSpec) -> _Case:
        handle = self.create_case(spec)
        try:
            handle.launch()
        except BaseException:
            handle.close()
            raise
        return handle

    def tool_launcher(self, name: str) -> ToolLauncher:
        """The launcher for the tool VM ``name``; the case that names it in `CaseSpec.tool` is created later."""
        return ToolLauncher(self, name)

    def prepare_plugin(self, root: Path, timeout_s: float) -> None:
        """`uv sync --frozen` the unpacked plugin at ``root`` inside the pinned prep image, in a VM.

        The environment lands in ``root/.venv``, valid at /plugin in the tool VM. Publisher code runs here (the project's
        build, git sources, sdists), so the VM has the default case limits and ``root`` is mounted read-only: the build
        runs in a copy of it inside the VM (a build writes into its source, as setuptools' egg-info does), only ``.venv``
        is writable on the host, and nothing else there can be planted or swapped. Its only network is the host install's
        egress proxy, which tunnels `INSTALL_HOSTS` (the package index and GitHub) and nothing else.
        """
        tools = self._require_tools()
        venv = root / ".venv"
        venv.mkdir(exist_ok=True)
        with egress_port(INSTALL_HOSTS) as port:
            run = self._loop.run(self._prepare(root, venv, tools, port, timeout_s))
        if run.timed_out:
            raise SandboxError("plugin_prepare_failed", f"preparing {root.name} exceeded {timeout_s}s")
        if run.code != 0:
            raise SandboxError("plugin_prepare_failed", f"prepare plugin {root.name} failed: {run.stderr[-2000:].decode('utf-8', 'replace')}")

    async def _prepare(self, root: Path, venv: Path, tools: Path, port: int, timeout_s: float) -> _Run:
        name = f"rush-prep-{uuid.uuid4().hex[:12]}"
        volumes = {
            PLUGIN_SOURCE_DIR: MountConfig(kind=MountKind.BIND, bind=str(root), readonly=True),
            f"{PLUGIN_DIR}/.venv": MountConfig(kind=MountKind.BIND, bind=str(venv)),
            TOOLS_DIR: MountConfig(kind=MountKind.BIND, bind=str(tools), readonly=True),
            "/tmp": MountConfig(kind=MountKind.TMPFS, size_mib=1024, nosuid=True),
        }
        sandbox = await self._create(name, PLUGIN_PREP_IMAGE, Limits(), _network([port]), volumes)
        proxy = f"http://{GUEST_HOST}:{port}"
        env = {"HOME": "/tmp", "UV_CACHE_DIR": "/tmp/uv-cache", "UV_LINK_MODE": "copy", "UV_PYTHON_DOWNLOADS": "never", "HTTPS_PROXY": proxy, "https_proxy": proxy}
        script = f'tar -C {PLUGIN_SOURCE_DIR} --exclude=./.venv -cf - . | tar -C {PLUGIN_DIR} -xf - && cd {PLUGIN_DIR} && exec "$@"'
        try:
            return await _run(
                sandbox, "sh", ["-c", script, "prep", UV_BIN, "sync", "--frozen", "--no-dev", "--python", "/usr/local/bin/python", "--quiet"],
                user="root", cwd="/", env=env, timeout_s=timeout_s,
            )
        finally:
            await self._destroy(sandbox)

    def _require_tools(self) -> Path:
        if self._tools is None:
            raise SandboxError("tool_unavailable", "the guest tools are not ready: call startup() first")
        return self._tools

    def create_case(self, spec: CaseSpec) -> _Case:
        """Creates the case's VM and, when `spec.tool` is set, its running tool VM.

        The harness starts at `launch`, so a caller can open the plugin session first. `start_case` does both.
        """
        self._require_ready(spec.profile.runtime_image)
        validate_argv(list(spec.run_argv))
        tools = self._require_tools()
        spec.workdir.mkdir(parents=True, exist_ok=True)
        suffix = f"{spec.attempt_id}-{uuid.uuid4().hex[:8]}"
        workspace, out = spec.workdir / "workspace", spec.workdir / "out"
        for folder in (workspace, out):
            shutil.rmtree(folder, ignore_errors=True)
            folder.mkdir()
        initial: dict[str, str] = {}
        if spec.fixtures is not None:
            initial = self._preload(workspace, spec.fixtures)
        bridge = ExitStack()
        proxy: str | None = None
        case: Sandbox | None = None
        tool: Sandbox | None = None
        try:
            name = f"rush-case-{suffix}"
            creating = [self._create(
                name, spec.profile.runtime_image, spec.limits, _network(spec.network.ports, internet=spec.network.internet),
                {
                    WORKSPACE: _bind(workspace, readonly=False, quota=spec.limits.workspace_bytes), OUT_DIR: _bind(out, readonly=False, quota=spec.limits.out_bytes),
                    HARNESS_DIR: _bind(spec.artifact.directory), TOOLS_DIR: MountConfig(kind=MountKind.BIND, bind=str(tools), readonly=True),
                    "/tmp": _tmpfs(spec.limits.tmp_bytes), **({} if spec.clis is None else {CLIS_DIR: _bind(spec.clis)}),
                },
                patches=[PatchConfig(kind=PatchKind.FILE, path=REQUEST_PATH, content=spec.request_json, mode=0o444)],
                labels={"rush.attempt": spec.attempt_id},
            )]
            if spec.tool is not None:
                ports: list[int] = []
                if spec.tool.egress_hosts:
                    port = bridge.enter_context(egress_port(spec.tool.egress_hosts))
                    ports, proxy = [port], f"http://{GUEST_HOST}:{port}"
                creating.append(self._start_tool(spec, workspace, tools, ports))
            # The case VM and the tool VM boot side by side; one that fails takes the other down with it.
            booted = self._loop.run(_gathered(creating))
            case, tool = booted[0], booted[1] if len(booted) > 1 else None
            failed = [result for result in booted if isinstance(result, BaseException)]
            if failed:
                raise failed[0]
            handle = _Case(self, spec, name, case, tool, workspace, out, initial)
            handle.tool_proxy, handle.bridge = proxy, bridge
            if spec.tool is not None:
                self._tool_cases[spec.tool.name] = handle
            return handle
        except BaseException:
            for sandbox in (tool, case):
                if sandbox is not None and not isinstance(sandbox, BaseException):
                    self._loop.run(self._destroy(sandbox))
            bridge.close()
            raise

    def attach_tool(self, handle: _Case, tool: ToolContainerSpec) -> None:
        """Boots the tool VM ``tool`` beside the running case ``handle`` (a Terminal session's, whose shell starts before it)."""
        spec = replace(handle.spec, tool=tool)
        ports: list[int] = []
        proxy: str | None = None
        if tool.egress_hosts:
            ports = [handle.bridge.enter_context(egress_port(tool.egress_hosts))]
            proxy = f"http://{GUEST_HOST}:{ports[0]}"
        sandbox = self._loop.run(self._start_tool(spec, handle.workspace, self._require_tools(), ports))
        if handle._closing.is_set():  # the case closed while its tool VM booted
            self._loop.run(self._destroy(sandbox))
            raise SandboxError("closed", "the case closed before its tool VM was up")
        handle.spec, handle._tool, handle.tool_proxy = spec, sandbox, proxy
        self._tool_cases[tool.name] = handle

    async def _start_tool(self, spec: CaseSpec, workspace: Path, tools: Path, ports: Sequence[int]) -> Sandbox:
        """The tool VM: no network but, when the plugin declares hosts, the egress proxy's; the case workspace at the
        harness's path, plugin and fixtures read-only."""
        tool = spec.tool
        assert tool is not None
        volumes = {
            PLUGIN_DIR: _bind(tool.plugin_root), TOOLS_DIR: MountConfig(kind=MountKind.BIND, bind=str(tools), readonly=True),
            WORKSPACE: _bind(workspace, readonly=False, quota=spec.limits.workspace_bytes), "/tmp": _tmpfs(spec.limits.tmp_bytes),
        }
        if tool.fixtures is not None:
            volumes[FIXTURES_DIR] = _bind(tool.fixtures)
        # The plugin's venv is only valid in its prep image, whatever the harness's toolchain.
        return await self._create(tool.name, PLUGIN_PREP_IMAGE, spec.limits, _network(ports), volumes, labels={"rush.attempt": spec.attempt_id, "rush.role": "tool"})

    def _preload(self, workspace: Path, fixtures: Path) -> dict[str, str]:
        initial = {}
        for path in sorted(fixtures.rglob("*")):
            relative = path.relative_to(fixtures).as_posix()
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise SandboxError("fixture_failed", f"{relative} is not a regular file or directory")
            if path.is_dir():
                (workspace / relative).mkdir(parents=True, exist_ok=True)
            else:
                shutil.copyfile(path, workspace / relative)
                initial[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        return initial

    # -- shared plumbing -------------------------------------------------------------------------

    async def _create(
        self, name: str, image: str, limits: Limits, network: Network, volumes: Mapping[str, MountConfig], *,
        patches: Sequence[PatchConfig] = (), labels: Mapping[str, str] | None = None,
    ) -> Sandbox:
        try:
            return await Sandbox.create(
                name, image=image, cpus=max(1, math.ceil(limits.cpus)), memory=_mib(limits.memory_bytes), network=network,
                volumes=dict(volumes), patches=list(patches) or None, labels=dict(labels or {}), replace=True,
            )
        except microsandbox.MicrosandboxError as error:
            raise SandboxError("start_failed", f"could not start {name} from {image}: {error}") from error

    async def _destroy(self, sandbox: Sandbox) -> None:
        name = await sandbox.name
        try:
            await sandbox.kill()
        finally:
            await Sandbox.remove(name)

    def _copy_out(self, source: Path, limits: Limits, workdir: Path) -> tuple[Extracted, Path]:
        destination = workdir / f"copy-{uuid.uuid4().hex[:8]}"
        try:
            extracted = copy_tree(source, destination, max_files=limits.workspace_files, max_bytes=limits.workspace_bytes)
        except ArchiveError as error:
            shutil.rmtree(destination, ignore_errors=True)
            raise SandboxError(error.code, error.message) from error
        return extracted, destination


class _Case:
    """One case: its VM, the harness traced in it, and its tool VM."""

    def __init__(
        self, supervisor: MicrosandboxSupervisor, spec: CaseSpec, name: str, sandbox: Sandbox, tool: Sandbox | None, workspace: Path, out: Path,
        initial: dict[str, str],
    ) -> None:
        self._s = supervisor
        self.spec = spec
        self._sandbox = sandbox
        self._name = name
        self._tool = tool
        self.workspace = workspace
        self._out = out
        self._initial = initial
        self._future: Any = None
        self._env: dict[str, str] = {}  # the harness's environment, which every terminal starts with
        self._ptys: dict[int, ExecHandle] = {}  # each terminal's command (0 the harness's), once it runs
        self._keys: dict[int, ExecSink] = {}  # and its input
        self._terminals: dict[int, Any] = {}  # each further terminal's run (a future of a `_Run`), by id
        self._terminals_lock = threading.Lock()
        self._outcome: CaseOutcome | None = None
        self._launched_at = 0.0
        self._deadline = 0.0
        self._oom_before = 0
        self._paused = False
        self._final: ProcessEvidence | None = None
        self._counters: list[dict[str, Any]] = []
        self._sessions: dict[str, TraceSession] = {}  # managed commands' traces, by launch ID
        self._evidence_lock = threading.Lock()
        self.view_lock = threading.Lock()  # one workspace copy at a time (`ToolLauncher.workspace_view`)
        self._closing = threading.Event()
        self.tool_proxy: str | None = None  # the tool VM's egress proxy URL, when it has declared hosts
        self.bridge = ExitStack()  # the egress proxy; closed with the case

    @property
    def container_id(self) -> str:
        return self._name

    def _run(self, coroutine: Coroutine[Any, Any, T]) -> T:
        return self._s._loop.run(coroutine)

    def launch(self) -> None:
        limits = self.spec.limits
        env = {
            "RUSH_REQUEST": REQUEST_PATH, "RUSH_RESULT": f"{OUT_DIR}/{RESULT_NAME}", "RUSH_WORKSPACE": WORKSPACE,
            "RUSH_ATTEMPT_TOKEN": self.spec.attempt_token, "HOME": "/tmp", "TMPDIR": "/tmp", "TERM": "xterm-256color",
            "RUSH_TERMINAL": "0", **self.spec.profile.runtime_env,
        }
        self._env = env
        self._oom_before = self._run(self._prepare_trace())
        started = threading.Event()
        # The harness runs on a PTY, as in a person's terminal: what is typed at it reaches it there (`terminal_input`).
        cmd, args = _traced("harness", self.spec.run_argv)
        self._launched_at = self._s._clock()
        self._deadline = self._launched_at + limits.wall_s
        self._future = self._s._loop.submit(_run(
            self._sandbox, cmd, args, user="root", cwd=WORKSPACE, env=env, timeout_s=limits.wall_s, capture_bytes=limits.output_bytes,
            rlimits=[Rlimit(RlimitResource.NPROC, limits.pids, limits.pids)], on_timeout=lambda: _kill_case_processes(self._sandbox),
            started=started, tty=True, on_output=self.spec.on_output, on_exec=lambda handle: self._attach(0, handle),
        ))
        while not started.wait(0.02):
            if self._future.done():
                self._future.result()  # raises the start failure
                raise SandboxError("start_failed", "the harness exited before it was observed to start")

    def go(self, request_json: bytes, token: str) -> None:
        (self._out / "request.json").write_bytes(request_json)
        staged = self._out / ".go.json"
        staged.write_text(json.dumps({"token": token}))
        staged.rename(self._out / "go.json")  # whole, after the request: the shell reads it the moment it appears

    def _attach(self, terminal: int, handle: ExecHandle) -> None:
        self._ptys[terminal] = handle
        self._keys[terminal] = handle.take_stdin()

    def _run_of(self, terminal: int) -> Any:
        return self._future if terminal == 0 else self._terminals[terminal]

    def open_terminal(self, terminal: int, rows: int, cols: int, on_output: Callable[[bytes], None]) -> None:
        """Opens terminal ``terminal``, which runs to the case's deadline. Once every terminal has ended the session is ending, and
        none opens."""
        assert terminal > 0 and self._future is not None
        with self._terminals_lock:
            assert terminal not in self._terminals
            if all(run.done() for run in [self._future, *self._terminals.values()]):
                return
            started = threading.Event()
            session = f"terminal-{terminal}"
            self._run(self._sandbox.exec("mkdir", ["-p", "-m", "0755", f"{TRACE_DIR}/{session}"], user="root", timeout=30))
            cmd, args = _traced(session, self.spec.run_argv)
            limits = self.spec.limits
            self._terminals[terminal] = self._s._loop.submit(_run(
                self._sandbox, cmd, args, user="root", cwd=WORKSPACE, env={**self._env, "RUSH_TERMINAL": str(terminal)},
                timeout_s=max(self._deadline - self._s._clock(), 0), capture_bytes=limits.output_bytes,
                rlimits=[Rlimit(RlimitResource.NPROC, limits.pids, limits.pids)], on_timeout=lambda: _kill_case_processes(self._sandbox),
                started=started, tty=True, on_output=on_output, on_exec=lambda handle: self._attach(terminal, handle),
            ))
        while not started.wait(0.02):
            if self._terminals[terminal].done():
                self._terminals[terminal].result()  # raises the start failure
                return  # it ended as it started
        self.terminal_input(terminal, None, rows, cols)

    def terminal_input(self, terminal: int, data: bytes | None, rows: int | None = None, cols: int | None = None) -> None:
        """Types ``data`` at terminal ``terminal``, or resizes it to ``rows`` by ``cols``. Once it has ended there is no one to type to,
        and it is dropped, as it is for a terminal the session ended before it opened."""
        if terminal != 0 and terminal not in self._terminals:
            return
        run = self._run_of(terminal)
        if run.done():
            return
        pty, keys = self._ptys[terminal], self._keys[terminal]
        try:
            self._run(_call(lambda: keys.write(data) if data is not None else pty.resize(rows, cols)))
        except microsandbox.MicrosandboxError:
            if not run.done():
                raise

    def close_terminal(self, terminal: int) -> None:
        """Kills every case process of terminal ``terminal``: each one that has its ``RUSH_TERMINAL`` (a process that changed it
        ends with the case). The tracer, root's, records their exits and ends with them."""
        if terminal != 0 and terminal not in self._terminals:
            return
        if not self._run_of(terminal).done():
            self._run(_kill_terminal(self._sandbox, terminal))

    def ended_terminals(self) -> frozenset[int]:
        with self._terminals_lock:
            runs = {0: self._future, **self._terminals}
        return frozenset(terminal for terminal, run in runs.items() if run is not None and run.done())

    def _further(self) -> list[Any]:
        """The runs of the terminals the member opened, so far."""
        with self._terminals_lock:
            return list(self._terminals.values())

    async def _prepare_trace(self) -> int:
        await self._sandbox.exec("mkdir", ["-p", "-m", "0755", f"{TRACE_DIR}/harness"], user="root", timeout=30)
        return await _oom_kills(self._sandbox)

    def wait(self) -> CaseOutcome:
        if self._outcome is not None:
            return self._outcome
        assert self._future is not None
        try:
            run: _Run = self._future.result()
            # A free-form session ends when its last terminal does: the harness's, or one the member opened.
            while pending := [future for future in self._further() if not future.done()]:
                for future in pending:
                    future.exception()  # waits; a terminal that failed ends only itself
            timed_out = run.timed_out or any(future.exception() is None and future.result().timed_out for future in self._further())
        except BaseException as error:
            if self._closing.is_set():  # close() removed the VM while this waited on it
                raise SandboxError("closed", "the case was closed while it was awaited") from error
            raise
        exited_at = self._s._clock()
        oom = self._run(_oom_kills(self._sandbox)) > self._oom_before
        evidence = self.evidence(tracer_ok=run.code is not None)
        root = evidence.root()
        root_exit = root.exit if root is not None else None
        termination = termination_from_root_exit(root_exit, run.code if run.code is not None else -1, oom_killed=oom, timed_out=timed_out)
        if root_exit is None:
            self._final = replace(evidence, complete=False, loss_reasons=(*evidence.loss_reasons, "root_exit_missing"))
        self._outcome = CaseOutcome(termination, self._launched_at, exited_at, run.stdout, run.stderr, run.stdout_truncated, run.stderr_truncated)
        return self._outcome

    def exec_in_case(self, argv: Sequence[str], cwd: str, timeout_ms: int, limits: Limits) -> ExecOutcome:
        validate_argv(list(argv))
        remaining = self._deadline - self._s._clock()
        if remaining <= 0:
            raise SandboxError("case_over", "the case deadline has passed")
        absolute = self._resolve_cwd(cwd)
        timeout_s = min(timeout_ms / 1000, remaining)
        launch_id = uuid.uuid4().hex
        # `timeout` runs the member's argv in its own process group and signals the group: TERM at the deadline, KILL after
        # the grace. `env -u RUSH_LAUNCH_<id>` puts the supervisor's marker into an observed `execve` and execs the member in
        # that same process, so the process evidence names its command exactly. The recorded command stays the member's argv.
        wrapped = ["timeout", f"--kill-after={EXEC_KILL_GRACE_S}", "--signal=TERM", f"{timeout_s:.3f}", *launch_argv(launch_id, argv)]
        cmd, args = _traced(launch_id, wrapped)
        launched, launched_wall = self._s._clock(), self._s._wall_clock_ns()
        run, files = self._run(self._exec(launch_id, cmd, args, absolute, timeout_s, limits))
        returned, returned_wall = self._s._clock(), self._s._wall_clock_ns()
        session = TraceSession(files, absolute, True, tracer_ok=run.code is not None)
        self._sessions[launch_id] = session
        # 124 (TERM) and 137 (KILL) are `timeout`'s codes, but a command can exit with them itself: it timed out only
        # when the deadline actually elapsed on the worker clock.
        deadline_elapsed = returned - launched >= timeout_s
        if run.code is None or run.timed_out or (deadline_elapsed and run.code in (124, 137)):
            termination = Termination(TerminationKind.TIMED_OUT, None, None)
        else:
            termination = map_termination(run.code, oom_killed=False, timed_out=False)
            if termination.kind is TerminationKind.NONZERO_EXIT:
                termination = self._signaled_by_evidence(launch_id, session, termination)
        return ExecOutcome(
            launch_id, tuple(argv), cwd, absolute, termination, launched, returned, launched_wall, returned_wall,
            run.stdout, run.stderr, run.stdout_truncated, run.stderr_truncated,
        )

    async def _exec(self, launch_id: str, cmd: str, args: Sequence[str], cwd: str, timeout_s: float, limits: Limits) -> tuple[_Run, dict[int, bytes]]:
        await self._sandbox.exec("mkdir", ["-p", "-m", "0755", f"{TRACE_DIR}/{launch_id}"], user="root", timeout=30)
        # PYTHONUNBUFFERED is emptied for the command: an unbuffered Python can drop part of a large write to a pipe.
        run = await _run(
            self._sandbox, cmd, args, user="root", cwd=cwd, env={"PYTHONUNBUFFERED": ""}, timeout_s=timeout_s + EXEC_KILL_GRACE_S + 10,
            capture_bytes=limits.output_bytes,
        )
        return run, await _read_session(self._sandbox, f"{TRACE_DIR}/{launch_id}")

    def _signaled_by_evidence(self, launch_id: str, session: TraceSession, raw: Termination) -> Termination:
        """`timeout` reports a command killed by a signal as 128 + n, which a plain exit can also be: only the member
        process's exit evidence tells them apart. Without it the raw exit code stands, as for the harness."""
        evidence = parse_trace(self.container_id, [session])
        identity = next((i for i, found in launched_processes(evidence).items() if found == launch_id), None)
        member = next((p for p in evidence.lifetimes() if p.identity == identity), None)
        if member is not None and member.exit is not None and member.exit.exit_signal is not None:
            return Termination(TerminationKind.SIGNALED, None, member.exit.exit_signal)
        return raw

    def _resolve_cwd(self, cwd: str) -> str:
        if cwd == ".":
            return WORKSPACE
        if (problem := path_problem(cwd)) is not None:
            raise ContractError("invalid_cwd", f"cwd {cwd!r}: {problem}")
        # The workspace is a host directory: every component of the path is checked here, without following a link.
        path = self.workspace
        for part in cwd.split("/"):
            path = path / part
            if path.is_symlink():
                raise ContractError("invalid_cwd", f"cwd {cwd!r} passes through a link")
            if not path.exists():
                raise ContractError("invalid_cwd", f"cwd {cwd!r} does not exist in the workspace")
        return f"{WORKSPACE}/{cwd}"

    def stop_and_drain(self) -> WorkspaceSnapshot:
        self._counters = self._run(self._read_counters())
        if self._tool is not None:
            self._run(self._s._destroy(self._tool))
            self._tool = None
        if not self._paused:
            self._run(_call(self._sandbox.pause))
            self._paused = True
        extracted, directory = self._s._copy_out(self.workspace, self.spec.limits, self.spec.workdir)
        files = extracted.files
        added = tuple(sorted(set(files) - set(self._initial)))
        deleted = tuple(sorted(set(self._initial) - set(files)))
        modified = tuple(sorted(p for p in files if p in self._initial and files[p] != self._initial[p]))
        return WorkspaceSnapshot(directory, files, added, modified, deleted, extracted.skipped, extracted.total_bytes)

    async def _read_counters(self) -> list[dict[str, Any]]:
        """Every VM's guest CPU time, all or nothing: one unreadable VM leaves no counters, so the projection reports CPU
        as unknown instead of a total that leaves one out. The guest kernel's time is counted as user time."""
        counters = []
        for sandbox, role, name in ((self._sandbox, "harness", self._name), (self._tool, "tool", self.spec.tool.name if self.spec.tool else "")):
            if sandbox is None:
                continue
            try:
                metrics = await sandbox.metrics()
            except microsandbox.MicrosandboxError:
                return []
            counters.append({"identity": {"role": role, "container": name}, "user_ns": metrics.vcpu_time_ns, "system_ns": 0})
        return counters

    def cpu_counters(self) -> list[dict[str, Any]]:
        return list(self._counters)

    def read_result(self) -> bytes:
        # Only result.json is read: anything else in the directory is ignored. The VM is frozen, so it cannot change.
        return read_result_file(self._out, RESULT_NAME, MAX_RESULT_BYTES)

    def evidence(self, *, tracer_ok: bool = True) -> ProcessEvidence:
        with self._evidence_lock:  # wait() and close() both take it, from different threads
            if self._final is None:
                if self._paused:
                    self._run(_call(self._sandbox.resume))
                    self._paused = False
                harness = TraceSession(self._run(_read_session(self._sandbox, f"{TRACE_DIR}/harness")), WORKSPACE, False, tracer_ok)
                # Each further terminal is traced from its own root, beside the harness's, as a managed command is.
                terminals = [
                    TraceSession(self._run(_read_session(self._sandbox, f"{TRACE_DIR}/terminal-{terminal}")), WORKSPACE, True, run.done() and run.exception() is None)
                    for terminal, run in sorted(self._terminals.items())
                ]
                self._final = parse_trace(self.container_id, [harness, *terminals, *self._sessions.values()])
            return self._final

    def close(self) -> None:
        if self._closing.is_set():
            return
        self._closing.set()
        if self._future is not None and not all(future.done() for future in [self._future, *self._further()]):
            # Still running: end every case process, so the tracer records their exits, then keep what it wrote.
            if self._paused:
                self._run(_call(self._sandbox.resume))
                self._paused = False
            self._run(_kill_case_processes(self._sandbox))
            for future in [self._future, *self._further()]:
                try:
                    future.result(timeout=DRAIN_S + 5)
                except Exception:
                    pass
        if self._future is not None:
            try:
                self.evidence(tracer_ok=self._future.done() and self._future.exception() is None)
            except (CollectorError, microsandbox.MicrosandboxError):
                pass
        for sandbox in (self._tool, self._sandbox):
            if sandbox is not None:
                self._run(self._s._destroy(sandbox))
        self._tool = None
        self.bridge.close()
        if self.spec.tool is not None:
            self._s._tool_cases.pop(self.spec.tool.name, None)
