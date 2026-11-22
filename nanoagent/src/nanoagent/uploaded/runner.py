"""The attempt runner: one leased attempt from claim to finalize (docs/plans/uploaded-harness-benchmarks.md, "Architecture").

Everything it touches is injected: the sandbox supervisor, the worker API client, the service relay, the clocks, the
verifier, the services factory, the plugin loader and projection. The lifecycle and the API calls it makes:

1. fetch the plugin package under the fence and build the shell harness (the only harness there is: a listed agent CLI or a member's
   `rush <command>` runs in it, named by the request's `harness`); record `attempt.started`. A case's fixtures archive is fetched too,
   its sha256 checked against the case's, and unpacked into a fresh folder the case's workspace is seeded from.
2. attempt network, attempt services behind the relay, `Request` (the case's prompt only: never its arguments, schemas or reference),
   `start_case`. The lease is renewed in the background for the whole attempt, build included, and fenced locally: once its known expiry
   passes without a successful renewal the gateway, tool broker, command service and event intake refuse new work, as the server
   does. Lease loss revokes admission, kills the case and finalizes nothing (RUSH interrupts the attempt). A cancel (`409 canceled`
   on renew or admission) revokes, stops and finalizes `canceled` without a score.
3. on exit or the wall limit: revoke and drain the services, freeze and snapshot the workspace, commit the collector's process
   evidence, read the outcome from the frozen workspace (nanoagent.uploaded.outcome: `answered`, `refused`, or `execution_failed` with
   its exact reason), run the plugin verifier once on it, project the evidence, upload spans and links and finalize with the verdict
   and the verifier's check names and statuses. A harness that timed out, was signaled, exited nonzero or left a workspace over its
   bound is `execution_failed` and the verifier is not called. A free-form Terminal session (``free_form``: its member runs any agent
   and prompts it themselves) has no case: it reads no result, runs no verifier and finalizes `ended`, keeping its model calls,
   commands and snapshot. Its workspace, which holds the agent CLIs' state, is kept on this computer to resume
   (nanoagent.uploaded.resume), however it ended, and a session that resumes one gets it back before its shell starts. Its files,
   less the agents' state and caches, are also uploaded to RUSH (nanoagent.uploaded.workspace_upload).

Faults of the platform itself (a sandbox that will not start, a plugin that will not install, a tool container that fails
to launch, a fixtures archive that does not match its digest) are logged and end only that attempt: its services are revoked, its
sandbox and network removed, and the process evidence the collector has is committed. A case attempt is then finalized `worker_error`
with the exception's type and message as its reason, and no verifier run: RUSH queues the case again (three attempts in all) and, after
the last, does not grade the run. A free-form session is finalized by nothing and expires as interrupted. The worker goes on to its next job.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import hashlib
import io
import json
import os
import logging
import platform
import re
import secrets
import shutil
import subprocess
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
from slimconfig import build_output

from nanoagent import __version__
from nanoagent.plugin.manifest import PluginManifest, load_manifest
from nanoagent.plugin.tasks import tools_prompt
from nanoagent.plugin.verifier import VerifierError, verify_task, verify_task_verifier_case
from nanoagent.uploaded import records as rec
from nanoagent.uploaded.app import AttemptServices
from nanoagent.uploaded.archive import ArchiveError, unpack_tar
from nanoagent.uploaded.attempt import AttemptPolicy, ServiceError, ToolPolicy
from nanoagent.uploaded.broker import PluginToolRunner, ToolError
from nanoagent.uploaded.clis import CLIS, Cli
from nanoagent.uploaded.collector import ProcessEvent, ProcessEventKind, ProcessEvidence, launched_processes
from nanoagent.uploaded.contract import ContractError, validate
from nanoagent.uploaded.endpoint import EndpointProfile
from nanoagent.uploaded.execservice import ExecError
from nanoagent.uploaded.outcome import ANSWER, answer_instructions, answer_skeleton, answer_text, outcome as read_outcome
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
    WorkspaceSnapshot,
)
from nanoagent.uploaded.reference import build_reference
from nanoagent.uploaded import chats
from nanoagent.uploaded.resume import copy_workspace, keep, restore, start_cli
from nanoagent.uploaded.source import SourceLimits, extract, inspect_zip
from nanoagent.uploaded.terminal import MAX_TERMINALS, Terminal
from nanoagent.uploaded.workspace_upload import TooLarge, pack, upload
from nanoagent.uploaded.toolchains import CLOSURE_ARCHIVE, ToolchainProfile, resolve_dependencies, toolchain

LOG = logging.getLogger(__name__)
NS = 1_000_000_000
MAX_REASON_CHARS = 200  # of an execution reason RUSH accepts: a worker error's says what the worker raised
EXPECTED_SOURCES = ("worker", "gateway", "process")
EXEC_THREADS = 4  # concurrent managed commands per attempt
SNAPSHOT_EVENT_DIFF_BYTES = 128 * 1024  # of the diff a snapshot.taken event carries; the snapshot payload has all of it
BUILDS = "builds"  # under the scratch folder: each built harness (the shell, the CLIs), kept for the next attempt
CLIS_FOLDER = "clis"  # under the scratch folder: the terminal's CLI installs (nanoagent.uploaded.clis), mounted into every case
DOWNLOADS_FOLDER = "downloads"  # under the scratch folder: every build's checked downloads, by lock hash (toolchains.cached_fetch)
FIXTURES_FOLDER = "fixtures"  # under an attempt's folder: its case's fixtures, unpacked
MAX_FIXTURES_BYTES = 256 << 20  # of a case's fixtures, uncompressed
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
AGENTS_FILE = "agents.json"  # under the scratch folder: the programs the member ran as `rush <program>` (RememberedAgents)
WORKSPACE_AGENTS = ".rush/agents"  # in a Terminal session's workspace: those programs, one per line, which its shell wraps (bashrc)
AGENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")  # a program a shell function can be named after
EVICT_IDLE_S = 24 * 3600  # a run's pinned installation unused this long may be removed to make room for another run's
AGENT_AREAS = ("python", "npm")  # under a workspace's .rush/: where `pip install` and `npm install -g` put a member's own agent
SHELL_NAMES = {"mgen", "rush", "clear"}  # what the terminal's bin/ and bashrc define beside the listed CLIs
WARM_RECIPE = "warm.json"  # under the scratch folder: the last Terminal session's limits, the warm terminal's after a start
WARM_MAX_AGE_S = 600.0  # a warm terminal nobody took is replaced after this, well within any session's wall time
LIVE_SPANS_S = 3.0  # how often a free-form session's trace so far goes to RUSH, so the Dashboard names its agents and chats as they work


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


class RushRuns:
    """A Terminal session's `rush <command>` runs (the shell's rush.py) under way, by id: its process."""

    def __init__(self) -> None:
        self.running: dict[str, int] = {}  # run id -> pid


class RememberedAgents:
    """The programs the member ran as `rush <program>`, kept in this computer's scratch folder (AGENTS_FILE: the worker serves its
    member alone), so every session after has them too; and each live Terminal session's workspace, whose WORKSPACE_AGENTS lists them
    for its shell (bashrc wraps each, typed plain, as `rush <program>`, reading the list again before every prompt). A listed CLI
    (bin/) or a name bashrc defines is never remembered: those are recorded already or are the shell's own."""

    def __init__(self, scratch: Path) -> None:
        self.path = scratch / AGENTS_FILE
        self.workspaces: set[Path] = set()
        self.running: dict[str, int] = {}  # run id -> its cases under way on this worker, whose installation is never removed
        self._lock = threading.Lock()

    def names(self) -> list[str]:
        return json.loads(self.path.read_text(encoding="utf-8")) if self.path.is_file() else []

    def installed(self) -> dict[str, Path]:
        """Remembered commands with an executable in a kept Terminal workspace, newest first."""
        sessions = self.path.parent / "sessions"
        if not sessions.is_dir():
            return {}
        kept = []
        for folder in sessions.iterdir():
            note, workspace = folder / "session.json", folder / "workspace"
            if note.is_file() and workspace.is_dir():
                kept.append((json.loads(note.read_text(encoding="utf-8"))["ended_at"], workspace))
        result: dict[str, Path] = {}
        for _, workspace in sorted(kept, key=lambda item: item[0], reverse=True):
            for name in self.names():
                if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", name):
                    continue
                if name in result:
                    continue
                for area in ("python", "npm"):
                    root = workspace / ".rush" / area
                    program = root / "bin" / name
                    if program.is_file() and os.access(program, os.X_OK) and program.resolve().is_relative_to(root.resolve()):
                        result[name] = workspace
                        break
        return result

    def seed(self, command: str, run_id: str, workspace: Path, max_bytes: int, storage_bytes: int) -> None:
        """Pin one installation per run, then copy only its package directories into a fresh case."""
        if not AGENT_NAME.fullmatch(command) or not re.fullmatch(r"[0-9a-f-]{36}", run_id):
            raise ContractError("invalid_agent", "invalid installed agent or run id")
        target = self.path.parent / "benchmark-installs" / run_id
        with self._lock:
            evicted = target.with_name(f"{run_id}.evicted")
            if not target.exists() and evicted.exists():
                # Pinned again from another session it could be another version of the agent: one run's cases would mix them.
                raise ContractError("agent_evicted", f"this run's installation of {command} was removed to make room for later runs; run the benchmark again")
            if not target.exists():
                source = self.installed().get(command)
                if source is None:
                    raise ContractError("agent_not_installed", f"{command} has no installed executable in a kept Terminal session")
                staged = target.with_name(f"{run_id}.{uuid.uuid4().hex}.copying")
                needed = sum(tree_bytes(source / ".rush" / area) for area in AGENT_AREAS if (source / ".rush" / area).is_dir())
                if needed + len(command.encode("utf-8")) > storage_bytes:
                    raise ContractError("agent_storage_full", f"{command}'s installation is larger than the computer's benchmark agent storage")
                # Installations no case is using and none has used for a day make room, least recently used first; a run whose installation
                # went says so if it asks again (agent_evicted). One still in use, or used lately, is never removed: then storage is full.
                idle = time.time() - EVICT_IDLE_S
                pinned = sorted(
                    (folder for folder in target.parent.iterdir() if folder.is_dir() and folder.name not in self.running and folder.stat().st_mtime < idle),
                    key=lambda folder: folder.stat().st_mtime,
                ) if target.parent.is_dir() else []  # fmt: skip
                while pinned and needed + len(command.encode("utf-8")) > storage_bytes - tree_bytes(target.parent):
                    oldest = pinned.pop(0)
                    oldest.with_name(f"{oldest.name}.evicted").touch()
                    shutil.rmtree(oldest, ignore_errors=True)
                if needed + len(command.encode("utf-8")) > storage_bytes - (tree_bytes(target.parent) if target.parent.is_dir() else 0):
                    raise ContractError("agent_storage_full", "The computer's benchmark agent storage is held by runs used within the last day; try again later")
                try:
                    staged.mkdir(parents=True)
                    (staged / "command").write_text(command, encoding="utf-8")
                    remaining = max_bytes
                    for area in AGENT_AREAS:
                        folder = source / ".rush" / area
                        if folder.is_dir():
                            remaining -= copy_workspace(folder, staged / area, remaining)
                    staged.rename(target)
                except BaseException:
                    shutil.rmtree(staged, ignore_errors=True)
                    raise
            if (target / "command").read_text(encoding="utf-8") != command:
                raise ContractError("invalid_agent", "the run's installed agent changed")
            os.utime(target)  # in use: the oldest used go first when room is made
            self.running[run_id] = self.running.get(run_id, 0) + 1  # until ``release``: its installation stays while the case runs
        try:
            rush = workspace / ".rush"
            if rush.exists():
                raise ContractError("agent_install_conflict", "the case fixtures contain .rush, reserved for the installed agent")
            rush.mkdir()
            remaining = max_bytes
            for area in AGENT_AREAS:
                if (target / area).is_dir():
                    remaining -= copy_workspace(target / area, rush / area, remaining)
        except BaseException:
            self.release(run_id)
            raise

    def release(self, run_id: str) -> None:
        """One case of run ``run_id`` that ``seed`` seeded is over: its installation may be removed once no case of the run uses it."""
        with self._lock:
            self.running[run_id] -= 1
            if not self.running[run_id]:
                del self.running[run_id]

    def attach(self, workspace: Path) -> None:
        """A session's workspace, listed from now until ``detach``."""
        self.workspaces.add(workspace)
        self._write_to(workspace, self.names())

    def detach(self, workspace: Path) -> None:
        self.workspaces.discard(workspace)

    def remember(self, command: str) -> None:
        """Remember the program ``command`` (a run's argv[0]) names, if it is a bare name that can be remembered."""
        names = self.names()
        if command in names or not AGENT_NAME.match(command) or command in CLIS or command in SHELL_NAMES or command.startswith("rush_"):
            return
        self._save(sorted([*names, command]))

    def forget(self, name: str) -> None:
        names = self.names()
        if name not in names:
            raise ServiceError(404, "not_remembered", f"{name} is not a remembered program; remembered: {', '.join(names) or 'none'}")
        self._save([each for each in names if each != name])

    def _save(self, names: list[str]) -> None:
        staged = self.path.with_suffix(".tmp")
        staged.write_text(json.dumps(names), encoding="utf-8")
        staged.rename(self.path)
        for workspace in self.workspaces:
            self._write_to(workspace, names)

    @staticmethod
    def _write_to(workspace: Path, names: list[str]) -> None:
        listed = workspace / WORKSPACE_AGENTS
        listed.parent.mkdir(parents=True, exist_ok=True)
        staged = listed.with_suffix(".tmp")
        staged.write_text("".join(f"{name}\n" for name in names), encoding="utf-8")
        staged.rename(listed)  # whole: a shell reads it before every prompt


def run_figures(records: Sequence[Mapping[str, Any]], run: str) -> dict[str, Any]:
    """What the model calls of `rush <command>` run ``run`` took, those its process tree made (the gateway took them under the run their
    token named), whatever else ran meanwhile: their tokens, and their cost, None while one of theirs is not known; and the model each
    call it refused for naming another model than the session's asked for (`rejected`)."""
    made = [record for record in records if record["data"].get("run") == run]
    admitted = {record["data"]["call_id"] for record in made if record["kind"] == "model_call.admitted"}
    calls = [record["data"] for record in records if record["kind"] == "model_call.response" and record["data"]["call_id"] in admitted]
    costs = [(call.get("settlement") or {}).get("cost_usd") for call in calls]
    return {
        "rejected": [
            str(record["data"].get("requested_model")) for record in made if record["kind"] == "model_call.rejected" and record["data"].get("code") == "model_not_pinned"
        ],
        "input_tokens": sum((call.get("usage") or {}).get("input") or 0 for call in calls),
        "output_tokens": sum((call.get("usage") or {}).get("output") or 0 for call in calls),
        "cost_usd": None if None in costs else float(sum((Decimal(cost) for cost in costs), Decimal(0))),
    }


class NoTools:
    """The runner of an attempt that permits no tools (a free-form session, until its `nanoagent` asks for the plugin's)."""

    async def run(self, name: str, arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
        raise ToolError("tool_not_available", f"{name!r} is not a permitted tool", 403)


@dataclass(frozen=True)
class RunnerConfig:
    worker_id: str
    endpoint: EndpointProfile
    prices: Mapping[str, tuple[Decimal, Decimal]]  # model -> (input, output) USD per token, upper bounds
    scratch: Path
    output_maxima: Mapping[str, int] = field(default_factory=dict)  # model -> its own maximum output tokens per call (OpenRouter's)
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
    workspace_upload_bytes: int = 200 << 20  # the most of an ended Terminal session's workspace uploaded to RUSH, compressed (workspace_upload)


@dataclass(frozen=True)
class AttemptResult:
    """How the attempt ended: `finalized`, `canceled` (finalized as such), `worker_error` (a case attempt the worker failed, finalized as
    such for RUSH to queue again), `lease_lost` (nothing finalized), `sealed`, or `platform_fault` (a free-form session's: nothing finalized,
    the session expires as interrupted)."""

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
                facts.append((when, rec.ProcessExec(
                    event.thread_group_id, event.thread_group_start_time_ns, list(event.argv), event.cwd, when, launch_ids.get(event.identity),
                    event.binary_path or None, event.argv_truncated,
                )))
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


class UnsupportedLimits(RuntimeError):
    """A claimed run asks for more than the worker advertised it can give."""


SESSION_STATE = ".rush"  # in a workspace: the session's own state (CLI homes, chats, resume files), not what the agent made


def without_session_state(snapshot: WorkspaceSnapshot) -> WorkspaceSnapshot:
    """The frozen workspace as the trace, the outcome seam and the verifier see it: less ``.rush/``. The workspace archive RUSH keeps is
    packed from the live workspace, which still holds it."""
    shutil.rmtree(snapshot.directory / SESSION_STATE, ignore_errors=True)

    def agent_made(path: str) -> bool:
        return path != SESSION_STATE and not path.startswith(f"{SESSION_STATE}/")

    return replace(
        snapshot,
        files={path: sha for path, sha in snapshot.files.items() if agent_made(path)},
        added=tuple(filter(agent_made, snapshot.added)), modified=tuple(filter(agent_made, snapshot.modified)),
        deleted=tuple(filter(agent_made, snapshot.deleted)),
        skipped={path: why for path, why in snapshot.skipped.items() if agent_made(path)},
    )


def check_limits(limits: Mapping[str, Any], capabilities: Mapping[str, Any]) -> None:
    """Raise [UnsupportedLimits] when ``limits`` exceed what ``capabilities`` advertises."""
    over = [f"{name} {limits[name]} > {capabilities[name]}" for name in NUMERIC_LIMITS if limits[name] > capabilities[name]]
    if limits["internet_access"] and not capabilities["internet_access"]:
        over.append("internet_access is not supported")
    if over:
        raise UnsupportedLimits("the run's limits exceed this worker's capabilities: " + "; ".join(over))


CHECK_STATUSES = frozenset({"passed", "failed", "skipped"})


def checks_of(details: Mapping[str, Any]) -> list[dict[str, str]] | None:
    """The verifier's named checks, ``details.checks``, as `[{name, status}]` (their messages and values stay with the verifier): None when
    the verifier names none; a list that is not a bounded list of named checks with a known status is a verifier fault (ValueError)."""
    raw = details.get("checks")
    if raw is None:
        return None
    if not isinstance(raw, list) or len(raw) > 100 or not all(
        isinstance(check, dict) and isinstance(check.get("name"), str) and 0 < len(check["name"]) <= 200 and check.get("status") in CHECK_STATUSES for check in raw
    ):
        raise ValueError("verify_task() details.checks is not a list of at most 100 {name, status} checks with a status of passed, failed or skipped")
    return [{"name": check["name"], "status": check["status"]} for check in raw]


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
        verify_task: Callable[..., Any] = verify_task,
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
        self.verify_task = verify_task
        self.project = project
        self.agents = RememberedAgents(config.scratch)
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
        work = self.config.scratch / f"warm-build-{uuid.uuid4().hex[:8]}"
        work.mkdir(parents=True)
        try:
            archive, profile, artifact = self._shell("warm-build", run_limits, work)
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
        try:
            async with anyio.create_task_group() as renewing:
                renewing.start_soon(self._renew, job, lease)
                try:
                    try:
                        result = await self._attempt(job, lease, journal, Emitter(journal, self.clock_ns), work)
                    except BaseExceptionGroup as group:  # the session's task groups wrap a lone fault: it is that fault
                        error = group
                        while isinstance(error, BaseExceptionGroup) and len(error.exceptions) == 1:
                            error = error.exceptions[0]
                        raise error from None
                except (LeaseLost, Canceled) as error:
                    lease.fail(error)
                    result = AttemptResult("lease_lost" if isinstance(error, LeaseLost) else "canceled")
                except Sealed:
                    result = AttemptResult("sealed")
                except Exception as error:  # a fault of the platform, not of the member's harness: it ends this attempt only
                    fault = f"{type(error).__name__}: {error}"
                    if job.case is None:  # a free-form session is not retried: it is left to expire as interrupted
                        LOG.exception("attempt %s: platform fault, the session is left to expire as interrupted", job.attempt_id)
                        result = AttemptResult("platform_fault", {"error": fault})
                    else:  # a case's: finalized as a worker error, which is no failure of the case, and RUSH queues it again
                        LOG.exception("attempt %s: worker error, the attempt is finalized as such", job.attempt_id)
                        result = await self._worker_error(job, journal, fault[:MAX_REASON_CHARS])
                finally:
                    renewing.cancel_scope.cancel()  # a finished, lost or failed attempt stops renewing its lease
        finally:
            journal.close()
            shutil.rmtree(work, ignore_errors=True)
        return replace(result, accounting=pending_calls(journal.records))

    async def _worker_error(self, job: AttemptJob, journal: RushJournal, reason: str) -> AttemptResult:
        """Finalizes a case attempt the worker itself failed as `worker_error` with `reason`, and no verifier run. A lease that is lost, a
        cancel or a seal first leave it as they would any attempt."""
        try:
            return await self._finalize(job, journal, "worker_error", reason, result=AttemptResult("worker_error", {"error": reason}))
        except (LeaseLost, Canceled, Sealed) as error:
            return AttemptResult("lease_lost" if isinstance(error, LeaseLost) else "sealed" if isinstance(error, Sealed) else "canceled")

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

    async def _attempt(self, job: AttemptJob, lease: Lease, journal: RushJournal, emit: Emitter, work: Path) -> AttemptResult:
        cfg = self.config
        if cfg.renew_interval_s >= job.lease_seconds:
            raise RenewalConfigError(f"poll.renew_interval_s ({cfg.renew_interval_s:g}) must be shorter than the server's lease ({job.lease_seconds:g} s)")
        run = job.run
        limits = run["limits"]
        check_limits(limits, cfg.capabilities)
        # A free-form Terminal session runs nothing of its plugin: RUSH keeps no package for it, and none is fetched or unpacked.
        package = None if job.free_form else await self.worker.package(job.attempt_id, job.fence)
        fixtures = None if job.case is None else await self._fixtures(job, work / FIXTURES_FOLDER)
        if (ended := await self._ended(job, lease, journal)) is not None:
            return ended
        # The harness is the shell, which runs the agent the run names; it is the platform's own build, so one that fails is a platform fault.
        archive, profile, artifact = await in_thread(self._shell, job.attempt_id, limits, work)
        await emit.emit(
            rec.AttemptStarted(
                job.attempt_id, cfg.worker_id, {"label": cfg.endpoint.label, "mode": cfg.endpoint.mode}, run["model"], list(archive.manifest.dialects),
                None if job.case is None else job.case["prompt_sha256"], "shell", archive.manifest.toolchain, archive.source_sha256, cfg.harness_revision,
                dict(limits), None,
                {"reference_tokens_per_second": cfg.reference_tokens_per_second, "clock_tolerance_ns": cfg.clock_tolerance_ns},
                list(EXPECTED_SOURCES),
            )
        )
        if (ended := await self._ended(job, lease, journal)) is not None:  # the build is a thread nothing can interrupt, so a cancel is seen after it
            return ended
        LOG.info("attempt %s: harness built", job.attempt_id)  # with the worker log's times, these lines show where a session's start goes
        manifest = None
        if package is not None:
            manifest = await in_thread(self._plugin, job.plugin, package, work, bool(job.task["tools"]))
            LOG.info("attempt %s: plugin ready", job.attempt_id)
            if (ended := await self._ended(job, lease, journal)) is not None:
                return ended
        async with AsyncExitStack() as stack:
            return await self._case(job, lease, journal, emit, work, archive, profile, artifact, manifest, fixtures, stack)

    async def _fixtures(self, job: AttemptJob, folder: Path) -> Path:
        """The case's fixtures, fetched by its route (a case without any gets an empty ``folder``), checked against the digest the claim names and
        unpacked into a fresh ``folder``: only regular files and directories, and exactly the files the claim lists. A mismatch is a fault of the
        platform, not of the harness. Then the unfilled ``answer.json`` is seeded beside them, so it is part of the workspace's baseline."""
        declared = job.case["fixtures"]
        if declared is None:
            folder.mkdir(parents=True)
        else:
            data = await self.worker.fixtures(job.attempt_id, job.fence)
            if hashlib.sha256(data).hexdigest() != declared["sha256"]:
                raise ContractError("fixtures_mismatch", f"the fixtures of case {job.case['case_id']} do not hash to {declared['sha256']}")
            await in_thread(self._unpack_fixtures, data, folder, declared["files"], job.run["limits"])
        (folder / ANSWER).write_bytes(answer_text(answer_skeleton(job.task["output_schema"])))
        return folder

    @staticmethod
    def _unpack_fixtures(data: bytes, folder: Path, files: Mapping[str, str], limits: Mapping[str, Any]) -> None:
        folder.mkdir(parents=True)
        tarball = folder.with_name(folder.name + ".tar")
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as source, tarball.open("wb") as out:
                if len(plain := source.read(MAX_FIXTURES_BYTES + 1)) > MAX_FIXTURES_BYTES:
                    raise ContractError("fixtures_too_large", f"the fixtures are over {MAX_FIXTURES_BYTES} bytes uncompressed")
                out.write(plain)
            unpacked = unpack_tar(tarball, folder, max_files=limits["workspace_files"], max_bytes=limits["workspace_bytes"])
        except (OSError, EOFError, ArchiveError) as error:  # a gzip that is not one, or a tar that leaves its folder
            raise ContractError("fixtures_invalid", f"the fixtures archive cannot be unpacked: {error}") from error
        finally:
            tarball.unlink(missing_ok=True)
        if unpacked.skipped or unpacked.files != dict(files):
            raise ContractError("fixtures_mismatch", f"the unpacked fixtures are not the files the case lists (skipped: {sorted(unpacked.skipped)})")

    async def _ended(self, job: AttemptJob, lease: Lease, journal: RushJournal) -> AttemptResult | None:
        """The result of an attempt whose lease was lost or canceled while it was preparing, before any case ran: canceled is
        finalized as such, as a cancel during the case is; a lost lease finalizes nothing. None while the lease holds."""
        if not lease.lapsed():
            return None
        if lease.reason == "canceled":
            return await self._finalize(job, journal, "canceled", None, result=AttemptResult("canceled"))
        return AttemptResult("lease_lost")

    def _shell(self, attempt_id: str, run_limits: Mapping[str, Any], work: Path) -> tuple[Any, ToolchainProfile, BuildArtifact]:
        """The shell harness this worker's NanoAgent ships (`build_reference`), its tracer proven in its image, built as any build is
        (kept, or built now)."""
        archive = inspect_zip(build_reference("shell"), self.config.source_limits)
        profile = toolchain(archive.manifest.toolchain)
        self.supervisor.ready(profile)
        return archive, profile, self._build(attempt_id, run_limits, archive, profile, work)

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

    async def _install_cli(self, job: AttemptJob, name: str) -> AsyncIterator[Mapping[str, Any]]:
        """Installs the terminal's CLI ``name`` (its reference harness, built as any harness is), once per lockfile: what the
        wrapper shows while it waits, then where the install is in the case VM, or why there is none."""
        cli = CLIS.get(name)
        if cli is None:
            yield {"error": f"{name} is not a CLI the terminal installs; they are {', '.join(CLIS)}"}
            return
        archive, profile, key = await in_thread(self._cli_source, cli)
        version = cli.version()
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

    async def _rush_run(
        self, runs: RushRuns, emit: Emitter, journal: RushJournal, services: AttemptServices, action: str, body: Mapping[str, Any]
    ) -> Mapping[str, Any]:
        """One request of a Terminal session's `rush <command>` run (the shell's rush.py, app RUN_ACTIONS). `start` ({pid, title,
        command}): a run of process ``pid`` begins, its id answered, its title (a one-shot run's prompt argument) kept on its process
        (records.ProcessRush), which the Dashboard titles its row by, with the run's id, which every model call its process tree makes
        names (rush.py gives the command the key `<token>.<run>`); its command (argv[0]) is remembered (RememberedAgents). `title`
        ({run, title}): an interactive run's, the first line typed into it. `end` ({run, exit_code}): what its model calls took
        (run_figures). `forget` ({program}): a remembered program is no longer. `start` and `forget` answer the remembered programs (`agents`),
        which rush.py writes to its own workspace again (see `kept`): the guest's mount of the file the worker replaced reads it as gone."""
        if action == "forget":
            if not isinstance(body.get("program"), str):
                raise ServiceError(400, "invalid_request", "forget names a program")
            self.agents.forget(body["program"])
            return {"agents": self.agents.names()}
        if action == "start":
            pid, title, command = body.get("pid"), body.get("title"), body.get("command")
            if not isinstance(pid, int) or not (title is None or isinstance(title, str)) or not isinstance(command, str):
                raise ServiceError(400, "invalid_request", "a run starts with its process's pid, its title, or null, and its command")
            self.agents.remember(command)
            run = uuid.uuid4().hex
            runs.running[run] = pid
            await emit.emit(rec.ProcessRush(pid, self.clock_ns(), title=title or None, run=run))
            return {"run": run, "agents": self.agents.names()}
        run = body.get("run")
        if run not in runs.running:
            raise ServiceError(404, "unknown_run", "no run under way here has that id")
        pid = runs.running[run]
        if action == "title":
            if not isinstance(body.get("title"), str):
                raise ServiceError(400, "invalid_request", "a title is a string")
            await emit.emit(rec.ProcessRush(pid, self.clock_ns(), title=body["title"]))
            return {}
        if not isinstance(body.get("exit_code"), int):
            raise ServiceError(400, "invalid_request", "a run ends with its exit_code")
        del runs.running[run]
        await services.flush()  # the run's last calls are in the journal
        return run_figures(journal.records, run)

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
        archive: Any,
        profile: ToolchainProfile,
        artifact: BuildArtifact,
        manifest: PluginManifest | None,
        fixtures: Path | None,
        stack: AsyncExitStack,
    ) -> AttemptResult:
        cfg, run = self.config, job.run
        run_argv = archive.manifest.run_argv
        run_limits = run["limits"]
        model = run["model"]
        if model not in cfg.prices:
            raise UnknownModelPrice(f"the worker's prices have no entry for {model!r}")
        input_price, output_price = cfg.prices[model]
        limits = case_limits(run_limits, cfg.limits)
        # A case's CLI is installed before its VM starts, as a Terminal session's are ahead of it (keep_warm): its install time is no part
        # of the case's elapsed time or wall limit, and an install that fails is the worker's fault (a worker error), not the harness's.
        cli = {"mgen": "nanoagent"}.get(run["harness"], run["harness"])
        if not job.free_form and cli in CLIS:
            async for said in self._install_cli(job, cli):
                if "error" in said:
                    raise RuntimeError(said["error"])
        # A Terminal session takes the warm terminal when it is made as this session's case would be.
        warm = None
        if job.free_form:
            warm = self._take_warm(self._recipe_of(archive.source_sha256, profile, run_argv, artifact, run_limits))
        if warm is not None:
            folder = warm.folder
            stack.push_async_callback(shielded, lambda: anyio.to_thread.run_sync(shutil.rmtree, folder, True))
        # Only the harness VM may have the internet; the tool VM and the build never do.
        network = warm.network if warm is not None else self.supervisor.create_network(job.attempt_id, internet=run_limits["internet_access"])
        workspace = Path(WORKSPACE)  # the case workspace, at the path the harness and the tool container both see
        token = secrets.token_urlsafe(32)
        policy = AttemptPolicy(
            attempt_id=job.attempt_id, token=token, model=model, dialects=tuple(archive.manifest.dialects),
            prompt_user=None if job.case is None else job.case["prompt"], prompt_system=None if job.case is None else answer_instructions(job.task),
            max_model_calls=run_limits["max_model_calls"],
            max_output_tokens_per_call=run_limits["max_output_tokens_per_call"], input_price_bound=input_price, output_price_bound=output_price,
            tools=(),  # the plugin's tools are the session's `nanoagent`'s alone, started when it asks (`_late_tools`)
            prompt_bound=run["prompt_bound"], model_max_output_tokens=cfg.output_maxima.get(model),
        )
        commands = CaseCommands(limits)
        late = LateTools()  # a session's `nanoagent` asks for the plugin's tools
        runs = RushRuns()  # and its `rush <command>` runs
        services = self.services_factory(
            policy=policy, endpoint=cfg.endpoint, admission=RushAdmission(self.worker, lease), journal=journal, tool_runner=NoTools(),
            command_runner=commands, workspace=workspace, clock_ns=self.clock_ns,
            install_cli=lambda name: self._install_cli(job, name),
            rush_run=lambda action, body: self._rush_run(runs, emit, journal, services, action, body),
            start_tools=late.start,
        )
        services.attempt.lease_lapsed = lease.lapsed  # the services refuse new work once the lease's known expiry passes
        if warm is not None:
            warm.app.app, warm.app.close, relay = services.app, services.aclose, warm.relay
        else:
            relay = await self.relay.start(job.attempt_id, network, services.app, work)
        stack.push_async_callback(shielded, relay.aclose)
        request = self._request(job, archive.manifest.dialects, relay.base_url)
        terminal = Terminal(self.worker, job.attempt_id, job.fence, terminals=MAX_TERMINALS, scratch=cfg.scratch)
        offset = self.wall_clock_ns() - self.clock_ns()
        if warm is not None:
            handle = warm.handle
        else:
            clis = cfg.scratch / CLIS_FOLDER
            clis.mkdir(parents=True, exist_ok=True)
            spec = CaseSpec(
                job.attempt_id, profile, run_argv, artifact, json.dumps(request).encode(), token, network, work / "case", fixtures, limits, None,
                partial(terminal.write, 0), clis,
            )
            handle = await in_thread(self.supervisor.create_case, spec)
            LOG.info("attempt %s: case VMs up", job.attempt_id)
        stack.push_async_callback(shielded, lambda: in_thread(handle.close))
        stack.push_async_callback(shielded, lambda: self._revoke(services))  # a fault after this leaves no in-flight call or tool behind
        # Closed before the case (the stack unwinds in reverse), the tools' session first.
        group = await stack.enter_async_context(anyio.create_task_group())
        stack.callback(group.cancel_scope.cancel)
        group.start_soon(self._late_tools, late, job, work, handle, services, manifest, emit)
        if job.resume is not None:  # the session it resumes, back in its workspace before the shell starts
            said = await in_thread(restore, cfg.scratch, job.resume, handle.workspace)
            LOG.info("attempt %s: resuming %s: %s", job.attempt_id, job.resume.attempt_id, said["line"])
        if job.start is not None:  # the agent CLI its first terminal runs, as a resumed one runs its agent's resume command
            await in_thread(start_cli, handle.workspace, job.start)
        # A member's own agent (`rush <program> [<argument>…]`): its program's installation, from a kept Terminal session.
        seeded = not job.free_form and job.run["harness"].startswith("rush ")
        if seeded:
            program = job.run["harness"].removeprefix("rush ").split(" ")[0]
            await in_thread(self.agents.seed, program, job.run["run_id"], handle.workspace, limits.workspace_bytes, cfg.resume_bytes)
            stack.callback(self.agents.release, job.run["run_id"])
        # The member's remembered programs, over any list a resumed session brought back.
        self.agents.attach(handle.workspace)
        stack.callback(self.agents.detach, handle.workspace)
        # The conversations its agents kept as it starts (a resumed session's are back): it holds those it talks in (chats.talked).
        restored = await in_thread(chats.read, handle.workspace)
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
            live = partial(self._live_spans, job, journal, handle, lambda wall: wall - offset, commands.outcomes, [])
            outcome = await self._wait(lease, handle, services, terminal, interactive=run["interactive"], free_form=job.free_form, live=live)
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
            if seeded:  # the installation the worker seeded is no part of what the agent left: it is not frozen or held to the workspace's bounds
                for area in AGENT_AREAS:
                    await in_thread(shutil.rmtree, handle.workspace / SESSION_STATE / area, True)
            try:
                snapshot = await in_thread(handle.stop_and_drain)
            except SandboxError as error:
                if error.code != "snapshot_too_large":
                    raise
                snapshot = None  # the harness left more than the workspace bound: a failed case, not a platform fault
                LOG.info("attempt %s: %s", job.attempt_id, error.message)
            if snapshot is not None:
                snapshot = await in_thread(without_session_state, snapshot)
                await self._record_snapshot(journal, emit, snapshot)
            if counters := handle.cpu_counters():  # empty when a container's cgroup was unreadable: CPU stays Unknown
                await emit.emit(rec.CpuCounters(counters))
            # The session's capture, as a Terminal session's: its processes, the conversations its agents held, its workspace in RUSH.
            evidence = await in_thread(handle.evidence)
            await self._record_processes(emit, evidence, lambda wall: wall - offset, commands.outcomes)
            recorded.append(True)
            held = chats.report(chats.talked(restored, await in_thread(chats.read, handle.workspace)), offset)
            uploaded = await self._upload_workspace(job, handle, work / "workspace.tar.zst")
            if job.free_form:  # no case: the member ended the session (by its last exit, Stop or leaving its page), and nothing scores it
                kept = await self._keep_session(job, handle)
                if lease.reason == "canceled":
                    return await self._finalize(job, journal, "canceled", None, result=AttemptResult("canceled"), kept=kept, held=held, uploaded=uploaded)
                timed_out = outcome.termination.kind is TerminationKind.TIMED_OUT  # it ran to the session's wall time
                return await self._finalize(job, journal, "ended", "timed_out" if timed_out else None, kept=kept, held=held, uploaded=uploaded)
            if snapshot is None:
                case_outcome = {"status": "execution_failed", "reason": "invalid_result"}
                frozen = work / "overflow"  # the verifier gets an empty workspace: nothing was frozen
                frozen.mkdir()
            else:
                case_outcome = await self._read_outcome(outcome.termination, job, snapshot.directory, snapshot.skipped)
                frozen = snapshot.directory
            status = case_outcome["status"]
            await emit.emit(rec.ResultRead(case_outcome))
            verdict = await self._verify(manifest, job, case_outcome, frozen, evidence)
            if verdict is not None:
                await emit.emit(rec.Verdict(verdict.get("verdict"), verdict.get("explanation"), verdict.get("checks"), verdict.get("verifier_error")))
            reason = case_outcome.get("reason") if status == "execution_failed" else None
            return await self._finalize(job, journal, status, reason, verdict=verdict, held=held, uploaded=uploaded)
        except (LeaseLost, Canceled, Sealed):
            raise
        except Exception:
            if not recorded:
                await self._record_fault_evidence(emit, handle, lambda wall: wall - offset, commands.outcomes)
            raise

    @staticmethod
    async def _every(seconds: float, work: Callable[[], Awaitable[None]]) -> None:
        while True:
            await anyio.sleep(seconds)
            await work()

    async def _live_spans(
        self, job: AttemptJob, journal: RushJournal, handle: CaseHandle, to_monotonic_ns: Callable[[int], int], commands: Sequence[ExecOutcome], sent: list[tuple[int, int]],
    ) -> None:
        """Sends a running free-form session's trace so far to RUSH: the journal's records (its model calls, as they come) with the
        processes the tracer has written so far (not journaled: the session's end records them, whole), projected as the end projects
        them, so each span keeps its id and the end's upload fills what this one lacked. The Dashboard reads them to name the agents
        working and their chats. Nothing is sent when nothing changed; a read or projection that fails waits for the next."""
        try:
            evidence = await in_thread(handle.live_evidence)
            if evidence is None:
                return
            seen = (journal.high_water, len(evidence.events))
            if sent and sent[-1] == seen:
                return
            facts, times = process_facts(evidence, to_monotonic_ns, commands)
            records = [*journal.records, *Emitter(journal, self.clock_ns).records(facts, occurred_ns=times)]
            projection = self.project(records, dict(journal.payloads), dict(journal.redactions))
            for request in projection.spans_requests(job.fence):
                await self.worker.spans(job.attempt_id, request)
            sent[:] = [seen]
        except (LeaseLost, Canceled, Sealed):
            raise
        except Exception as error:
            LOG.warning("attempt %s: its trace so far did not reach RUSH: %s: %s", job.attempt_id, type(error).__name__, error)

    async def _keep_session(self, job: AttemptJob, handle: CaseHandle) -> tuple[bool, list[str]]:
        """Keeps the ended free-form session's workspace on this computer to resume: whether it was kept, and the older sessions that
        went to make room (RUSH learns only those)."""
        kept, evicted = await in_thread(keep, self.config.scratch, job.attempt_id, handle.workspace, datetime.now(timezone.utc), self.config.resume_bytes)
        LOG.info("attempt %s: %s", job.attempt_id, "kept to resume" if kept else "not kept to resume: larger than resume_bytes")
        return kept, evicted

    async def _upload_workspace(self, job: AttemptJob, handle: CaseHandle, archive: Path) -> dict:
        """Uploads the ended free-form session's workspace to RUSH (nanoagent.uploaded.workspace_upload) and returns finalize's
        ``workspace``: what was uploaded, or ``{error}``, why nothing was: an archive over ``workspace_upload_bytes``, a file it could not
        read, or RUSH refusing it (in the 500 characters RUSH keeps of it)."""
        try:
            await in_thread(pack, handle.workspace, archive, self.config.workspace_upload_bytes)
            try:
                uploaded = await upload(self.worker, job.attempt_id, job.fence, archive)
            finally:
                archive.unlink()
        except TooLarge:
            error = f"its files are larger than the {self.config.workspace_upload_bytes / (1 << 20):g} MB a session uploads, compressed"
        except OSError as failure:
            error = f"its files could not be packed: {failure}"
        except RushError as failure:
            error = f"RUSH refused it: {failure.message}"
        else:
            LOG.info("attempt %s: workspace uploaded (%d bytes)", job.attempt_id, uploaded["bytes"])
            return uploaded
        LOG.warning("attempt %s: workspace not uploaded: %s", job.attempt_id, error)
        return {"error": error[:500]}

    async def _record_fault_evidence(self, emit: Emitter, handle: CaseHandle, to_monotonic_ns: Callable[[int], int], commands: Sequence[ExecOutcome]) -> None:
        """After a platform fault: stop the case and commit the process evidence the collector has, so the interrupted
        attempt keeps it. A failure here is logged and does not replace the fault being handled."""
        try:
            await in_thread(handle.close)
            await self._record_processes(emit, await in_thread(handle.evidence), to_monotonic_ns, commands)
        except Exception:
            LOG.exception("the process evidence of the faulted case could not be recorded")

    def _request(self, job: AttemptJob, dialects: Sequence[str], base: str) -> dict[str, Any]:
        """The harness's request: a case's prompt and name, nothing of its arguments, schemas, reference or verifier."""
        run, task, case = job.run, job.task, job.case
        request = {
            "protocol": "rush.harness.v1",
            "attempt_id": job.attempt_id,
            "task": None if task is None else {key: task[key] for key in ("id", "kind", "description", "plugin_name")},
            "free_form": job.free_form,
            "case": None if case is None else {"case_id": case["case_id"]},
            "prompt": None if case is None else {"system": answer_instructions(task), "user": case["prompt"], "sha256": case["prompt_sha256"]},
            "harness": None if job.free_form else run["harness"],
            "workspace": WORKSPACE,
            "openrouter": {"base_url": f"{base}/api/v1", "model": run["model"], "dialects": list(dialects)},
            "tools": {
                "url": f"{base}/tools",
                "available": [],  # the plugin's tools are the session's `nanoagent`'s alone, started when it asks (`/tools/start`)
            },
            "exec_url": f"{base}/exec",
            "events_url": f"{base}/events",
            "limits": dict(run["limits"]),
            "interactive": run["interactive"],
        }
        validate("Request", request)
        return request

    async def _late_tools(self, late: LateTools, job: AttemptJob, work: Path, handle: CaseHandle, services: AttemptServices, prepared: PluginManifest | None, emit: Emitter) -> None:
        """Once the session's `nanoagent` asks (`late.asked`): the first task of the session's plugin, as RUSH opens it on the member's
        computer, its plugin prepared (`_plugin`), its tool VM booted beside the case and its tools' session open until the session ends,
        served by the broker to the token handed to that `nanoagent` alone. Why they could not come up answers each ask instead."""
        await late.asked.wait()
        try:
            if prepared is None:  # a free-form session's: the first task of the plugin whose page opened it
                opened = await self.worker.tools(job.attempt_id, job.fence)
                task = opened["task"]
                manifest = await in_thread(self._plugin, opened["plugin"], base64.b64decode(opened["package"]), work, True)
            else:  # a case's: its own task, the plugin it fetched to verify
                task, manifest = job.task, prepared
            name = f"rush-tool-{job.attempt_id}-{secrets.token_hex(4)}"
            await in_thread(self.supervisor.attach_tool, handle, ToolContainerSpec(name, manifest.root, None, tuple(task["egress_hosts"])))
            await emit.emit(rec.ToolsStarted(list(task["egress_hosts"])))  # attempt.started is long past: the hosts and the broker are recorded now
            names = tuple(tool["name"] for tool in task["tools"])
            runner = self.plugins.tool_runner(manifest, Path(WORKSPACE), names, self.supervisor.tool_launcher(name))
            async with runner:
                token = secrets.token_urlsafe(32)
                policies = tuple(ToolPolicy(tool["name"], bool(tool["writes"]), tool["input_schema"], tool["output_schema"]) for tool in task["tools"])
                services.broker.serve(policies, runner, token)
                late.started = {
                    "token": token,
                    "system": tools_prompt(task["plugin_name"], task["description"], manifest.task(task["id"]).instructions),
                    "tools": [{key: tool[key] for key in ("name", "description", "input_schema", "output_schema")} for tool in task["tools"]],
                }
                late.up.set()
                LOG.info("attempt %s: plugin tools up for nanoagent", job.attempt_id)
                await anyio.sleep_forever()
        except Exception as error:
            LOG.warning("attempt %s: the plugin's tools could not start: %s", job.attempt_id, error)
            late.error = error.message if isinstance(error, RushError) else f"{type(error).__name__}: {error}"
            if prepared is not None:
                raise  # a case's tools are the platform's, not the harness's: the attempt ends as a platform fault (`run`), unscored; a session's member sees why from each ask
        finally:
            late.up.set()

    async def _wait(
        self, lease: Lease, handle: CaseHandle, services: AttemptServices, terminal: Terminal, *, interactive: bool, free_form: bool,
        live: Callable[[], Awaitable[None]] | None = None,
    ) -> Any:
        """The case's outcome, or None if the lease was lost or canceled first (the case is killed and drained). A free-form session's
        cancel is how its member ends it (Stop, leaving its page, opening another): its case ends as at an exit, so its outcome comes,
        and it is recorded as one that exited is. The harness's terminal output goes to RUSH as it comes meanwhile, and, when someone is
        at it, to their page over the session's link (RUSH told where), which brings back what they type; ``live``, when given, runs
        every LIVE_SPANS_S meanwhile."""
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
            if live is not None:
                group.start_soon(self._every, LIVE_SPANS_S, live)
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

    async def _read_outcome(self, termination: Termination, job: AttemptJob, workspace: Path, skipped: Mapping[str, str]) -> dict[str, Any]:
        """The attempt's outcome. A harness that did not exit cleanly is an execution failure and its workspace is not read; otherwise the
        outcome seam (nanoagent.uploaded.outcome) reads the frozen workspace."""

        def failed(reason: str) -> dict[str, Any]:
            return {"status": "execution_failed", "reason": reason}

        match termination.kind:
            case TerminationKind.TIMED_OUT:
                return failed("timed_out")
            case TerminationKind.SIGNALED:
                return failed("signaled")
            case TerminationKind.NONZERO_EXIT:
                return failed("nonzero_exit")
            case TerminationKind.EXITED if termination.exit_code:
                return failed("nonzero_exit")
        result = await in_thread(read_outcome, workspace, {"skipped": skipped}, job.case, answer_skeleton(job.task["output_schema"]))
        if result["status"] == "execution_failed":
            LOG.info("attempt %s: its workspace holds no usable result: %s", job.attempt_id, result["reason"])
        return result

    async def _record_processes(self, emit: Emitter, evidence: ProcessEvidence, to_monotonic_ns: Callable[[int], int], commands: Sequence[ExecOutcome]) -> None:
        await emit.emit(rec.CollectorHealth(evidence.complete, list(evidence.loss_reasons), evidence.frames, evidence.dropped))
        facts, times = process_facts(evidence, to_monotonic_ns, commands)
        await emit.emit_many(facts, times)

    async def _verify(
        self, manifest: PluginManifest, job: AttemptJob, outcome: dict[str, Any], workspace: Path, evidence: ProcessEvidence
    ) -> dict[str, Any] | None:
        """The plugin verifier's verdict on the frozen outcome, or None when the score stays unavailable. The verifier is called once, and
        never for an execution failure, which is a failed case without it. An answered answer case is judged by `verify_task` itself, whose
        named checks (names and statuses, never messages or values) go with the verdict; a refusal, an answered refusal case and an
        answer of the wrong shape are decided by `verify_task_verifier_case`, which runs no plugin code for them."""
        if outcome["status"] == "execution_failed":
            losses = set(evidence.loss_reasons)
            if "journal_overflow" in losses:
                losses -= {"journal_overflow", "root_exit_missing"}  # overflow can drop the root exit too; neither may unscore the harness's crash
            if outcome["reason"] in ("nonzero_exit", "signaled") and not evidence.complete and losses:
                return None  # the exit could not be observed reliably for a reason independent of the harness's journal overflow
            return {"verdict": "fail", "explanation": "execution_failed", "checks": None}
        reference = job.private_reference
        arguments = dict(job.case["arguments"])
        try:
            if outcome["status"] == "answered" and not isinstance(reference, str) and await in_thread(self._fits, manifest, job, outcome["answer"]):
                verification = await in_thread(self.verify_task, manifest, job.task["id"], arguments, outcome["answer"], reference, workspace)
                return {"verdict": "pass" if verification.valid else "fail", "explanation": None, "checks": checks_of(verification.details)}
            verdict = await in_thread(self.verify_task_case, manifest, job.task["id"], arguments, outcome, reference, workspace)
        except (VerifierError, RuntimeError, ValueError, TypeError, subprocess.TimeoutExpired) as error:
            LOG.warning("verifier of %s: %s", job.attempt_id, error)
            # Private: the verifier's diagnostics stay in the worker log; the attempt only learns that it errored.
            return {"verifier_error": "verifier_error"}
        return {"verdict": verdict.verdict, "explanation": verdict.explanation, "checks": None}

    @staticmethod
    def _fits(manifest: PluginManifest, job: AttemptJob, answer: Mapping[str, Any]) -> bool:
        """Whether ``answer`` builds into the task's output class (a wrong shape is `invalid_answer`, decided without the plugin)."""
        try:
            build_output(answer, manifest.task(job.task["id"]).output_type)
        except (TypeError, ValueError):
            return False
        return True

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
        return coverage, projection.metrics.to_dict()

    async def _finalize(
        self, job: AttemptJob, journal: RushJournal, status: str, reason: str | None, *, verdict: Mapping[str, Any] | None = None,
        result: AttemptResult | None = None, kept: tuple[bool, list[str]] | None = None, held: list[dict] | None = None, uploaded: dict | None = None,
    ) -> AttemptResult:
        """Seals the attempt. For a free-form session that ran: ``kept``, whether this computer kept it to resume and the older sessions
        that went to make room (``resumable``, ``evicted``), ``held``, the conversations its agents held (chats.report), and
        ``uploaded``, its workspace's archive in RUSH or why it is not there (``workspace``)."""
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
            if verdict.get("checks") is not None:  # left out with none: the server reads a null as a malformed list (validate.js finalizeBody)
                body["checks"] = verdict["checks"]
        if kept is not None:
            body |= {"resumable": kept[0], "evicted": kept[1]}
        if held is not None:
            body |= {"chats": held, "workspace": uploaded}
        await self.worker.finalize(job.attempt_id, body)
        journal.close()
        return result or AttemptResult("finalized", {"status": status, "reason": reason})
