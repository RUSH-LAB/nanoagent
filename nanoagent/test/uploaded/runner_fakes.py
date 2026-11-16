"""In-memory doubles for the attempt runner: the RUSH worker API, the sandbox supervisor and its case handle."""

from __future__ import annotations

import io
import json
import threading
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio
from nanoagent.plugin.manifest import load_manifest
from nanoagent.uploaded.collector import ProcessEvidence
from nanoagent.uploaded.rush_worker import Canceled, LeaseLost, Sealed, parse_job
from nanoagent.uploaded.sandbox import BuildArtifact, CaseOutcome, SandboxError, Termination, TerminationKind, WorkspaceSnapshot

PROBE = Path(__file__).resolve().parents[1] / "plugins" / "acceptance-probe"
ANSWER = json.dumps({"protocol": "rush.harness.v1", "status": "answered", "answer": {"sum": 3}}).encode()
OUTPUT_SCHEMA = {"type": "object", "required": ["sum"], "properties": {"sum": {"type": "integer"}}, "additionalProperties": False}
PLUGIN_SHA = "a" * 64
PROMPT = "Task\nsum the numbers\n"
ATTEMPT_ID = "22222222-2222-4222-8222-222222222222"


def source_zip(toolchain: str = "python-3", manifest: bool = True) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        if manifest:
            archive.writestr(
                "harness.yaml",
                f"protocol: rush.harness.v1\nname: h\nversion: '1'\ndialects: [chat_completions]\ntoolchain: {toolchain}\nlockfiles: []\nbuild:\n  argv: [sh, -c, cp main.py /build-out/main.py]\n  outputs: [main.py]\nrun:\n  argv: [python, /harness/main.py]\n",
            )
        archive.writestr("main.py", "print('hi')\n")
    return buffer.getvalue()


LIMITS = {
    "wall_time_ms": 60000, "max_model_calls": 5, "max_output_tokens_per_call": 100, "max_cost_usd": 1.0, "internet_access": False,
    "cpus": 1.0, "memory_mb": 1024, "pids": 256, "workspace_bytes": 268435456, "workspace_files": 20000, "tmp_bytes": 67108864, "build_wall_ms": 600000,
    "build_memory_mb": 3072, "build_output_bytes": 1 << 30, "build_files": 100000, "build_tmp_bytes": 512 << 20,
}
# What the test worker advertises: at least every default limit, internet access included.
CAPABILITIES = {**LIMITS, "wall_time_ms": 600000, "internet_access": True, "concurrency": 4}
WAIT_TOOL = {"name": "wait", "description": "wait a while", "input_schema": {"type": "object"}, "output_schema": {"type": "object"}, "writes": False}


def job_body(policy: str = "task_tools", limits: dict[str, Any] | None = None, tools: list[dict[str, Any]] | None = None, **overrides: Any) -> dict[str, Any]:
    body = {
        "kind": "attempt", "attempt_id": ATTEMPT_ID, "attempt_no": 1, "fence": 1, "lease_expires_at": "later", "lease_seconds": 60,
        "run": {
            "run_id": "r", "model": "test/model", "endpoint_profile": "mock", "dialects": ["chat_completions"], "source_sha256": "b" * 64,
            "policy": policy, "limits": {**LIMITS, **(limits or {})},
        },
        "task": {
            "id": "probe", "kind": "agent", "description": "Sum the numbers.", "instructions": "Be exact.", "plugin_name": "Acceptance probe",
            "egress_hosts": ["api.example.com"], "tools": [] if tools is None else tools,
        },
        "case": {
            "case_id": "c1", "position": 0, "kind": "answer", "arguments": {"token": "alpha", "wait_seconds": 0.0}, "context": "numbers", "input_schema": {"type": "object"},
            "output_schema": OUTPUT_SCHEMA, "content_digest": "e" * 64,
        },
        "prompt": {"system": None, "user": PROMPT, "sha256": "c" * 64},
        "plugin": {"id": "acceptance-probe", "name": "Acceptance probe", "version": "0.1.0", "sha256": PLUGIN_SHA},
        "case_set": {"case_set_id": "probe@1", "digest": "f" * 64},
        "private_reference": {"digest": "x"},
    }
    body.update(overrides)
    return body


def job(**overrides: Any):
    return parse_job(job_body(**overrides))


class StopPolling(Exception):
    """Raised by `FakeRush.claim` once it has no more jobs, to end a poll loop."""


class FakeRush:
    """The worker API: records everything, and loses the lease, cancels or seals on cue."""

    def __init__(self, source: bytes | None = None) -> None:
        self.source_bytes = source if source is not None else source_zip()
        self.events: list[dict[str, Any]] = []
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

    def _fenced(self) -> None:
        if self.sealed:
            raise Sealed(409, "sealed", "sealed")
        if self.lost:
            raise LeaseLost(409, "lease_lost", "lease lost")

    async def source(self, attempt_id: str, fence: int) -> bytes:
        return self.source_bytes

    async def package(self, attempt_id: str, fence: int) -> bytes:
        return b"package"

    async def claim(self, worker_id: str, label: str, mode: str, capabilities: Any) -> Any:
        self.claims.append(capabilities)
        if not self.jobs:
            await anyio.sleep(0.5)  # the attempts claimed so far run concurrently: let them finish before the poll loop is ended
            raise StopPolling
        return self.jobs.pop(0)

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
        known = {event["event_id"]: event for event in self.events}
        for event in events:
            if event["event_id"] not in known:
                self.events.append(event)
        return {"receipts": [], "high_water_cursor": len(self.events)}

    async def put_payload(self, attempt_id: str, fence: int, sha256: str, data: bytes, redaction: str, content_type: str = "") -> None:
        self._fenced()
        self.payloads[sha256] = data

    async def spans(self, attempt_id: str, body: dict[str, Any]) -> None:
        self._fenced()
        self.span_bodies.append(body)

    async def finalize(self, attempt_id: str, body: dict[str, Any]) -> dict[str, Any]:
        self._fenced()
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
        self.removed = False

    def remove(self) -> None:
        self.removed = True


def evidence(complete: bool = True, reasons: tuple[str, ...] = ()) -> ProcessEvidence:
    return ProcessEvidence("c1", (), complete, reasons, 0, 0, 0, 0, 1, 0)


@dataclass
class CaseScript:
    termination: Termination = field(default_factory=lambda: Termination(TerminationKind.EXITED, 0, None))
    result: bytes | Exception = ANSWER
    evidence: ProcessEvidence = field(default_factory=evidence)
    block: bool = False  # wait() returns only once the case is closed
    cpu: list[dict[str, Any]] = field(default_factory=list)
    workspace: dict[str, bytes] = field(default_factory=dict)  # files the harness left in the workspace, as frozen


class FakeCase:
    container_id = "container-1"

    def __init__(self, script: CaseScript, workdir: Path) -> None:
        self.script = script
        self.released = threading.Event()
        self.closed = False
        self.launched = False
        self.drained = False
        self.workdir = workdir

    def launch(self) -> None:
        self.launched = True

    def cpu_counters(self) -> list[dict[str, Any]]:
        return list(self.script.cpu)

    def wait(self) -> CaseOutcome:
        if self.script.block:
            self.released.wait(30)
        return CaseOutcome(self.script.termination, 1.0, 2.0, b"", b"", False, False)

    def exec_in_case(self, argv: Any, cwd: str, timeout_ms: int, limits: Any) -> Any:
        raise SandboxError("exec_failed", "not scripted")

    def stop_and_drain(self) -> WorkspaceSnapshot:
        self.drained = True
        directory = self.workdir / "snapshot"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "out.txt").write_text("made")
        for name, data in self.script.workspace.items():
            (directory / name).write_bytes(data)
        return WorkspaceSnapshot(directory, {"out.txt": "d" * 64}, ("out.txt",), (), (), {}, 4)

    def read_result(self) -> bytes:
        if isinstance(self.script.result, Exception):
            raise self.script.result
        return self.script.result

    def evidence(self) -> ProcessEvidence:
        return self.script.evidence

    def close(self) -> None:
        self.closed = True
        self.released.set()


class FakeSupervisor:
    def __init__(self, tmp_path: Path, script: CaseScript | None = None, build_error: Exception | None = None, case_error: Exception | None = None) -> None:
        self.tmp_path = tmp_path
        self.case_error = case_error  # raised when the case (and its tool container) is created
        self.script = script or CaseScript()
        self.build_error = build_error
        self.builds = 0
        self.networks: list[FakeNetwork] = []
        self.case: FakeCase | None = None
        self.specs: list[Any] = []
        self.prepared: list[Path] = []

    def create_network(self, attempt_id: str, *, internet: bool = False) -> FakeNetwork:
        self.networks.append(FakeNetwork(f"rush-net-{attempt_id}", internet))
        return self.networks[-1]

    def build(self, spec: Any) -> BuildArtifact:
        self.builds += 1
        if self.build_error:
            raise self.build_error
        return BuildArtifact(self.tmp_path, ("main.py",), "digest", b"", b"", 0.1)

    def create_case(self, spec: Any) -> FakeCase:
        self.specs.append(spec)
        if self.case_error is not None:
            raise self.case_error
        self.case = FakeCase(self.script, self.tmp_path)
        return self.case

    def prepare_plugin(self, root: Path, timeout_s: float) -> None:
        self.prepared.append(root)

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

    def spans_request(self, fence: int) -> dict[str, Any]:
        return {"fence": fence, "spans": [], "links": []}


def fake_project(records: list[dict[str, Any]], payloads: Any, redactions: Any) -> FakeProjection:
    return FakeProjection()
