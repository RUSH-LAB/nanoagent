"""The stored evidence record format shared by the worker (writer) and trace projection (reader).

Every record is ``{event_id, source, kind, sequence, occurred_ns, data, payload_sha256s}``. ``occurred_ns`` is on the
worker monotonic clock and may arrive as an int or a decimal string. The gateway, tool broker, exec and harness sources
are written by the attempt services (see ``evidence.py``); the worker and process sources are defined here.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any, ClassVar

WORKER = "worker"
PROCESS = "process"
GATEWAY = "gateway"
TOOL_BROKER = "tool_broker"
EXEC = "exec"
HARNESS = "harness"

ATTEMPT_STARTED = "attempt.started"
CASE_LAUNCHED = "case.launched"
CASE_EXITED = "case.exited"
CASE_QUIESCED = "case.quiesced"
SNAPSHOT_TAKEN = "snapshot.taken"
RESULT_READ = "result.read"
COLLECTOR_HEALTH = "collector.health"
CPU_COUNTERS = "cpu.counters"
PROCESS_CLONE = "process.clone"
PROCESS_EXEC = "process.exec"
PROCESS_EXIT = "process.exit"


class RecordError(ValueError):
    """A stored record that does not have the shared shape."""


@dataclass(frozen=True)
class Record:
    event_id: str
    source: str
    kind: str
    sequence: int
    occurred_ns: int
    data: Mapping[str, Any]
    payload_sha256s: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> Record:
        try:
            occurred = raw["occurred_ns"]
            if isinstance(occurred, bool) or not isinstance(occurred, (int, str)):
                raise RecordError(f"occurred_ns is not an int or decimal string: {occurred!r}")
            data = raw.get("data") or {}
            if not isinstance(data, Mapping):
                raise RecordError("data is not an object")
            return cls(str(raw["event_id"]), str(raw["source"]), str(raw["kind"]), int(raw["sequence"]), int(occurred), data, tuple(raw.get("payload_sha256s") or ()))
        except (KeyError, TypeError, ValueError) as error:
            raise RecordError(f"malformed record {raw.get('event_id') if isinstance(raw, Mapping) else raw!r}: {error!r}") from error

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "source": self.source,
            "kind": self.kind,
            "sequence": self.sequence,
            "occurred_ns": self.occurred_ns,
            "data": dict(self.data),
            "payload_sha256s": list(self.payload_sha256s),
        }


def _plain(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


class Fact:
    """A worker or process record body. ``to_data`` is the record's ``data`` object."""

    source: ClassVar[str]
    kind: ClassVar[str]

    def to_data(self) -> dict[str, Any]:
        return {key: _plain(value) for key, value in asdict(self).items() if value is not None}  # type: ignore[call-overload]


def make_record(item: Fact, *, event_id: str, sequence: int, occurred_ns: int, payload_sha256s: Sequence[str] = ()) -> dict[str, Any]:
    return {
        "event_id": event_id,
        "source": item.source,
        "kind": item.kind,
        "sequence": sequence,
        "occurred_ns": occurred_ns,
        "data": item.to_data(),
        "payload_sha256s": list(payload_sha256s),
    }


@dataclass(frozen=True)
class AttemptStarted(Fact):
    """``endpoint`` is ``{label, mode}``, ``timing`` is ``{reference_tokens_per_second, clock_tolerance_ns}``, ``policy`` is
    the run's participant policy, ``limits`` its effective limits (``internet_access`` among them) and ``egress_hosts``
    the HTTPS hosts the task tools' plugin may reach, as applied (None under ``coding``, which has no tool container)."""

    source: ClassVar[str] = WORKER
    kind: ClassVar[str] = ATTEMPT_STARTED
    attempt_id: str
    worker_id: str
    endpoint: Mapping[str, Any]
    model: str
    dialects: Sequence[str]
    prompt_sha256: str
    policy: str
    toolchain: Any
    source_sha256: str
    harness_revision: str
    limits: Mapping[str, Any]
    egress_hosts: Sequence[str] | None
    timing: Mapping[str, Any]
    expected_sources: Sequence[str]


@dataclass(frozen=True)
class CaseLaunched(Fact):
    source: ClassVar[str] = WORKER
    kind: ClassVar[str] = CASE_LAUNCHED
    container_id: str
    launch_ns: int
    argv: Sequence[str]


@dataclass(frozen=True)
class CaseExited(Fact):
    """``termination`` is ``{status, exit_code | signal}``."""

    source: ClassVar[str] = WORKER
    kind: ClassVar[str] = CASE_EXITED
    termination: Mapping[str, Any]
    exit_ns: int


@dataclass(frozen=True)
class CaseQuiesced(Fact):
    source: ClassVar[str] = WORKER
    kind: ClassVar[str] = CASE_QUIESCED
    quiesced_ns: int


@dataclass(frozen=True)
class SnapshotTaken(Fact):
    """``diff`` entries are ``{path, change: added | modified | deleted, sha256?, size?}``."""

    source: ClassVar[str] = WORKER
    kind: ClassVar[str] = SNAPSHOT_TAKEN
    diff: Sequence[Mapping[str, Any]]
    payload_sha256: str


@dataclass(frozen=True)
class ResultRead(Fact):
    """``outcome`` is ``{status, answer | reason}``."""

    source: ClassVar[str] = WORKER
    kind: ClassVar[str] = RESULT_READ
    outcome: Mapping[str, Any]


@dataclass(frozen=True)
class CollectorHealth(Fact):
    source: ClassVar[str] = WORKER
    kind: ClassVar[str] = COLLECTOR_HEALTH
    complete: bool
    loss_reasons: Sequence[str]
    frames: int
    reported_drops: int


@dataclass(frozen=True)
class CpuCounters(Fact):
    """``processes`` entries are ``{identity, user_ns, system_ns}``."""

    source: ClassVar[str] = WORKER
    kind: ClassVar[str] = CPU_COUNTERS
    processes: Sequence[Mapping[str, Any]]


@dataclass(frozen=True)
class ProcessClone(Fact):
    """The child is ``(tgid, start_time)``; ``time_ns`` is on the worker monotonic clock."""

    source: ClassVar[str] = PROCESS
    kind: ClassVar[str] = PROCESS_CLONE
    tgid: int
    start_time: int
    parent_tgid: int
    parent_start_time: int
    time_ns: int


@dataclass(frozen=True)
class ProcessExec(Fact):
    source: ClassVar[str] = PROCESS
    kind: ClassVar[str] = PROCESS_EXEC
    tgid: int
    start_time: int
    argv: Sequence[str]
    cwd: str
    time_ns: int
    launch_id: str | None = None


@dataclass(frozen=True)
class ProcessExit(Fact):
    source: ClassVar[str] = PROCESS
    kind: ClassVar[str] = PROCESS_EXIT
    tgid: int
    start_time: int
    time_ns: int
    exit_code: int | None = None
    signal: int | None = None
