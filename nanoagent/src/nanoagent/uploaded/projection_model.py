"""Typed results of trace projection."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from nanoagent.uploaded.evidence import json_bytes
from nanoagent.uploaded.timing import TimingMethod, TimingReport
from nanoagent.uploaded.usage import NormalizedUsage, UsageAggregate

PARSER_VERSION = "uploaded-projection/1"
TIMING_METHOD_ID = "rush-timing/1"
OBSERVED = "observed"
HARNESS_REPORTED = "harness_reported"

# What one POST /attempts/{id}/spans may carry (helpinghands benchmark/validate.js spansBody, limits.js); the server reads 10 MiB of JSON.
MAX_SPANS_PER_REQUEST = 2000
MAX_LINKS_PER_REQUEST = 4000
MAX_REQUEST_BYTES = 8 << 20
MAX_SPAN_ATTRIBUTES_BYTES = 32 * 1024
MAX_LINK_ATTRIBUTES_BYTES = 8 * 1024
MAX_COVERAGE_BYTES = 60 * 1024  # the server refuses coverage and metrics past 64 KiB each; the runner adds a few lines of its own to coverage
COVERAGE_ITEMS = 32  # entries kept of each coverage list
COVERAGE_TEXT_BYTES = 300
COVERAGE_EVIDENCE = 4  # digests kept of a rejection's evidence
MAX_METRIC_TEXT_BYTES = 500


def _clip(text: str | None, limit: int) -> str | None:
    """`text` cut to `limit` UTF-16 units, which is how the server counts characters."""
    return text if text is None else text.encode("utf-16-le")[: 2 * limit].decode("utf-16-le", "ignore")


def _clip_bytes(text: str, limit: int) -> str:
    """`text` cut to `limit` bytes of UTF-8, which is how the server counts a result's size."""
    return text.encode("utf-8")[:limit].decode("utf-8", "ignore")


def _bounded(attributes: Mapping[str, Any], limit: int) -> dict[str, Any]:
    """The server refuses attributes past `limit` bytes of JSON; past it they are dropped, leaving a mark that they were."""
    size = len(json.dumps(attributes, ensure_ascii=False).encode("utf-8"))
    return dict(attributes) if size <= limit else {"parser_version": PARSER_VERSION, "attributes_dropped_bytes": size}


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
    client: str | None = None  # the user-agent the call came with, which tells which agent CLI of a Terminal session made it
    prompt: str | None = None  # its request's last user message, titled (chats.prompt_of): a run's first call titles its chat
    prompt_delivered: bool = False  # this call was the first to carry the case prompt byte for byte (a prompt-bound attempt's gateway records it)
    run: str | None = None  # the `rush <command>` run whose process tree made it (the run its token named)
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
    title: str | None = None  # a `rush <command>` run's (records.ProcessRush)
    run: str | None = None  # a `rush <command>` run's id, which its model calls name
    exec_chain: tuple[tuple[str, ...], ...] = ()  # the commands it ran before ``argv``, its last, in order
    binary_path: str | None = None  # the file its last exec ran
    argv_truncated: bool = False  # the recorder cut an argv of it
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
            "name": _clip(self.name, 1000),
            "parent": self.parent,
            "scope": _clip(self.scope, 500),
            "status": self.status,
            "start_ns": None if self.start_ns is None else str(self.start_ns),
            "end_ns": None if self.end_ns is None else str(self.end_ns),
            "provenance": self.provenance,
            "target": _clip(self.target, 2000),
            "attributes": _bounded(self.attributes, MAX_SPAN_ATTRIBUTES_BYTES),
        }


@dataclass(frozen=True)
class LinkOut:
    kind: str
    from_id: str
    to_id: str
    method: str
    attributes: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "from": self.from_id, "to": self.to_id, "method": self.method, "attributes": _bounded(self.attributes, MAX_LINK_ATTRIBUTES_BYTES)}


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
        """The coverage as finalize takes it, which the server refuses past 64 KiB: lists are capped with a count of what was left
        out, messages clipped, and whatever still does not fit is shed from the longest list."""
        omitted: dict[str, int] = {}

        def capped(name: str, items: Sequence[Any], limit: int, clip: Callable[[Any], Any]) -> list[Any]:
            if len(items) > limit:
                omitted[name] = len(items) - limit
            return [clip(item) for item in items[:limit]]

        def text(limit: int) -> Callable[[str], str | None]:
            return lambda value: _clip_bytes(value, limit)

        out: dict[str, Any] = {
            "status": "partial" if self.partial else "complete",
            "reasons": capped("reasons", self.reasons, COVERAGE_ITEMS, text(COVERAGE_TEXT_BYTES)),
            "expected_sources": capped("expected_sources", self.expected_sources, COVERAGE_ITEMS, text(COVERAGE_TEXT_BYTES)),
            "observed_sources": capped("observed_sources", self.observed_sources, COVERAGE_ITEMS, text(COVERAGE_TEXT_BYTES)),
            "missing_sources": capped("missing_sources", self.missing_sources, COVERAGE_ITEMS, text(COVERAGE_TEXT_BYTES)),
            "collector_complete": self.collector_complete,
            "loss_reasons": capped("loss_reasons", self.loss_reasons, COVERAGE_ITEMS, text(COVERAGE_TEXT_BYTES)),
            "truncated": capped("truncated", self.truncated, COVERAGE_ITEMS, text(COVERAGE_TEXT_BYTES)),
            "redacted": capped("redacted", self.redacted, COVERAGE_ITEMS, text(COVERAGE_TEXT_BYTES)),
            "rejected": capped("rejected", self.rejected, COVERAGE_ITEMS, lambda r: {
                "source": _clip_bytes(r.source, 100), "kind": _clip_bytes(r.kind, 100), "code": _clip_bytes(r.code, 100),
                "message": _clip_bytes(r.message, COVERAGE_TEXT_BYTES), "evidence": [_clip_bytes(e, 100) for e in r.evidence[:COVERAGE_EVIDENCE]],
            }),
        }  # fmt: skip
        while len(json_bytes(out | {"omitted": omitted})) > MAX_COVERAGE_BYTES:
            name = max((key for key, value in out.items() if isinstance(value, list) and value), key=lambda key: len(json_bytes(out[key])))
            keep = len(out[name]) // 2
            omitted[name] = omitted.get(name, 0) + len(out[name]) - keep
            out[name] = out[name][:keep]
        return out | {"omitted": omitted} if omitted else out


@dataclass(frozen=True)
class Metrics:
    """Primary metrics first: usage, then total case time, then the timing analysis."""

    usage: UsageAggregate
    usage_complete: bool
    total_case_ns: int | None
    timing: TimingReport | None
    timing_unavailable: str | None
    timing_method: TimingMethod
    tool_calls: int | None = None
    tool_calls_complete: bool = False

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
            "tool_calls": self.tool_calls,
            "tool_calls_complete": self.tool_calls_complete,
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
        # The server refuses metrics past 64 KiB: every figure is a number but the reasons, which are clipped.
        return {key: _clip_bytes(value, MAX_METRIC_TEXT_BYTES) if isinstance(value, str) else value for key, value in out.items()}


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

    def spans_requests(self, fence: int) -> Iterator[dict[str, Any]]:
        """The bodies of ``POST /attempts/{id}/spans``, each under the server's count and size limits (the server upserts, so several are fine)."""
        batch: dict[str, Any] = {"fence": fence, "spans": [], "links": []}
        size = 0
        for key, items, limit in (("spans", self.spans, MAX_SPANS_PER_REQUEST), ("links", self.links, MAX_LINKS_PER_REQUEST)):
            for item in items:
                entry = item.to_dict()
                entry_bytes = len(json.dumps(entry, ensure_ascii=False).encode("utf-8"))
                if batch[key] and (len(batch[key]) >= limit or size + entry_bytes > MAX_REQUEST_BYTES):
                    yield batch
                    batch, size = {"fence": fence, "spans": [], "links": []}, 0
                batch[key].append(entry)
                size += entry_bytes
        yield batch

    def links_of(self, kind: str) -> tuple[LinkOut, ...]:
        return tuple(link for link in self.links if link.kind == kind)
