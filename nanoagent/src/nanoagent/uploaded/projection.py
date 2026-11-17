"""Deterministic trace projection: stored evidence records to an attempt tree, causal links, coverage and metrics.

``project(records, payloads)`` is a pure function. It normalizes records into typed actions (``projection_normalize``),
joins them by recorded IDs into one span tree plus separate causal links, and assembles coverage and metrics
(``projection_timing`` builds the timing input). Everything a link rests on is stored with it: the IDs and the ``method``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from nanoagent.uploaded import records as R
from nanoagent.uploaded.dialects import MalformedCaptureError, parse_request
from nanoagent.uploaded.projection_compare import to_compare_attempt
from nanoagent.uploaded.projection_model import (
    HARNESS_REPORTED,
    OBSERVED,
    PARSER_VERSION,
    Issue,
    LinkOut,
    Metrics,
    Projection,
    SpanOut,
    TraceCoverage,
)
from nanoagent.uploaded.projection_normalize import UNKNOWN_USAGE, Normalized, load_json, normalize, parse_records
from nanoagent.uploaded.projection_timing import CausalEdge, build_timing, tool_node
from nanoagent.uploaded.records import Record
from nanoagent.uploaded.timing import analyze
from nanoagent.uploaded.usage import aggregate

__all__ = ["PARSER_VERSION", "Projection", "project", "to_compare_attempt"]

PROCTREE = "proctree"


def _status(ok: bool | None, rejected: Any) -> str:
    if rejected is not None:
        return "rejected"
    return "unfinished" if ok is None else ("ok" if ok else "error")


@dataclass
class _Join:
    n: Normalized
    payloads: Mapping[str, bytes]
    spans: list[SpanOut] = field(default_factory=list)
    links: list[LinkOut] = field(default_factory=list)
    causal: list[CausalEdge] = field(default_factory=list)
    placements: dict[str, str | None] = field(default_factory=dict)
    scopes: dict[str, tuple[str, ...]] = field(default_factory=dict)
    refs_ok: bool = True
    workspace_diff: tuple[Mapping[str, Any], ...] = ()

    def __post_init__(self) -> None:
        self.hspans = {s.span_id: s for s in self.n.harness_spans}
        self.tol = self.n.attempt.method.clock_tolerance_ns
        self.calls = {c.call_id: c for c in self.n.model_calls}
        self.tools = {t.call_id: t for t in self.n.tools}
        self.commands = {c.request_id: c for c in self.n.commands}
        self.launch_ids = {c.launch_id: c for c in self.n.commands if c.launch_id}

    def issue(self, code: str, message: str, evidence: Sequence[str] = (), severity: str = "warning") -> None:
        self.n.issues.append(Issue(code, message, tuple(evidence), severity))

    def span_id_of(self, call_id: str) -> str | None:
        if call_id in self.calls:
            return f"m:{call_id}"
        if call_id in self.tools:
            return f"t:{call_id}"
        if call_id in self.commands:
            return f"c:{call_id}"
        if call_id in self.launch_ids:
            return f"c:{self.launch_ids[call_id].request_id}"
        return None

    def chain(self, span_id: str | None) -> tuple[str, ...]:
        names: list[str] = []
        while span_id in self.hspans:
            s = self.hspans[span_id]
            if s.kind == "subagent":
                names.append(s.name)
            span_id = s.parent_id
        return tuple(reversed(names))

    def scope_label(self, chain: tuple[str, ...]) -> str:
        return "/".join(("agent", *chain))

    def place(self, key: str, span_ref: str | None, start: int | None, end: int | None, evidence: Sequence[str]) -> tuple[str, tuple[str, ...], dict[str, Any]]:
        """Parent span id, scope path and attributes for an observed item under its recorded harness span."""
        phase = "phase:harness"
        if span_ref is None:
            self.placements[key] = None
            return phase, (), {}
        span = self.hspans.get(span_ref)
        if span is None:
            self.refs_ok = False
            self.issue("unknown_span_reference", f"{key} names harness span {span_ref!r}, which the harness never started", evidence)
            self.placements[key] = None
            return phase, (), {"span_ref": {"span_id": span_ref, "provenance": HARNESS_REPORTED, "verified": False}}
        outside = (start is not None and start < span.start_ns - self.tol) or (end is not None and span.end_ns is not None and end > span.end_ns + self.tol)
        if outside:
            self.issue("placement_outside_span", f"{key} lies outside its harness span {span_ref}", evidence)
        self.placements[key] = span_ref
        return f"h:{span_ref}", self.chain(span_ref), {"span_ref": {"span_id": span_ref, "provenance": HARNESS_REPORTED, "verified": not outside}}

    def add(self, **fields: Any) -> None:
        attrs = {"parser_version": PARSER_VERSION, **fields.pop("attributes", {})}
        self.spans.append(SpanOut(attributes=attrs, **fields))


def _lifecycle(j: _Join) -> tuple[int | None, int | None]:
    n = j.n
    w = n.worker
    started = n.attempt.started_ns
    times = [r.occurred_ns for rs in w.values() for r in rs]
    root_end = max(times) if times else None
    j.add(
        id="root", kind="attempt", name=f"attempt {n.attempt.attempt_id or ''}".strip(), parent=None, scope=None, status="ok", start_ns=started, end_ns=root_end,
        provenance=OBSERVED, target=n.attempt.model,
        attributes={"attempt_id": n.attempt.attempt_id, "harness_revision": n.attempt.harness_revision, "prompt_sha256": n.attempt.prompt_sha256,
                    "model": n.attempt.model, "evidence": [r.event_id for r in w.get(R.ATTEMPT_STARTED, ())]},
    )  # fmt: skip
    launched, exited, quiesced = (next(iter(w.get(k, ())), None) for k in (R.CASE_LAUNCHED, R.CASE_EXITED, R.CASE_QUIESCED))
    launch_ns = int(launched.data["launch_ns"]) if launched else None
    quiesce_ns = int(quiesced.data["quiesced_ns"]) if quiesced else None
    if launched:
        j.add(
            id="phase:harness", kind="phase", name="harness", parent="root", scope=None, status="ok" if quiesced else "unfinished", start_ns=launch_ns, end_ns=quiesce_ns,
            provenance=OBSERVED, target=None,
            attributes={"container_id": launched.data.get("container_id"), "argv": launched.data.get("argv"), "termination": exited.data.get("termination") if exited else None,
                        "exit_ns": exited.data.get("exit_ns") if exited else None, "evidence": [r.event_id for r in (launched, exited, quiesced) if r]},
        )  # fmt: skip
    if snap := w.get(R.SNAPSHOT_TAKEN):
        # The event carries no diff (at the file limit it outgrows an event); the snapshot payload holds it.
        body = load_json(j.payloads, snap[0].data.get("payload_sha256"))
        diff = body.get("diff") if isinstance(body, dict) and isinstance(body.get("diff"), list) else []
        if body is None:
            j.issue("snapshot_payload_missing", "the snapshot payload is not retained, so the workspace diff is unknown", (snap[0].event_id,), "info")
        j.workspace_diff = tuple(diff)
        counts = {c: sum(1 for e in diff if e.get("change") == c) for c in ("added", "modified", "deleted")}
        j.add(
            id="snapshot", kind="snapshot", name="workspace snapshot", parent="root", scope=None, status="ok", start_ns=snap[0].occurred_ns, end_ns=snap[0].occurred_ns,
            provenance=OBSERVED, target=None, attributes={"changes": counts, "payload_sha256": snap[0].data.get("payload_sha256"), "evidence": [snap[0].event_id]},
        )  # fmt: skip
    return launch_ns, quiesce_ns


def _harness_spans(j: _Join) -> None:
    for s in j.n.harness_spans:
        parent = "phase:harness"
        attrs: dict[str, Any] = {"emitter_id": s.emitter_id, "data": dict(s.data), "evidence": list(s.evidence)}
        if s.parent_id is not None:
            if s.parent_id in j.hspans:
                parent = f"h:{s.parent_id}"
            else:
                j.refs_ok = False
                j.issue("unknown_parent_span", f"harness span {s.span_id} names unknown parent {s.parent_id!r}", s.evidence)
                attrs["parent_unverified"] = s.parent_id
        chain = j.chain(s.span_id)
        j.scopes[f"h:{s.span_id}"] = chain
        j.add(id=f"h:{s.span_id}", kind=s.kind, name=s.name, parent=parent, scope=j.scope_label(chain), status=s.status or "unfinished", start_ns=s.start_ns, end_ns=s.end_ns,
              provenance=HARNESS_REPORTED, target=s.name, attributes=attrs)  # fmt: skip


def _harness_references(j: _Join) -> None:
    for s in j.n.harness_spans:
        refs, call_id = s.data.get("refs"), s.data.get("call_id")
        claimed = [*(refs if isinstance(refs, list) else ()), *([call_id] if call_id else [])]
        if (refs and not isinstance(refs, list)) or not all(isinstance(ref, str) for ref in claimed):
            j.refs_ok = False
            j.issue("malformed_reference", f"harness span {s.span_id} gives refs or call_id that are not strings", s.evidence)
            claimed = [ref for ref in claimed if isinstance(ref, str)]
        for ref in claimed:
            target = j.span_id_of(ref)
            claimed_tool = s.data.get("tool")
            if target is None:
                j.refs_ok = False
                j.issue("unknown_reference", f"harness span {s.span_id} references {ref!r}, which no observed source recorded", s.evidence)
            elif claimed_tool and target.startswith("t:") and j.tools[target[2:]].tool != claimed_tool:
                j.refs_ok = False
                j.issue("reference_tool_mismatch", f"harness span {s.span_id} claims tool {claimed_tool!r} for {ref!r}", s.evidence)
            else:
                j.links.append(LinkOut("harness_reference", f"h:{s.span_id}", target, HARNESS_REPORTED, {"reference": ref, "validated": True}))


def _model_calls(j: _Join) -> None:
    for c in j.n.model_calls:
        parent, chain, extra = j.place(c.call_id, c.span_ref, c.dispatched_ns or c.admitted_ns, c.completed_ns, c.evidence)
        sid = f"m:{c.call_id}"
        j.scopes[sid] = chain
        status = "rejected" if c.rejected else ("ok" if c.terminal == "completed" else ("unfinished" if c.terminal is None else "error"))
        usage = c.usage
        j.add(
            id=sid, kind="model_call", name=c.model or "model call", parent=parent, scope=j.scope_label(chain), status=status, start_ns=c.dispatched_ns or c.admitted_ns, end_ns=c.completed_ns,
            provenance=OBSERVED, target=c.model,
            attributes={**extra, "call_id": c.call_id, "dialect": c.dialect, "terminal": c.terminal, "http_status": c.http_status, "stream": c.stream, "ordinal": c.ordinal,
                        "generation_id": c.generation_id, "response_id": c.response_id, "resolved_model": c.resolved_model, "provider": c.provider, "finish_reason": c.finish_reason,
                        "error": c.error, "rejected": c.rejected, "submitted_request_sha256": c.submitted_sha256, "effective_request_sha256": c.effective_sha256,
                        "response_sha256": c.response_sha256, "frames_sha256": c.frames_sha256, "usage": None if usage is None else {k: getattr(usage, k) for k in ("input", "output", "total", "cache_read", "cache_write", "reasoning")},
                        "evidence": list(c.evidence)},
        )  # fmt: skip
        for i, p in enumerate(c.proposals):
            pid = f"{sid}/{p.tool_call_id or f'#{i}'}"
            j.scopes[pid] = chain
            j.add(id=pid, kind="proposal", name=p.name, parent=sid, scope=j.scope_label(chain), status="ok" if p.arguments_error is None else "error", start_ns=p.registered_ns or c.completed_ns,
                  end_ns=p.registered_ns or c.completed_ns, provenance=OBSERVED, target=p.name,
                  attributes={"tool_call_id": p.tool_call_id, "arguments": p.arguments, "raw_arguments": p.raw_arguments, "arguments_error": p.arguments_error, "frame_index": p.frame_index,
                              "early": p.early, "evidence": list(c.evidence)})  # fmt: skip


def _tools(j: _Join) -> None:
    for t in j.n.tools:
        parent, chain, extra = j.place(t.call_id, t.span_ref, t.start_ns, t.end_ns, t.evidence)
        sid = f"t:{t.call_id}"
        j.scopes[sid] = chain
        j.add(id=sid, kind="tool", name=t.tool or "tool", parent=parent, scope=j.scope_label(chain), status=_status(t.ok, t.rejected), start_ns=t.start_ns, end_ns=t.end_ns, provenance=OBSERVED,
              target=t.tool, attributes={**extra, "call_id": t.call_id, "writes": t.writes, "cause": t.cause, "adapted": t.adapted, "adaptation": t.adaptation, "arguments_sha256": t.arguments_sha256,
                                         "output_sha256": t.output_sha256, "error": t.error, "rejected": t.rejected, "evidence": list(t.evidence)})  # fmt: skip


def _commands(j: _Join) -> None:
    for c in j.n.commands:
        parent, chain, extra = j.place(c.request_id, c.span_ref, c.start_ns, c.end_ns, c.evidence)
        sid = f"c:{c.request_id}"
        j.scopes[sid] = chain
        code = (c.termination or {}).get("exit_code")
        status = "rejected" if c.rejected else _status(None if c.ok is None else (c.ok and code in (0, None)), None)
        j.add(id=sid, kind="command", name=c.argv[0] if c.argv else "command", parent=parent, scope=j.scope_label(chain), status=status, start_ns=c.start_ns, end_ns=c.end_ns, provenance=OBSERVED,
              target=c.argv[0] if c.argv else None,
              attributes={**extra, "request_id": c.request_id, "launch_id": c.launch_id, "argv": c.argv, "cwd": c.cwd, "termination": c.termination, "stdout_sha256": c.stdout_sha256,
                          "stderr_sha256": c.stderr_sha256, "stdout_truncated": c.stdout_truncated, "stderr_truncated": c.stderr_truncated, "error": c.error, "rejected": c.rejected,
                          "evidence": list(c.evidence)})  # fmt: skip


def _causal_proposals(j: _Join) -> None:
    for t in j.n.tools:
        if not t.cause or t.rejected is not None:
            continue
        mid, tcid = t.cause.get("model_call_id"), t.cause.get("tool_call_id")
        call = j.calls.get(mid or "")
        proposal = next((p for p in (call.proposals if call else ()) if p.tool_call_id == tcid), None)
        if proposal is None or proposal.name != t.tool:
            j.issue("unverified_cause", f"tool call {t.call_id} claims proposal {tcid!r} of model call {mid!r}, which the gateway evidence does not show", t.evidence, "error")
            continue
        j.links.append(
            LinkOut("proposal_invocation", f"m:{mid}/{tcid}", f"t:{t.call_id}", "broker_cause_adaptation" if t.adapted else "broker_cause",
                    {"model_call_id": mid, "tool_call_id": tcid, "adapted": t.adapted, "adaptation": t.adaptation, "evidence": list(t.evidence)})  # fmt: skip
        )
        if proposal.early and (call.completed_ns is None or t.start_ns is None or t.start_ns < call.completed_ns):
            j.causal.append((mid, tool_node(t.call_id), proposal.frame_index, 0))  # type: ignore[arg-type]
        else:
            # Launched after the response ended (never early, or the harness waited): it starts a measured gap after the modeled end.
            lag = 0 if call.completed_ns is None or t.start_ns is None else max(0, t.start_ns - call.completed_ns)
            j.causal.append((mid, tool_node(t.call_id), None, lag))  # type: ignore[arg-type]


def _causal_results(j: _Join) -> None:
    parsed: dict[str, dict[str, Any] | None] = {}

    def results_of(call_id: str) -> dict[str, Any] | None:
        if call_id not in parsed:
            call = j.calls[call_id]
            body = load_json(j.payloads, call.submitted_sha256)
            found: dict[str, Any] | None = None
            if isinstance(body, dict) and call.dialect:
                try:
                    found = {}
                    for r in parse_request(call.dialect, body).tool_results:  # type: ignore[arg-type]
                        if isinstance(r.call_id, str):  # a harness-chosen id the dialect did not type-check cannot key a link
                            found.setdefault(r.call_id, r)
                except MalformedCaptureError as error:
                    j.issue("request_unparseable", f"request of model call {call_id}: {error}", call.evidence)
                    found = None
            else:
                j.issue("request_payload_missing", f"the submitted request of model call {call_id} is not retained, so tool results in it cannot be linked", call.evidence, "info")
            parsed[call_id] = found
        return parsed[call_id]

    later = [c for c in j.n.model_calls if c.rejected is None and c.admitted_ns is not None]
    for t in j.n.tools:
        if not t.cause or t.end_ns is None or t.rejected is not None:
            continue
        tcid = t.cause.get("tool_call_id")
        for call in later:
            if call.admitted_ns < t.end_ns:  # type: ignore[operator]
                continue
            found = (results_of(call.call_id) or {}).get(tcid)
            if found is None:
                continue
            output = load_json(j.payloads, t.output_sha256)
            content = found.content
            if output is None:
                match = "unknown"
            else:
                match = "exact" if content == output or _json_text(content) == output else "different"
            j.links.append(
                LinkOut("result_delivery", f"t:{t.call_id}", f"m:{call.call_id}", "tool_result_call_id",
                        {"tool_call_id": tcid, "message_index": found.message_index, "content_match": match, "evidence": [*t.evidence, *call.evidence]})  # fmt: skip
            )
            j.causal.append((tool_node(t.call_id), call.call_id, None, 0))
            break


def _json_text(value: Any) -> Any:
    
    try:
        return json.loads(value) if isinstance(value, str) else None
    except ValueError:
        return None


def _retries(j: _Join) -> None:
    seen: list[Any] = []
    for c in j.n.model_calls:
        if c.rejected is not None or c.admitted_ns is None or c.submitted_sha256 is None:
            continue
        prior = next((p for p in reversed(seen) if p.submitted_sha256 == c.submitted_sha256 and p.terminal != "completed"), None)
        if prior is not None:
            j.links.append(LinkOut("retry", f"m:{c.call_id}", f"m:{prior.call_id}", "request_digest",
                                   {"request_sha256": c.submitted_sha256, "failed_terminal": prior.terminal, "evidence": [*prior.evidence, *c.evidence]}))  # fmt: skip
        seen.append(c)


def _processes(j: _Join) -> None:
    procs = {p.identity: p for p in j.n.processes}
    pid = {ident: f"p:{ident[0]}@{ident[1]}" for ident in procs}
    linked: dict[tuple[int, int], tuple[str, str]] = {}
    for p in procs.values():  # supervisor launch ID is the verified join
        cmd = j.launch_ids.get(p.launch_id or "")
        if cmd is not None:
            linked[p.identity] = (f"c:{cmd.request_id}", "launch_id")
    claimed = {cmd for cmd, _ in linked.values()}
    for c in j.n.commands:  # otherwise a unique argv match inside the command's interval
        if f"c:{c.request_id}" in claimed or c.argv is None or c.start_ns is None or c.end_ns is None:
            continue
        found = [p for p in procs.values() if p.identity not in linked and p.argv == c.argv and p.start_ns is not None and c.start_ns - j.tol <= p.start_ns <= c.end_ns + j.tol]
        rivals = [o for o in j.n.commands if o is not c and o.argv == c.argv and o.start_ns is not None and o.end_ns is not None and any(o.start_ns - j.tol <= p.start_ns <= o.end_ns + j.tol for p in found)]  # type: ignore[operator]
        if len(found) == 1 and not rivals:
            linked[found[0].identity] = (f"c:{c.request_id}", "exec_argv_window")
        elif found:
            j.issue("ambiguous_command_process", f"command {c.request_id} matches {len(found)} processes by argv; no link recorded", c.evidence)
    if procs:
        j.add(id=PROCTREE, kind="process_tree", name="process tree", parent="phase:harness", scope=None, status="ok", start_ns=None, end_ns=None, provenance=OBSERVED, target=None)
    for ident, p in procs.items():
        parent_link = linked.get(ident)
        if parent_link:
            parent = parent_link[0]
        elif p.parent in procs:
            parent = pid[p.parent]
        else:
            parent = PROCTREE
        base = p.argv[0].rsplit("/", 1)[-1] if p.argv else f"process {ident[0]}"
        status = "unfinished" if p.end_ns is None else ("ok" if p.exit_code == 0 and p.signal is None else "error")
        j.add(id=pid[ident], kind="process", name=base, parent=parent, scope=None, status=status, start_ns=p.start_ns, end_ns=p.end_ns, provenance=OBSERVED, target=p.argv[0] if p.argv else None,
              attributes={"tgid": ident[0], "start_time": ident[1], "argv": p.argv, "cwd": p.cwd, "exit_code": p.exit_code, "signal": p.signal, "launch_id": p.launch_id,
                          "linked_command": parent_link[0] if parent_link else None, "evidence": list(p.evidence)})  # fmt: skip
        if parent_link:
            j.links.append(LinkOut("command_process", parent_link[0], pid[ident], parent_link[1],
                                   {"launch_id": p.launch_id, "exit_code": p.exit_code, "signal": p.signal, "evidence": list(p.evidence)}))  # fmt: skip
        if p.parent in procs:
            j.links.append(LinkOut("process_lineage", pid[p.parent], pid[ident], "clone", {"evidence": list(p.evidence)}))  # fmt: skip


def _coverage(n: Normalized, redactions: Mapping[str, str]) -> TraceCoverage:
    w = n.worker
    reasons: list[str] = []
    present = {r.source for r in n.records}
    quiesced = bool(w.get(R.CASE_QUIESCED))
    # Event-driven sources are idle, not lost, when nothing happened (gaps in their sequences show loss); the process
    # collector vouches for itself with a complete health report.
    health = w.get(R.COLLECTOR_HEALTH) or []
    idle_ok = {R.GATEWAY, R.TOOL_BROKER, R.EXEC} if quiesced else set()
    if health and all(h.data.get("complete") for h in health):
        idle_ok.add(R.PROCESS)
    expected = n.attempt.expected_sources
    observed = tuple(sorted(present | {s for s in expected if s in idle_ok}))
    missing = tuple(s for s in expected if s not in observed)
    reasons += [f"expected source {s} recorded nothing" for s in missing]
    for source, gaps in sorted(n.sequence_gaps.items()):
        reasons.append(f"{source} sequence has gaps at {gaps[:5]}")
    if not quiesced:
        reasons.append("the case did not quiesce")
    collector: bool | None = None
    loss: list[str] = []
    if health:
        collector = all(h.data.get("complete") for h in health)
        for h in health:
            loss += list(h.data.get("loss_reasons") or ())
            if h.data.get("reported_drops"):
                collector = False
                loss.append(f"{h.data['reported_drops']} frames dropped")
        if not collector:
            reasons.append("process collector lost evidence: " + ", ".join(loss or ["incomplete"]))
    elif R.PROCESS in expected:
        reasons.append("process collector health was not recorded")
    truncated = [f"command {c.request_id} output" for c in n.commands if c.stdout_truncated or c.stderr_truncated]
    truncated += [f"stream of {r.data.get('call_id')}" for r in n.records if r.source == R.GATEWAY and r.data.get("stream_parse_error")]
    truncated += [f"payload {sha}" for sha, status in sorted(redactions.items()) if status == "truncated"]
    if truncated:
        reasons.append("truncated evidence: " + ", ".join(truncated))
    if n.harness_rejected:
        reasons.append("harness events were rejected")
    reasons += [f"{i.code}: {i.message}" for i in n.issues if i.severity == "error"]
    redacted = tuple(sorted(sha for sha, status in redactions.items() if status == "redacted"))
    return TraceCoverage(expected, observed, missing, collector, tuple(loss), tuple(truncated), redacted, tuple(n.rejections), bool(reasons), tuple(reasons))


def project(
    raw_records: Sequence[Mapping[str, Any] | Record],
    payloads: Mapping[str, bytes] | None = None,
    redactions: Mapping[str, str] | None = None,
) -> Projection:
    """Project stored records into the attempt tree, causal links, coverage and metrics.

    ``payloads`` maps SHA-256 to retained bytes (request bodies, command payloads, harness events, the frames index);
    ``redactions`` maps SHA-256 to the stored ``none|redacted|truncated`` status.
    """
    payloads = payloads or {}
    issues: list[Issue] = []
    records, parse_issues = parse_records(raw_records)
    issues += parse_issues
    n = normalize(records, payloads, issues)
    j = _Join(n, payloads)
    _lifecycle(j)
    _harness_spans(j)
    _model_calls(j)
    _tools(j)
    _commands(j)
    _processes(j)
    _causal_proposals(j)
    _causal_results(j)
    _retries(j)
    _harness_references(j)
    timing, unavailable, timing_issues = build_timing(n, j.placements, j.causal, payloads, j.refs_ok)
    n.issues.extend(timing_issues)
    w = n.worker
    coverage = _coverage(n, redactions or {})
    admitted = [c for c in n.model_calls if c.rejected is None and c.admitted_ns is not None]
    usages = [c.usage or UNKNOWN_USAGE for c in admitted]
    usage = aggregate(usages)
    # Complete only when every physical call reported every counted field: `missing_calls` carries what is not known.
    reported = all(field.missing == 0 for field in (usage.total, usage.input, usage.output, usage.cache_read, usage.cache_write))
    usage_complete = "gateway" not in n.sequence_gaps and all(c.terminal is not None for c in admitted) and reported
    method = n.attempt.method
    metrics = Metrics(
        usage=usage,
        usage_complete=usage_complete,
        total_case_ns=timing.window.duration_ns if timing else None,
        timing=analyze(timing, method) if timing else None,
        timing_unavailable=unavailable,
        timing_method=method,
    )
    root = j.spans[0]
    j.spans[0] = SpanOut(**{**root.__dict__, "status": "partial" if coverage.partial else "ok"})
    result = (w.get(R.RESULT_READ) or [None])[0]
    return Projection(
        parser_version=PARSER_VERSION,
        attempt=n.attempt,
        model_calls=tuple(n.model_calls),
        tool_invocations=tuple(n.tools),
        commands=tuple(n.commands),
        processes=tuple(n.processes),
        harness_spans=tuple(n.harness_spans),
        spans=tuple(j.spans),
        links=tuple(j.links),
        coverage=coverage,
        metrics=metrics,
        issues=tuple(n.issues),
        workspace_diff=j.workspace_diff,
        result=dict(result.data.get("outcome") or {}) if result else None,
        placements=dict(j.placements),
        scopes=dict(j.scopes),
    )



