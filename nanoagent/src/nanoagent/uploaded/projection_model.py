"""Typed results of trace projection."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from nanoagent.uploaded.timing import TimingMethod, TimingReport
from nanoagent.uploaded.usage import NormalizedUsage, UsageAggregate

PARSER_VERSION = "uploaded-projection/1"
TIMING_METHOD_ID = "rush-timing/1"
OBSERVED = "observed"
HARNESS_REPORTED = "harness_reported"


@dataclass(frozen=True)
class Issue:
    code: str
    message: str
    evidence: tuple[str, ...] = ()
    severity: str = "warning"  # info | warning | error


@dataclass(frozen=True)
class Rejection:
    source: str
    kind: str
    code: str
    message: str
    evidence: tuple[str, ...]


@dataclass(frozen=True)
class Proposal:
    tool_call_id: str | None
    name: str
    arguments: Mapping[str, Any] | None
    raw_arguments: str
    arguments_error: str | None
    frame_index: int | None
    registered_ns: int | None
    early: bool


@dataclass(frozen=True)
class ModelCall:
    call_id: str
    dialect: str | None
    span_ref: str | None
    model: str | None
    stream: bool
    ordinal: int | None
    admitted_ns: int | None
    dispatched_ns: int | None
    first_byte_ns: int | None
    completed_ns: int | None
    terminal: str | None
    http_status: int | None
    maybe_reached: bool | None
    usage: NormalizedUsage | None
    usage_error: str | None
    proposals: tuple[Proposal, ...]
    submitted_sha256: str | None
    effective_sha256: str | None
    frames_sha256: str | None
    frame_count: int | None
    response_sha256: str | None
    response_id: str | None
    generation_id: str | None
    resolved_model: str | None
    provider: str | None
    finish_reason: str | None
    error: Any
    rejected: Mapping[str, Any] | None
    evidence: tuple[str, ...]
    parser_version: str = PARSER_VERSION


@dataclass(frozen=True)
class ToolInvocation:
    call_id: str
    tool: str | None
    writes: bool | None
    span_ref: str | None
    cause: Mapping[str, str] | None
    adapted: bool
    adaptation: Mapping[str, Any] | None
    arguments_sha256: str | None
    output_sha256: str | None
    start_ns: int | None
    end_ns: int | None
    ok: bool | None
    error: Mapping[str, Any] | None
    rejected: Mapping[str, Any] | None
    evidence: tuple[str, ...]
    parser_version: str = PARSER_VERSION


@dataclass(frozen=True)
class Command:
    request_id: str
    launch_id: str | None
    span_ref: str | None
    argv: tuple[str, ...] | None
    cwd: str | None
    start_ns: int | None
    end_ns: int | None
    ok: bool | None
    termination: Mapping[str, Any] | None
    stdout_sha256: str | None
    stderr_sha256: str | None
    stdout_truncated: bool
    stderr_truncated: bool
    error: Mapping[str, Any] | None
    rejected: Mapping[str, Any] | None
    evidence: tuple[str, ...]
    parser_version: str = PARSER_VERSION


Identity = tuple[int, int]  # (tgid, start_time)


@dataclass(frozen=True)
class ProcessInfo:
    identity: Identity
    parent: Identity | None
    argv: tuple[str, ...] | None
    cwd: str | None
    launch_id: str | None
    start_ns: int | None
    end_ns: int | None
    exit_code: int | None
    signal: int | None
    evidence: tuple[str, ...]
    parser_version: str = PARSER_VERSION


@dataclass(frozen=True)
class HarnessSpan:
    span_id: str
    parent_id: str | None
    kind: str
    name: str
    emitter_id: str | None
    start_ns: int
    end_ns: int | None
    status: str | None
    data: Mapping[str, Any]
    end_data: Mapping[str, Any]
    evidence: tuple[str, ...]
    parser_version: str = PARSER_VERSION


@dataclass(frozen=True)
class AttemptInfo:
    attempt_id: str | None
    worker_id: str | None
    endpoint_label: str | None
    endpoint_mode: str | None
    model: str | None
    dialects: tuple[str, ...]
    prompt_sha256: str | None
    policy: str | None
    harness_revision: str | None
    source_sha256: str | None
    toolchain: Any
    limits: Mapping[str, Any]
    egress_hosts: tuple[str, ...] | None
    expected_sources: tuple[str, ...]
    method: TimingMethod
    started_ns: int | None


@dataclass(frozen=True)
class SpanOut:
    id: str
    kind: str
    name: str
    parent: str | None
    scope: str | None
    status: str | None
    start_ns: int | None
    end_ns: int | None
    provenance: str
    target: str | None
    attributes: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "name": self.name,
            "parent": self.parent,
            "scope": self.scope,
            "status": self.status,
            "start_ns": None if self.start_ns is None else str(self.start_ns),
            "end_ns": None if self.end_ns is None else str(self.end_ns),
            "provenance": self.provenance,
            "target": self.target,
            "attributes": dict(self.attributes),
        }


@dataclass(frozen=True)
class LinkOut:
    kind: str
    from_id: str
    to_id: str
    method: str
    attributes: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "from": self.from_id, "to": self.to_id, "method": self.method, "attributes": dict(self.attributes)}


@dataclass(frozen=True)
class TraceCoverage:
    expected_sources: tuple[str, ...]
    observed_sources: tuple[str, ...]
    missing_sources: tuple[str, ...]
    collector_complete: bool | None
    loss_reasons: tuple[str, ...]
    truncated: tuple[str, ...]
    redacted: tuple[str, ...]
    rejected: tuple[Rejection, ...]
    partial: bool
    reasons: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": "partial" if self.partial else "complete",
            "reasons": list(self.reasons),
            "expected_sources": list(self.expected_sources),
            "observed_sources": list(self.observed_sources),
            "missing_sources": list(self.missing_sources),
            "collector_complete": self.collector_complete,
            "loss_reasons": list(self.loss_reasons),
            "truncated": list(self.truncated),
            "redacted": list(self.redacted),
            "rejected": [{"source": r.source, "kind": r.kind, "code": r.code, "message": r.message, "evidence": list(r.evidence)} for r in self.rejected],
        }


@dataclass(frozen=True)
class Metrics:
    """Primary metrics first: usage, then total case time, then the timing analysis."""

    usage: UsageAggregate
    usage_complete: bool
    total_case_ns: int | None
    timing: TimingReport | None
    timing_unavailable: str | None
    timing_method: TimingMethod

    def to_dict(self, unavailable: str | None = None) -> dict[str, Any]:
        """``unavailable`` replaces the reason a case that never ran has no timing."""
        from nanoagent.uploaded.timing import Unknown

        usage = self.usage
        out: dict[str, Any] = {
            "total_tokens": int(usage.total.known),
            "input_tokens": int(usage.input.known),
            "output_tokens": int(usage.output.known),
            "cache_read_tokens": int(usage.cache_read.known),
            "cache_write_tokens": int(usage.cache_write.known),
            "missing_calls": {
                "total": usage.total.missing,
                "input": usage.input.missing,
                "output": usage.output.missing,
                "cache_read": usage.cache_read.missing,
                "cache_write": usage.cache_write.missing,
            },
            "model_calls": usage.calls,
            "usage_complete": self.usage_complete,
            "elapsed_ms": None if self.total_case_ns is None else round(self.total_case_ns / 1_000_000),
            "elapsed_ns": self.total_case_ns,
            "timing_method": {
                "id": TIMING_METHOD_ID,
                "reference_tokens_per_second": self.timing_method.reference_tokens_per_second,
                "clock_tolerance_ns": self.timing_method.clock_tolerance_ns,
            },
        }
        if self.timing is None:
            reason = unavailable or self.timing_unavailable
            out["timing_unavailable"] = reason
            # Every timing figure is Unknown for the same reason; each carries it so a reader of one figure sees why.
            for name in ("elapsed_ms", "elapsed_ns", "no_request_ns", "outside_waits_ns", "cpu_ns", "estimated_ns"):
                out.setdefault(name, None)
                out[f"{name}_unknown"] = reason
        else:
            for name in ("no_request_ns", "outside_waits_ns", "cpu_ns", "estimated_ns"):
                value = getattr(self.timing, name)
                out[name] = None if isinstance(value, Unknown) else value
                if isinstance(value, Unknown):
                    out[f"{name}_unknown"] = value.reason
        return out


@dataclass(frozen=True)
class Projection:
    parser_version: str
    attempt: AttemptInfo
    model_calls: tuple[ModelCall, ...]
    tool_invocations: tuple[ToolInvocation, ...]
    commands: tuple[Command, ...]
    processes: tuple[ProcessInfo, ...]
    harness_spans: tuple[HarnessSpan, ...]
    spans: tuple[SpanOut, ...]
    links: tuple[LinkOut, ...]
    coverage: TraceCoverage
    metrics: Metrics
    issues: tuple[Issue, ...]
    workspace_diff: tuple[Mapping[str, Any], ...]
    result: Mapping[str, Any] | None
    placements: Mapping[str, str | None]  # item id -> validated harness span id
    scopes: Mapping[str, tuple[str, ...]]  # item id -> subagent name path

    def spans_request(self, fence: int) -> dict[str, Any]:
        """The body of ``POST /attempts/{id}/spans``."""
        return {"fence": fence, "spans": [s.to_dict() for s in self.spans], "links": [link.to_dict() for link in self.links]}

    def links_of(self, kind: str) -> tuple[LinkOut, ...]:
        return tuple(link for link in self.links if link.kind == kind)
