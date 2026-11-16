"""Builds the `CaseTiming` that `timing.analyze` consumes from normalized records.

Harness instrumentation is what makes waits, branches and dependencies knowable. A harness declares a wait with a span whose
start `data` has `waits_on_call` (a gateway call ID); the end event's `data.unblocked_by_frame` names the releasing frame of a
streamed call. A subagent whose start `data.parent_blocked` is true holds its parent in a join for its whole span. Without a
closed root agent span and unrejected harness events, waits, branches and dependencies are not covered and the analysis
reports Unknown for the metrics that need them.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from nanoagent.uploaded import records as R
from nanoagent.uploaded.projection_model import HarnessSpan, Issue
from nanoagent.uploaded.projection_normalize import Normalized, load_json
from nanoagent.uploaded.timing import (
    Activity,
    Branch,
    BranchWait,
    CaseTiming,
    Coverage,
    CpuCounter,
    Edge,
    Frame,
    Interval,
    UpstreamCall,
)

CausalEdge = tuple[str, str, int | None, int]  # (before node, after node, frame, measured lag after the release)


def tool_node(call_id: str) -> str:
    return f"tool:{call_id}"


def command_node(request_id: str) -> str:
    return f"cmd:{request_id}"


@dataclass(frozen=True)
class _Item:
    entry: str
    exit: str
    start: int
    end: int
    joined: bool = True


def _first(n: Normalized, kind: str) -> R.Record | None:
    found = n.worker.get(kind)
    return found[0] if found else None


def _cpu(n: Normalized) -> tuple[tuple[CpuCounter, ...], bool]:
    counters = [
        CpuCounter(json.dumps(p.get("identity"), sort_keys=True), int(p.get("user_ns", 0)), int(p.get("system_ns", 0)))
        for r in n.worker.get(R.CPU_COUNTERS, ())
        for p in r.data.get("processes") or ()
    ]
    health = n.worker.get(R.COLLECTOR_HEALTH)
    covered = bool(counters or n.worker.get(R.CPU_COUNTERS)) and bool(health) and all(h.data.get("complete") for h in health)
    return tuple(counters), covered


def _calls(n: Normalized, payloads: Mapping[str, bytes], issues: list[Issue]) -> tuple[list[UpstreamCall], bool]:
    calls: list[UpstreamCall] = []
    complete = "gateway" not in n.sequence_gaps
    for c in n.model_calls:
        if c.rejected is not None or c.maybe_reached is False:
            continue
        if c.admitted_ns is not None and c.terminal is None:
            complete = False  # admitted, never concluded
            continue
        if c.dispatched_ns is None or c.completed_ns is None or c.completed_ns < c.dispatched_ns:
            issues.append(Issue("call_interval_invalid", f"model call {c.call_id} has no usable upstream interval", c.evidence))
            complete = False
            continue
        frames: tuple[Frame, ...] = ()
        index = load_json(payloads, c.frames_sha256)
        if isinstance(index, list):
            frames = tuple(Frame(int(f["bytes"]), int(f["available_ns"])) for f in index)
        usage = c.usage
        calls.append(
            UpstreamCall(
                c.call_id,
                Interval(c.dispatched_ns, c.completed_ns),
                usage.input if usage else None,
                usage.output if usage else None,
                streamed=c.frame_count is not None,
                frames=frames,
            )
        )
    return calls, complete


class _Graph:
    def __init__(self, calls: Sequence[UpstreamCall]) -> None:
        self.activities: list[Activity] = []
        self.edges: list[Edge] = []
        self._calls = {c.call_id: c for c in calls}
        self._n = 0

    def node(self, prefix: str, start: int, end: int) -> str:
        self._n += 1
        node_id = f"{prefix}#{self._n}"
        self.activities.append(Activity(node_id, Interval(start, max(start, end))))
        return node_id

    def edge(self, before: str, after: str, frame: int | None = None, lag_ns: int = 0) -> None:
        self.edges.append(Edge(before, after, frame, lag_ns))

    def branch(self, key: str, start: int, end: int, items: list[_Item]) -> tuple[str, str]:
        """Series of parallel clusters with local gaps between them; returns the branch's entry and exit nodes."""
        entry = self.node(f"in:{key}", start, start)
        previous, prev_end = entry, start
        detached: list[str] = []
        clusters: list[list[_Item]] = []
        for item in sorted(items, key=lambda i: (i.start, i.end)):
            if clusters and item.start < max(i.end for i in clusters[-1]):
                clusters[-1].append(item)
            else:
                clusters.append([item])
        for cluster in clusters:
            cluster_start, cluster_end = min(i.start for i in cluster), max(i.end for i in cluster)
            current = previous
            if cluster_start > prev_end:
                current = self.node(f"gap:{key}", prev_end, cluster_start)
                self.edge(previous, current)
            join = self.node(f"join:{key}", cluster_end, cluster_end)
            for item in cluster:
                self.edge(current, item.entry)
                if item.joined:
                    self.edge(item.exit, join)
                else:
                    detached.append(item.exit)
            previous, prev_end = join, max(prev_end, cluster_end)
        out = previous
        if end > prev_end:
            out = self.node(f"gap:{key}", prev_end, end)
            self.edge(previous, out)
        if detached:
            final = self.node(f"end:{key}", end, end)
            self.edge(out, final)
            for exit_node in detached:
                self.edge(exit_node, final)
            out = final
        return entry, out


def build_timing(
    n: Normalized,
    placements: Mapping[str, str | None],
    causal: Sequence[CausalEdge],
    payloads: Mapping[str, bytes],
    harness_refs_ok: bool,
) -> tuple[CaseTiming | None, str | None, list[Issue]]:
    issues: list[Issue] = []
    launched, quiesced = _first(n, R.CASE_LAUNCHED), _first(n, R.CASE_QUIESCED)
    if launched is None or quiesced is None:
        return None, "case launch or quiescence was not recorded", issues
    start, end = int(launched.data["launch_ns"]), int(quiesced.data["quiesced_ns"])
    if end < start:
        return None, "case quiesced before it launched", issues
    window = Interval(start, end)
    calls, upstream = _calls(n, payloads, issues)
    cpu, cpu_covered = _cpu(n)
    no_model_calls = upstream and not calls
    spans = {s.span_id: s for s in n.harness_spans}
    root = next((s for s in n.harness_spans if s.kind == "agent"), None)
    instrumented = root is not None and root.end_ns is not None and not n.harness_rejected and "harness" not in n.sequence_gaps and harness_refs_ok
    if not instrumented:
        cov = Coverage(upstream, False, False, False, cpu_covered, no_model_calls)
        return CaseTiming(window, tuple(calls), (), (), (), cov, cpu), None, issues
    assert root is not None

    def interval(span: HarnessSpan) -> tuple[int, int]:
        s = min(max(span.start_ns, start), end)
        return s, max(s, min(span.end_ns if span.end_ns is not None else end, end))

    def branch_of(span_id: str | None) -> str:
        while span_id in spans:
            if spans[span_id].kind in ("agent", "subagent"):
                return span_id  # type: ignore[return-value]
            span_id = spans[span_id].parent_id
        return root.span_id

    graph = _Graph(calls)
    call_ids = {c.call_id for c in calls}
    items: dict[str, list[_Item]] = {}
    placed_under: set[str] = set()

    def put(key: str, span_id: str | None, entry: str, s: int, e: int) -> None:
        placed_under.add(span_id) if span_id in spans else None
        items.setdefault(branch_of(span_id), []).append(_Item(entry, entry, min(max(s, start), end), min(max(e, start), end)))

    for c in calls:
        put(c.call_id, placements.get(c.call_id), c.call_id, c.interval.start_ns, c.interval.end_ns)
    for t in n.tools:
        if t.rejected is None and t.start_ns is not None and t.end_ns is not None:
            node = tool_node(t.call_id)
            graph.activities.append(Activity(node, Interval(*_clip(t.start_ns, t.end_ns, start, end))))
            put(node, placements.get(t.call_id), node, t.start_ns, t.end_ns)
    for cmd in n.commands:
        if cmd.rejected is None and cmd.start_ns is not None and cmd.end_ns is not None:
            node = command_node(cmd.request_id)
            graph.activities.append(Activity(node, Interval(*_clip(cmd.start_ns, cmd.end_ns, start, end))))
            put(node, placements.get(cmd.request_id), node, cmd.start_ns, cmd.end_ns)

    waits: dict[str, list[BranchWait]] = {}
    waited: set[str] = set()
    waits_ok = upstream
    for span in n.harness_spans:
        target = span.data.get("waits_on_call")
        if target is None:
            continue
        if target not in call_ids:
            issues.append(Issue("wait_on_unrecorded_call", f"harness span {span.span_id} waits on {target!r}, which is not a dispatched call", span.evidence))
            waits_ok = False
            continue
        frame = span.end_data.get("unblocked_by_frame", span.data.get("unblocked_by_frame"))
        s, e = interval(span)
        waits.setdefault(branch_of(span.span_id), []).append(BranchWait(target, Interval(s, e), frame))
        waited.add(target)
    waits_ok = waits_ok and waited >= call_ids

    children: dict[str, list[HarnessSpan]] = {}
    for span in n.harness_spans:
        if span.kind == "subagent":
            children.setdefault(branch_of(span.parent_id), []).append(span)
    for span in n.harness_spans:  # local work the harness reports and nothing observed sits under
        is_leaf = span.kind in ("tool", "memory", "operation", "decision") and span.data.get("waits_on_call") is None
        if is_leaf and span.span_id not in placed_under and not any(o.parent_id == span.span_id for o in n.harness_spans):
            s, e = interval(span)
            node = f"local:{span.span_id}"
            graph.activities.append(Activity(node, Interval(s, e)))
            items.setdefault(branch_of(span.span_id), []).append(_Item(node, node, s, e))

    extents: dict[str, tuple[int, int]] = {}

    def extent(span: HarnessSpan) -> tuple[int, int]:
        """The span's reported interval widened to hold what was observed under it: a call dispatched after the harness closed
        its agent span (or a call it never placed, which belongs to the root) still ran in that branch, so the branch cannot
        end before it. Without this the graph counts the time after the span's reported end on top of the call's own time."""
        if span.span_id not in extents:
            s, e = interval(span)
            for item in items.get(span.span_id, ()):
                s, e = min(s, item.start), max(e, item.end)
            for child in children.get(span.span_id, ()):
                child_start, child_end = extent(child)
                s, e = min(s, child_start), max(e, child_end)
            extents[span.span_id] = (s, e)
        return extents[span.span_id]

    def build(span: HarnessSpan) -> tuple[str, str]:
        mine = list(items.get(span.span_id, ()))
        for child in children.get(span.span_id, ()):
            entry, out = build(child)
            s, e = extent(child)
            mine.append(_Item(entry, out, s, e, joined=bool(child.data.get("parent_blocked"))))
        s, e = extent(span)
        return graph.branch(span.span_id, s, e, mine)

    root_entry, root_exit = build(root)
    rs, re_ = extent(root)
    entry, out = graph.branch("case", start, end, [_Item(root_entry, root_exit, rs, re_)])
    del entry, out

    node_ids = {a.activity_id for a in graph.activities} | call_ids
    for before, after, frame, lag in causal:
        if before in node_ids and after in node_ids:
            graph.edge(before, after, frame, lag)

    branches: list[Branch] = []
    for span in n.harness_spans:
        if span.kind not in ("agent", "subagent"):
            continue
        s, e = extent(span)
        holes = sorted(extent(c) for c in children.get(span.span_id, ()) if c.data.get("parent_blocked"))
        pieces, cursor = [], s
        for hs, he in holes:
            if hs > cursor:
                pieces.append((cursor, hs))
            cursor = max(cursor, he)
        if cursor < e or not pieces:
            pieces.append((cursor, e))
        for k, (ps, pe) in enumerate(pieces):
            mine = tuple(w for w in waits.get(span.span_id, ()) if ps <= w.interval.start_ns < max(pe, ps + 1))
            branches.append(Branch(f"{span.span_id}#{k}", Interval(ps, pe), mine))

    cov = Coverage(upstream, waits_ok, True, upstream, cpu_covered, no_model_calls)
    return CaseTiming(window, tuple(calls), tuple(graph.activities), tuple(branches), tuple(graph.edges), cov, cpu), None, issues


def _clip(s: int, e: int, lo: int, hi: int) -> tuple[int, int]:
    s = min(max(s, lo), hi)
    return s, max(s, min(e, hi))
