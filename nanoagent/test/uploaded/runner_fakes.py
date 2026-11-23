"""In-memory doubles for the attempt runner: the RUSH worker API, the sandbox supervisor and its case handle."""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import shutil
import tarfile
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio
from rush_rules import Invalid, check_finalize
from nanoagent.plugin.manifest import load_manifest
from nanoagent.uploaded.collector import ProcessEvidence
from nanoagent.uploaded.rush_worker import Canceled, LeaseLost, RushError, Sealed, parse_job
from nanoagent.uploaded.sandbox import BuildArtifact, CaseOutcome, SandboxError, Termination, TerminationKind, WorkspaceSnapshot

PROBE = Path(__file__).resolve().parents[1] / "plugins" / "acceptance-probe"
ANSWER = json.dumps({"digest": "abcdefabcdef"}).encode()  # what a harness leaves in answer.json: an answer of the probe task's output class
PLUGIN_SHA = "a" * 64
PROMPT = "Task\nreport the digest of the token alpha\n"
ATTEMPT_ID = "22222222-2222-4222-8222-222222222222"


def fixtures_archive(files: dict[str, bytes]) -> tuple[bytes, dict[str, str]]:
    """A gzipped tar of ``files`` as the server serves a case's fixtures, and the `{path: sha256}` the claim lists for it."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tar:
        for name, data in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(buffer.getvalue(), mtime=0), {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}


LIMITS = {
    "wall_time_ms": 60000, "max_model_calls": 5, "max_output_tokens_per_call": 100, "max_cost_usd": 1.0, "internet_access": False,
    "cpus": 1.0, "memory_mb": 1024, "pids": 256, "workspace_bytes": 268435456, "workspace_files": 20000, "tmp_bytes": 67108864, "build_wall_ms": 600000,
    "build_memory_mb": 3072, "build_output_bytes": 1 << 30, "build_files": 100000, "build_tmp_bytes": 512 << 20,
}
# What the test worker advertises: at least every default limit, internet access included.
CAPABILITIES = {**LIMITS, "wall_time_ms": 600000, "internet_access": True, "concurrency": 4, "interactive_slots": 1}
WAIT_TOOL = {"name": "wait", "description": "wait a while", "input_schema": {"type": "object"}, "output_schema": {"type": "object"}, "writes": False}


def job_body(limits: dict[str, Any] | None = None, tools: list[dict[str, Any]] | None = None, harness: str = "claude", **overrides: Any) -> dict[str, Any]:
    body = {
        "kind": "attempt", "attempt_id": ATTEMPT_ID, "attempt_no": 1, "fence": 1, "lease_expires_at": "later", "lease_seconds": 60,
        "run": {
            "run_id": "r", "harness": harness, "model": "test/model", "endpoint_profile": "mock", "limits": {**LIMITS, **(limits or {})},
            "interactive": False, "prompt_bound": True, "providers": ["mock-provider"],
        },
        "task": {
            "id": "probe", "kind": "agent", "description": "Wait, then digest a token", "input_schema": {"type": "object"}, "output_schema": {"type": "object"},
            "plugin_name": "Acceptance probe", "egress_hosts": ["api.example.com"], "tools": [] if tools is None else tools,
        },
        "case": {
            "case_id": "c1", "kind": "answer", "prompt": PROMPT, "prompt_sha256": "c" * 64, "arguments": {"token": "alpha", "wait_seconds": 0.0},
            "fixtures": None, "expected_error": None,
        },
        "plugin": {"id": "acceptance-probe", "name": "Acceptance probe", "version": "0.1.0", "sha256": PLUGIN_SHA},
        "private_reference": {"digest": "abcdefabcdef"},
        "free_form": False,
        "resume": None,
        "start": None,
    }
    body.update(overrides)
    return body


def job(**overrides: Any):
    return parse_job(job_body(**overrides))


def free_job(**overrides: Any):
    """A free-form Terminal session's job: someone at it, no task, case or reference, and of its plugin only the id."""
    body = job_body(**overrides)
    body["run"] |= {"harness": "shell", "interactive": True, "prompt_bound": False}  # a session of the Terminal runs the shell, whose agent is anyone's
    plugin = {"id": body["plugin"]["id"], "name": None, "version": None, "sha256": None}
    return parse_job({**body, "free_form": True, "task": None, "plugin": plugin, "case": None, "private_reference": None})


class StopPolling(Exception):
    """Raised by `FakeRush.claim` once it has no more jobs, to end a poll loop."""


class FakeRush:
    """The worker API: records everything, and loses the lease, cancels or seals on cue."""

    def __init__(self, fixtures: bytes | None = None) -> None:
        self.screen = b""  # what the harness wrote to its terminal (0)
        self.closed_terminals: list[int] = []
        self.links: list[tuple[int, str]] = []  # where each session's page reaches its terminals
        self.fixtures_bytes = fixtures  # what GET /attempts/{id}/fixtures answers
        self.events: list[dict[str, Any]] = []
        self.event_ids: set[str] = set()
        self.payloads: dict[str, bytes] = {}
        self.admissions: dict[str, float] = {}
        self.settles: list[tuple[str, str, float | None, dict[str, Any]]] = []
        self.span_bodies: list[dict[str, Any]] = []
        self.finalized: list[dict[str, Any]] = []
        self.accounting_calls: list[tuple[str, int, dict[str, Any]]] = []
        self.claims: list[Any] = []
        self.lost = False
        self.canceled = False
        self.sealed = False
        self.renews = 0
        self.lease_seconds = 60.0
        self.renew_error: Exception | None = None  # raised by every renewal, e.g. RushUnavailable
        self.renew_attempts = 0
        self.jobs: list[Any] = []  # what claim hands out, then StopPolling
        self.events_after_loss = 0
        self.packages = 0  # how many times the plugin package was fetched
        self.opened: list[str] = []  # the sessions whose `nanoagent` asked for the plugin's tools (POST /attempts/{id}/tools)
        self.tools_error: Exception | None = None  # what that answers instead, e.g. a RushError

    def _fenced(self) -> None:
        if self.sealed:
            raise Sealed(409, "sealed", "sealed")
        if self.lost:
            raise LeaseLost(409, "lease_lost", "lease lost")

    async def fixtures(self, attempt_id: str, fence: int) -> bytes:
        self._fenced()
        if self.fixtures_bytes is None:
            raise RushError(404, "no_fixtures", "The attempt's case has no fixtures")
        return self.fixtures_bytes

    async def package(self, attempt_id: str, fence: int) -> bytes:
        self.packages += 1
        return b"package"

    async def tools(self, attempt_id: str, fence: int) -> dict[str, Any]:
        self.opened.append(attempt_id)
        if self.tools_error is not None:
            raise self.tools_error
        task = {**job_body()["task"], "tools": [WAIT_TOOL]}
        return {"plugin": job_body()["plugin"], "task": task, "package": base64.b64encode(b"package").decode()}

    async def terminal_link(self, attempt_id: str, fence: int, port: int, token: str) -> None:
        self.links.append((port, token))

    async def watch(self, attempt_id: str, fence: int) -> None:
        await anyio.sleep(0.05)  # nothing happened: RUSH answers after holding the request

    async def claim(self, worker_id: str, label: str, mode: str, capabilities: Any, wait_s: float, *, interactive: bool) -> Any:
        self.claims.append(capabilities)
        if not self.jobs:
            await anyio.sleep(0.5)  # the attempts claimed so far run concurrently: let them finish before the poll loop is ended
            raise StopPolling
        mine = [job for job in self.jobs if bool(job.run.get("interactive")) is interactive]
        if not mine:  # the worker's other slots claim the rest
            await anyio.sleep(0.05)
            return None
        self.jobs.remove(mine[0])
        return mine[0]

    async def renew(self, attempt_id: str, fence: int) -> float:
        self.renew_attempts += 1
        if self.renew_error is not None:
            raise self.renew_error
        self._fenced()
        if self.canceled:
            raise Canceled(409, "canceled", "canceled")
        self.renews += 1
        return self.lease_seconds

    async def admit(self, attempt_id: str, fence: int, call_id: str, reserve_usd: float) -> None:
        self._fenced()
        if self.canceled:
            raise Canceled(409, "canceled", "canceled")
        self.admissions[call_id] = reserve_usd

    async def settle(self, attempt_id: str, call_id: str, outcome: str, cost_usd: float | None, provenance: dict[str, Any]) -> None:
        self.settles.append((call_id, outcome, cost_usd, dict(provenance)))  # allowed after the lease is lost

    async def append_events(self, attempt_id: str, fence: int, events: list[dict[str, Any]]) -> dict[str, Any]:
        if self.lost:
            self.events_after_loss += 1
        self._fenced()
        for event in events:
            if event["event_id"] not in self.event_ids:
                self.event_ids.add(event["event_id"])
                self.events.append(event)
        return {"receipts": [], "high_water_cursor": len(self.events)}

    async def put_payload(self, attempt_id: str, fence: int, sha256: str, data: bytes, redaction: str, content_type: str = "") -> None:
        self._fenced()
        self.payloads[sha256] = data

    async def terminal(self, attempt_id: str, fence: int, terminal: int, offset: int, data: bytes) -> None:
        self._fenced()
        assert terminal == 0 and offset == len(self.screen)
        self.screen += data

    async def terminal_closed(self, attempt_id: str, fence: int, terminal: int) -> None:
        self._fenced()
        self.closed_terminals.append(terminal)

    async def spans(self, attempt_id: str, body: dict[str, Any]) -> None:
        self._fenced()
        self.span_bodies.append(body)

    async def finalize(self, attempt_id: str, body: dict[str, Any]) -> dict[str, Any]:
        self._fenced()
        try:
            json.loads(json.dumps(body))  # as posted: the server reads JSON, so an undefined key and a null differ
            check_finalize(body)  # the server's rules (rush_rules.py, from validate.js finalizeBody)
        except Invalid as error:
            raise RushError(400, error.code, error.message) from error
        assert body["final_cursor_expected"] == len(self.events)
        self.finalized.append(body)
        self.sealed = True
        return {}

    async def accounting(self, attempt_id: str, call_id: str, version: int, record: dict[str, Any]) -> None:
        self.accounting_calls.append((call_id, version, record))

    def kinds(self) -> list[str]:
        return [event["kind"] for event in self.events]

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [event["data"] for event in self.events if event["kind"] == kind]


class FakeNetwork:
    def __init__(self, name: str, internet: bool = False) -> None:
        self.name = name
        self.internet = internet
        self.ports: list[int] = []


def evidence(complete: bool = True, reasons: tuple[str, ...] = ()) -> ProcessEvidence:
    return ProcessEvidence("c1", (), complete, reasons, 0, 0, 0, 0, 1, 0)


class StrictRush(FakeRush):
    """The worker API with RUSH's size limits (validate.js, limits.js, appendEvents): a 413 for an event whose data is over
    256 KiB, past `max_events` events in an attempt, or finalize coverage or metrics over 64 KiB."""

    MAX_EVENT_DATA_BYTES = 256 * 1024
    MAX_RESULT_BYTES = 64 * 1024

    def __init__(self, *args: Any, max_events: int = 100_000, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.max_events = max_events
        self.refusals: list[str] = []

    def _refuse(self, code: str, message: str) -> RushError:
        self.refusals.append(code)
        return RushError(413, "too_large", message)

    async def append_events(self, attempt_id: str, fence: int, events: list[dict[str, Any]]) -> dict[str, Any]:
        for event in events:
            if len(json.dumps(event["data"], separators=(",", ":"), ensure_ascii=False).encode()) > self.MAX_EVENT_DATA_BYTES:
                raise self._refuse(f"event_data {event['kind']}", "data is too large")
        if len(self.events) + len([event for event in events if event["event_id"] not in self.event_ids]) > self.max_events:
            raise self._refuse("too_many_events", "too many events")
        return await super().append_events(attempt_id, fence, events)

    async def finalize(self, attempt_id: str, body: dict[str, Any]) -> dict[str, Any]:
        for key in ("coverage", "metrics"):
            if len(json.dumps(body[key], separators=(",", ":"), ensure_ascii=False).encode()) > self.MAX_RESULT_BYTES:
                raise self._refuse(f"finalize {key}", f"{key} is too large")
        return await super().finalize(attempt_id, body)


@dataclass
class CaseScript:
    termination: Termination = field(default_factory=lambda: Termination(TerminationKind.EXITED, 0, None))
    evidence: ProcessEvidence = field(default_factory=evidence)
    block: bool = False  # wait() returns only once the case is closed
    cpu: list[dict[str, Any]] = field(default_factory=list)
    workspace: dict[str, bytes] = field(default_factory=lambda: {"answer.json": ANSWER})  # files the harness left in the workspace, as frozen
    drain_error: Exception | None = None  # raised by stop_and_drain, e.g. a workspace over its bound
    closed_wait: bool = False  # a blocked wait() woken by close() fails as the real sandbox's does
    made: dict[str, bytes] = field(default_factory=dict)  # files the shell makes in the case workspace as it starts


class FakeCase:
    container_id = "container-1"

    def __init__(self, script: CaseScript, workdir: Path, fixtures: Path | None = None) -> None:
        self.script = script
        self.released = threading.Event()
        self.closed = False
        self.launched = False
        self.drained = False
        self.ended = False
        self.workdir = workdir
        self.workspace = workdir / "workspace"
        self.workspace.mkdir(parents=True, exist_ok=True)
        if fixtures is not None:  # the case's files, seeded as MicrosandboxSupervisor._preload does
            shutil.copytree(fixtures, self.workspace, dirs_exist_ok=True)

    def _start(self) -> None:
        self.found = {path.relative_to(self.workspace).as_posix(): path.read_bytes() for path in self.workspace.rglob("*") if path.is_file()}
        for name, data in self.script.made.items():
            (self.workspace / name).parent.mkdir(parents=True, exist_ok=True)
            (self.workspace / name).write_bytes(data)

    def launch(self) -> None:
        self.launched = True
        self._start()

    def go(self, request_json: bytes, token: str) -> None:
        self.went = (json.loads(request_json), token)
        self._start()

    def cpu_counters(self) -> list[dict[str, Any]]:
        return list(self.script.cpu)

    def ended_terminals(self) -> frozenset[int]:
        return frozenset()

    def wait(self) -> CaseOutcome:
        if self.script.block:
            self.released.wait(30)
            if self.script.closed_wait and self.closed:
                raise SandboxError("closed", "the case was closed while it was awaited")
        return CaseOutcome(self.script.termination, 1.0, 2.0, b"", b"", False, False)

    def exec_in_case(self, argv: Any, cwd: str, timeout_ms: int, limits: Any) -> Any:
        raise SandboxError("exec_failed", "not scripted")

    def stop_and_drain(self) -> WorkspaceSnapshot:
        self.drained = True
        if self.script.drain_error is not None:
            raise self.script.drain_error
        directory = self.workdir / "snapshot"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "out.txt").write_text("made")
        for name, data in self.script.workspace.items():
            (directory / name).parent.mkdir(parents=True, exist_ok=True)
            (directory / name).write_bytes(data)
        # The sandbox's snapshot lists every file the harness left, session state (.rush/) included.
        state = sorted(name for name in self.script.workspace if name.startswith(".rush/"))
        files = {"out.txt": "d" * 64} | {name: "e" * 64 for name in state}
        return WorkspaceSnapshot(directory, files, ("out.txt", *state), (), (), {}, 4)

    def evidence(self) -> ProcessEvidence:
        return self.script.evidence

    def live_evidence(self) -> ProcessEvidence | None:
        return self.script.evidence

    def end(self) -> None:
        self.ended = True
        self.released.set()

    def close(self) -> None:
        self.closed = True
        self.released.set()


class FakeSupervisor:
    def __init__(self, tmp_path: Path, script: CaseScript | None = None, build_error: Exception | None = None, case_error: Exception | None = None) -> None:
        self.tmp_path = tmp_path
        self.case_error = case_error  # raised when the case (and its tool container) is created
        self.attach_error: Exception | None = None  # raised when the plugin's tool container is attached to a running case
        self.script = script or CaseScript()
        self.build_error = build_error
        self.builds = 0
        self.networks: list[FakeNetwork] = []
        self.case: FakeCase | None = None
        self.specs: list[Any] = []
        self.prepared: list[Path] = []
        self.attached: list[Any] = []
        self.probed: list[str] = []

    def create_network(self, attempt_id: str, *, internet: bool = False) -> FakeNetwork:
        self.networks.append(FakeNetwork(f"rush-net-{attempt_id}", internet))
        return self.networks[-1]

    def build(self, spec: Any) -> BuildArtifact:
        self.builds += 1
        if self.build_error:
            raise self.build_error
        (spec.workdir / "harness").mkdir(parents=True)  # where a build's artifact lands
        return BuildArtifact(spec.workdir / "harness", ("main.py",), "digest", b"", b"", 0.1)

    def create_case(self, spec: Any) -> FakeCase:
        self.specs.append(spec)
        if self.case_error is not None:
            raise self.case_error
        self.case = FakeCase(self.script, self.tmp_path, spec.fixtures)
        return self.case

    def prepare_plugin(self, root: Path, timeout_s: float) -> None:
        self.prepared.append(root)

    def attach_tool(self, case: Any, tool: Any) -> None:
        if self.attach_error is not None:
            raise self.attach_error
        self.attached.append(tool)

    def ready(self, profile: Any) -> None:
        self.probed.append(profile.id)

    def tool_launcher(self, name: str) -> str:
        return name


class FakeRelayHandle:
    base_url = "http://10.1.2.3:8080"

    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class FakeRelay:
    def __init__(self) -> None:
        self.app: Any = None
        self.handle = FakeRelayHandle()

    async def start(self, attempt_id: str, network: Any, app: Any, workdir: Path) -> FakeRelayHandle:
        self.app = app
        return self.handle


class FakeTools:
    """Holds a task group open while entered, as the plugin's MCP stdio session does: its cancel scope must unwind in order."""

    async def __aenter__(self) -> FakeTools:
        self._group = anyio.create_task_group()
        await self._group.__aenter__()
        return self

    async def __aexit__(self, *exc: object) -> None:
        self._group.cancel_scope.cancel()
        await self._group.__aexit__(*exc)

    async def run(self, name: str, arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
        return {"waited": 0.0}


class FakePlugins:
    def __init__(self) -> None:
        self.manifest = load_manifest(PROBE)

    def load(self, data: bytes, sha256: str, plugin_id: str, folder: Path) -> Any:
        return self.manifest

    def unpacked(self, root: Path) -> Any:
        return self.manifest

    def tool_runner(self, manifest: Any, workspace: Path, permitted: tuple[str, ...], launcher: Any) -> FakeTools:
        return FakeTools()


class _Dict:
    def __init__(self, value: dict[str, Any]) -> None:
        self._value = value

    def to_dict(self, unavailable: str | None = None) -> dict[str, Any]:
        return self._value


class FakeProjection:
    coverage = _Dict({"status": "complete"})
    metrics = _Dict({"total_tokens": 0})

    def spans_requests(self, fence: int) -> Iterator[dict[str, Any]]:
        yield {"fence": fence, "spans": [], "links": []}


def fake_project(records: list[dict[str, Any]], payloads: Any, redactions: Any) -> FakeProjection:
    return FakeProjection()
