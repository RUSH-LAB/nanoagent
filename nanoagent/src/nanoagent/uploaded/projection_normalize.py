"""Step 2 of the trace pipeline: records to typed actions, each carrying the evidence event IDs it came from."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from nanoagent.uploaded import records as R
from nanoagent.uploaded.projection_model import (
    AttemptInfo,
    Command,
    HarnessSpan,
    Issue,
    ModelCall,
    ProcessInfo,
    Proposal,
    Rejection,
    ToolInvocation,
)
from nanoagent.uploaded.records import Record
from nanoagent.uploaded.timing import TimingMethod
from nanoagent.uploaded.usage import NormalizedUsage

EVENT_SOURCES = (R.GATEWAY, R.TOOL_BROKER, R.EXEC, R.HARNESS)


@dataclass
class Normalized:
    attempt: AttemptInfo
    records: list[Record]
    worker: dict[str, list[Record]]
    model_calls: list[ModelCall] = field(default_factory=list)
    tools: list[ToolInvocation] = field(default_factory=list)
    commands: list[Command] = field(default_factory=list)
    processes: list[ProcessInfo] = field(default_factory=list)
    harness_spans: list[HarnessSpan] = field(default_factory=list)
    rejections: list[Rejection] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    sequence_gaps: dict[str, list[int]] = field(default_factory=dict)
    harness_rejected: bool = False


def load_json(payloads: Mapping[str, bytes], sha: str | None) -> Any | None:
    if sha is None or sha not in payloads:
        return None
    try:
        return json.loads(payloads[sha])
    except ValueError:
        return None


def _usage(raw: Mapping[str, Any] | None) -> NormalizedUsage | None:
    if raw is None:
        return None
    cost = raw.get("cost_usd")
    return NormalizedUsage(
        input=raw.get("input"),
        output=raw.get("output"),
        total=raw.get("total"),
        cache_read=raw.get("cache_read"),
        cache_write=raw.get("cache_write"),
        reasoning=raw.get("reasoning"),
        supplied_total=raw.get("supplied_total"),
        cost_usd=None if cost is None else Decimal(str(cost)),
        provenance=raw.get("provenance") or "recorded",
        discrepancies=tuple(raw.get("discrepancies") or ()),
        source_ids=tuple(raw.get("source_ids") or ()),
    )


UNKNOWN_USAGE = NormalizedUsage(None, None, None, None, None, None, None, None, "no_usage_recorded")


def _attempt(started: Record | None, issues: list[Issue]) -> AttemptInfo:
    d = started.data if started else {}
    timing = d.get("timing") or {}
    method = TimingMethod()
    try:
        kwargs: dict[str, Any] = {}
        if "reference_tokens_per_second" in timing:
            kwargs["reference_tokens_per_second"] = float(timing["reference_tokens_per_second"])
        if "clock_tolerance_ns" in timing:
            kwargs["clock_tolerance_ns"] = int(timing["clock_tolerance_ns"])
        method = TimingMethod(**kwargs)
    except (ValueError, TypeError) as error:
        issues.append(Issue("invalid_timing_method", str(error), (started.event_id,) if started else (), "error"))
    if started is None:
        issues.append(Issue("missing_attempt_started", "no attempt.started record", (), "error"))
    endpoint = d.get("endpoint") or {}
    return AttemptInfo(
        attempt_id=d.get("attempt_id"),
        worker_id=d.get("worker_id"),
        endpoint_label=endpoint.get("label"),
        endpoint_mode=endpoint.get("mode"),
        model=d.get("model"),
        dialects=tuple(d.get("dialects") or ()),
        prompt_sha256=d.get("prompt_sha256"),
        policy=d.get("policy"),
        harness_revision=d.get("harness_revision"),
        source_sha256=d.get("source_sha256"),
        toolchain=d.get("toolchain"),
        limits=d.get("limits") or {},
        egress_hosts=None if d.get("egress_hosts") is None else tuple(d["egress_hosts"]),
        expected_sources=tuple(d.get("expected_sources") or ()),
        method=method,
        started_ns=started.occurred_ns if started else None,
    )


def parse_records(raw: Sequence[Mapping[str, Any] | Record]) -> tuple[list[Record], list[Issue]]:
    """Parse, drop retransmitted duplicates and order by worker clock, then source and sequence."""
    parsed: dict[str, Record] = {}
    issues: list[Issue] = []
    for item in raw:
        try:
            record = item if isinstance(item, Record) else Record.from_dict(item)
        except R.RecordError as error:
            issues.append(Issue("malformed_record", str(error), (), "error"))
            continue
        parsed.setdefault(record.event_id, record)
    return sorted(parsed.values(), key=lambda r: (r.occurred_ns, r.source, r.sequence)), issues


def _gaps(records: Sequence[Record]) -> dict[str, list[int]]:
    gaps: dict[str, list[int]] = {}
    for source in EVENT_SOURCES:
        seen = sorted({r.sequence for r in records if r.source == source})
        missing = [n for n in range(1, (seen[-1] if seen else 0) + 1) if n not in set(seen)]
        if missing:
            gaps[source] = missing
    return gaps


def normalize(records: list[Record], payloads: Mapping[str, bytes], issues: list[Issue]) -> Normalized:
    worker: dict[str, list[Record]] = {}
    for r in records:
        if r.source == R.WORKER:
            worker.setdefault(r.kind, []).append(r)
    started = (worker.get(R.ATTEMPT_STARTED) or [None])[0]
    n = Normalized(_attempt(started, issues), records, worker, issues=issues, sequence_gaps=_gaps(records))
    _model_calls(n)
    _tools(n)
    _commands(n, payloads)
    _processes(n)
    _harness(n, payloads)
    return n


def _model_calls(n: Normalized) -> None:
    by_call: dict[str, dict[str, Record]] = {}
    for r in n.records:
        if r.source != R.GATEWAY or "call_id" not in r.data:
            continue
        by_call.setdefault(r.data["call_id"], {})[r.kind.removeprefix("model_call.")] = r
    for call_id, parts in by_call.items():
        admitted, dispatched, response, rejected = (parts.get(k) for k in ("admitted", "dispatched", "response", "rejected"))
        evidence = tuple(r.event_id for r in (admitted, dispatched, response, rejected) if r)
        if rejected is not None and admitted is None:
            d = rejected.data
            n.rejections.append(Rejection(R.GATEWAY, rejected.kind, d.get("code", ""), d.get("message", ""), evidence))
            n.model_calls.append(_rejected_call(call_id, d, evidence))
            continue
        a, resp = (admitted.data if admitted else {}), (response.data if response else {})
        proposals = _proposals(resp)
        usage = _usage(resp.get("usage")) if response else None
        if response is not None and usage is None:
            usage = UNKNOWN_USAGE
        if response is None:
            n.issues.append(Issue("model_call_without_response", f"model call {call_id} was admitted but has no response record", evidence, "error"))
        d_ns = dispatched.data if dispatched else {}
        n.model_calls.append(
            ModelCall(
                call_id=call_id,
                dialect=a.get("dialect") or resp.get("dialect"),
                span_ref=a.get("span_id") if admitted else resp.get("span_id"),
                model=a.get("model"),
                stream=bool(a.get("stream")),
                ordinal=a.get("ordinal"),
                admitted_ns=admitted.occurred_ns if admitted else None,
                dispatched_ns=resp.get("dispatched_ns") if resp.get("dispatched_ns") is not None else (dispatched.occurred_ns if dispatched else None),
                first_byte_ns=resp.get("first_byte_ns"),
                completed_ns=resp.get("completed_ns"),
                terminal=resp.get("terminal"),
                http_status=resp.get("http_status"),
                maybe_reached=resp.get("maybe_reached_upstream"),
                usage=usage,
                usage_error=resp.get("usage_error"),
                proposals=proposals,
                submitted_sha256=a.get("submitted_request_sha256"),
                effective_sha256=a.get("effective_request_sha256") or d_ns.get("effective_request_sha256"),
                frames_sha256=resp.get("frames_payload_sha256"),
                frame_count=resp.get("frame_count"),
                response_sha256=resp.get("response_payload_sha256") or resp.get("stream_payload_sha256"),
                response_id=resp.get("response_id"),
                generation_id=resp.get("generation_id"),
                resolved_model=resp.get("resolved_model"),
                provider=resp.get("provider"),
                finish_reason=resp.get("finish_reason"),
                error=resp.get("error"),
                rejected=None,
                evidence=evidence,
                client=(a.get("request_headers") or {}).get("user-agent"),
                prompt=a.get("prompt"),
            )
        )
    n.model_calls.sort(key=lambda c: (c.ordinal if c.ordinal is not None else 1 << 60, c.admitted_ns or 0))


def _rejected_call(call_id: str, d: Mapping[str, Any], evidence: tuple[str, ...]) -> ModelCall:
    return ModelCall(
        call_id, d.get("dialect"), d.get("span_id"), None, False, None, None, None, None, None, None, d.get("http_status"), False, None, None, (),
        d.get("submitted_request_sha256"), None, None, None, None, None, None, None, None, None, None,
        {"code": d.get("code"), "message": d.get("message"), "http_status": d.get("http_status")}, evidence,
    )  # fmt: skip


def _proposals(resp: Mapping[str, Any]) -> tuple[Proposal, ...]:
    registered = {r.get("tool_call_id"): r for r in resp.get("registrations") or ()}
    out = []
    for p in resp.get("proposals") or ():
        reg = registered.get(p.get("call_id"), {})
        out.append(
            Proposal(
                p.get("call_id"), p.get("name", ""), p.get("arguments"), p.get("raw_arguments", ""), p.get("arguments_error"),
                reg.get("frame_index", p.get("completed_frame")), reg.get("registered_ns"), bool(reg.get("early")),
            )  # fmt: skip
        )
    return tuple(out)


def _tools(n: Normalized) -> None:
    by_call: dict[str, dict[str, Record]] = {}
    for r in n.records:
        if r.source == R.TOOL_BROKER and "call_id" in r.data:
            by_call.setdefault(r.data["call_id"], {})[r.kind.removeprefix("tool.")] = r
    for call_id, parts in by_call.items():
        invoked, completed, rejected = parts.get("invoked"), parts.get("completed"), parts.get("rejected")
        evidence = tuple(r.event_id for r in (invoked, completed, rejected) if r)
        if rejected is not None:
            d = rejected.data
            n.rejections.append(Rejection(R.TOOL_BROKER, rejected.kind, d.get("code", ""), d.get("message", ""), evidence))
            n.tools.append(
                ToolInvocation(call_id, d.get("tool"), None, d.get("span_id"), d.get("cause"), False, None, None, None, rejected.occurred_ns, rejected.occurred_ns, None, None,
                               {"code": d.get("code"), "message": d.get("message"), "http_status": d.get("http_status")}, evidence)
            )  # fmt: skip
            continue
        i, c = (invoked.data if invoked else {}), (completed.data if completed else {})
        end = completed.occurred_ns if completed else None
        start = end - c["duration_ns"] if end is not None and "duration_ns" in c else (invoked.occurred_ns if invoked else None)
        if "received_ns" in i:
            start = min(start, i["received_ns"]) if start is not None else i["received_ns"]  # the call began when the broker received it
        if completed is None:
            n.issues.append(Issue("tool_without_completion", f"tool call {call_id} has no completion record", evidence, "error"))
        n.tools.append(
            ToolInvocation(
                call_id, i.get("tool") or c.get("tool"), i.get("writes"), i.get("span_id"), i.get("cause"), bool(i.get("adapted")), i.get("adaptation"),
                i.get("arguments_sha256"), c.get("output_sha256"), start, end, c.get("ok") if completed else None, c.get("error"), None, evidence,
            )  # fmt: skip
        )


def _commands(n: Normalized, payloads: Mapping[str, bytes]) -> None:
    by_req: dict[str, dict[str, Record]] = {}
    for r in n.records:
        if r.source == R.EXEC and "request_id" in r.data:
            by_req.setdefault(r.data["request_id"], {})[r.kind.removeprefix("exec.")] = r
    for request_id, parts in by_req.items():
        started, completed, rejected = parts.get("started"), parts.get("completed"), parts.get("rejected")
        evidence = tuple(r.event_id for r in (started, completed, rejected) if r)
        if rejected is not None and started is None:
            d = rejected.data
            n.rejections.append(Rejection(R.EXEC, rejected.kind, d.get("code", ""), d.get("message", ""), evidence))
            n.commands.append(Command(request_id, None, d.get("span_id"), None, None, rejected.occurred_ns, rejected.occurred_ns, None, None, None, None, False, False, None,
                                      {"code": d.get("code"), "message": d.get("message"), "http_status": d.get("http_status")}, evidence))  # fmt: skip
            continue
        s, c = (started.data if started else {}), (completed.data if completed else {})
        command = load_json(payloads, s.get("command_sha256"))
        argv = tuple(command["argv"]) if isinstance(command, dict) and "argv" in command else None
        end = completed.occurred_ns if completed else None
        start = end - c["duration_ns"] if end is not None and "duration_ns" in c else (started.occurred_ns if started else None)
        if completed is None:
            n.issues.append(Issue("command_without_completion", f"command {request_id} has no completion record", evidence, "error"))
        n.commands.append(
            Command(
                request_id, c.get("launch_id"), s.get("span_id") or c.get("span_id"), argv, command.get("cwd") if isinstance(command, dict) else s.get("cwd"), start, end,
                c.get("ok") if completed else None, c.get("termination"), c.get("stdout_sha256"), c.get("stderr_sha256"),
                bool(c.get("stdout_truncated")), bool(c.get("stderr_truncated")), c.get("error"), None, evidence,
            )  # fmt: skip
        )


def _processes(n: Normalized) -> None:
    info: dict[tuple[int, int], dict[str, Any]] = {}
    order: list[tuple[int, int]] = []
    said: list[tuple[int, int, dict[str, str]]] = []
    for r in n.records:
        if r.source != R.PROCESS:
            continue
        d = r.data
        if r.kind == R.PROCESS_RUSH:
            said.append((int(d["tgid"]), int(d["time_ns"]), {key: str(d[key]) for key in ("title", "verdict") if d.get(key) is not None}))
            continue
        try:
            ident = (int(d["tgid"]), int(d["start_time"]))
        except (KeyError, TypeError, ValueError):
            n.issues.append(Issue("malformed_process_record", f"{r.kind} lacks tgid/start_time", (r.event_id,), "error"))
            continue
        rec = info.setdefault(ident, {"evidence": []})
        if ident not in order:
            order.append(ident)
        rec["evidence"].append(r.event_id)
        t = d.get("time_ns", r.occurred_ns)
        if r.kind == R.PROCESS_CLONE:
            rec["parent"] = (int(d["parent_tgid"]), int(d["parent_start_time"]))
            rec["start"] = t
        elif r.kind == R.PROCESS_EXEC:
            rec["argv"], rec["cwd"] = tuple(d.get("argv") or ()), d.get("cwd")
            rec.setdefault("start", t)
            if d.get("launch_id"):
                rec["launch_id"] = d["launch_id"]
        elif r.kind == R.PROCESS_EXIT:
            rec["end"], rec["exit_code"], rec["signal"] = t, d.get("exit_code"), d.get("signal")
    # What is said of a `rush` run is the process's with its tgid that ran then (the latest such to start): its records may come after.
    for tgid, at, facts in said:
        running = [ident for ident in order if ident[0] == tgid and (info[ident].get("start") or 0) <= at and (info[ident].get("end") is None or info[ident]["end"] >= at)]
        if running:
            info[max(running, key=lambda ident: info[ident].get("start") or 0)].update(facts)
    for ident in order:
        p = info[ident]
        n.processes.append(
            ProcessInfo(
                ident, p.get("parent"), p.get("argv"), p.get("cwd"), p.get("launch_id"), p.get("start"), p.get("end"), p.get("exit_code"), p.get("signal"),
                tuple(p["evidence"]), p.get("title"), p.get("verdict"),
            )
        )


def _harness(n: Normalized, payloads: Mapping[str, bytes]) -> None:
    starts: dict[str, dict[str, Any]] = {}
    ends: dict[str, tuple[Record, dict[str, Any]]] = {}
    order: list[str] = []
    for r in n.records:
        if r.source == R.HARNESS and r.kind == "harness.rejected":
            d = r.data
            n.harness_rejected = True
            n.rejections.append(Rejection(R.HARNESS, r.kind, d.get("code", ""), d.get("message", ""), (r.event_id,)))
        if r.source != R.HARNESS or r.kind != "harness.event" or r.data.get("event") == "log":
            continue
        event = load_json(payloads, r.data.get("event_sha256"))
        if not isinstance(event, dict):
            n.issues.append(Issue("harness_payload_missing", f"harness event {r.event_id} payload is not retained", (r.event_id,), "error"))
            n.harness_rejected = True
            continue
        span_id = event.get("span_id")
        if event.get("event") == "span.start":
            if span_id in starts:
                n.issues.append(Issue("duplicate_harness_start", f"span {span_id} started twice", (r.event_id,)))
                continue
            starts[span_id] = {"record": r, "event": event}
            order.append(span_id)
        elif event.get("event") == "span.end":
            ends.setdefault(span_id, (r, event))
    for span_id in order:
        s = starts[span_id]
        r, e = s["record"], s["event"]
        end = ends.get(span_id)
        evidence = (r.event_id, *((end[0].event_id,) if end else ()))
        n.harness_spans.append(
            HarnessSpan(span_id, e.get("parent_span_id"), e.get("kind", "operation"), e.get("name", span_id), e.get("emitter_id"), r.occurred_ns,
                        end[0].occurred_ns if end else None, end[1].get("status") if end else None, e.get("data") or {}, (end[1].get("data") or {}) if end else {}, evidence)
        )  # fmt: skip
    for span_id in ends:
        if span_id not in starts:
            n.issues.append(Issue("harness_end_without_start", f"span {span_id} ends without a start", (ends[span_id][0].event_id,)))
