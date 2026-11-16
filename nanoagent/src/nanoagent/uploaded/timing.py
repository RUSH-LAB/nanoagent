"""Case timing metrics over recorded worker evidence.

Every function here is deterministic over typed inputs. All times are integer nanoseconds on one worker
monotonic clock. A metric is either an ``int`` (nanoseconds) or an `Unknown` naming the missing evidence.
"""

import math
from dataclasses import dataclass

DEFAULT_REFERENCE_TOKENS_PER_SECOND = 100.0
DEFAULT_CLOCK_TOLERANCE_NS = 1_000_000
NS_PER_SECOND = 1_000_000_000


@dataclass(frozen=True)
class Unknown:
    reason: str


Metric = int | Unknown


@dataclass(frozen=True)
class Interval:
    start_ns: int
    end_ns: int

    def __post_init__(self) -> None:
        if self.end_ns < self.start_ns:
            raise ValueError(f"interval ends before it starts: {self.start_ns}..{self.end_ns}")

    @property
    def duration_ns(self) -> int:
        return self.end_ns - self.start_ns

    def contains(self, t_ns: int) -> bool:
        return self.start_ns <= t_ns < self.end_ns


@dataclass(frozen=True)
class Frame:
    """One streamed response frame: its original byte length and when it became available."""

    byte_length: int
    available_ns: int


@dataclass(frozen=True)
class UpstreamCall:
    """One physical upstream request, dispatch to terminal response, error or cancel."""

    call_id: str
    interval: Interval
    input_tokens: int | None
    output_tokens: int | None
    streamed: bool = False
    frames: tuple[Frame, ...] = ()


@dataclass(frozen=True)
class Activity:
    """Local work (command, tool, harness work, scheduling or backoff delay)."""

    activity_id: str
    interval: Interval


@dataclass(frozen=True)
class BranchWait:
    """A live branch blocked on an upstream call until a response boundary.

    `unblocked_by_frame` is the index of the streamed frame that released the branch, or None when
    the terminal response did.
    """

    call_id: str
    interval: Interval
    unblocked_by_frame: int | None = None


@dataclass(frozen=True)
class Branch:
    """A run of live control. A parent joined on its children is not live while they run."""

    branch_id: str
    live: Interval
    waits: tuple[BranchWait, ...] = ()


@dataclass(frozen=True)
class Edge:
    """`before` precedes `after`. `frame` releases `after` at that frame of a streamed call. `lag_ns` is measured local time between the
    release and `after`, such as a harness acting on a response only after it ended; it is kept as measured."""

    before: str
    after: str
    frame: int | None = None
    lag_ns: int = 0


@dataclass(frozen=True)
class Coverage:
    upstream: bool
    waits: bool
    branches: bool
    dependencies: bool
    cpu: bool
    no_model_calls: bool = False


@dataclass(frozen=True)
class CpuCounter:
    process_id: str
    user_ns: int
    system_ns: int


@dataclass(frozen=True)
class CaseTiming:
    window: Interval
    calls: tuple[UpstreamCall, ...]
    activities: tuple[Activity, ...]
    branches: tuple[Branch, ...]
    edges: tuple[Edge, ...]
    coverage: Coverage
    cpu: tuple[CpuCounter, ...] = ()


@dataclass(frozen=True)
class TimingMethod:
    reference_tokens_per_second: float = DEFAULT_REFERENCE_TOKENS_PER_SECOND
    clock_tolerance_ns: int = DEFAULT_CLOCK_TOLERANCE_NS

    def __post_init__(self) -> None:
        if not math.isfinite(self.reference_tokens_per_second) or self.reference_tokens_per_second <= 0:
            raise ValueError(f"reference_tokens_per_second must be positive and finite: {self.reference_tokens_per_second}")
        if self.clock_tolerance_ns < 0:
            raise ValueError(f"clock_tolerance_ns must not be negative: {self.clock_tolerance_ns}")


@dataclass(frozen=True)
class TimingReport:
    total_case_ns: int
    no_request_ns: Metric
    outside_waits_ns: Metric
    cpu_ns: Metric
    estimated_ns: Metric


def total_case_ns(timing: CaseTiming) -> int:
    return timing.window.duration_ns


def _clipped(interval: Interval, window: Interval) -> Interval | None:
    start, end = max(interval.start_ns, window.start_ns), min(interval.end_ns, window.end_ns)
    return Interval(start, end) if start < end else None


def no_request_ns(timing: CaseTiming) -> Metric:
    if not timing.coverage.upstream:
        return Unknown("upstream request coverage is incomplete")
    clipped = sorted(
        (c.start_ns, c.end_ns) for call in timing.calls if (c := _clipped(call.interval, timing.window)) is not None
    )
    covered, reach = 0, timing.window.start_ns
    for start, end in clipped:
        start = max(start, reach)
        if end > start:
            covered += end - start
            reach = end
    return total_case_ns(timing) - covered


def _wait_release_ns(call: UpstreamCall, wait: BranchWait) -> int | Unknown:
    if wait.unblocked_by_frame is None:
        return call.interval.end_ns
    if not 0 <= wait.unblocked_by_frame < len(call.frames):
        return Unknown(f"wait on {call.call_id} names missing frame {wait.unblocked_by_frame}")
    return call.frames[wait.unblocked_by_frame].available_ns


def _check_waits(timing: CaseTiming, method: TimingMethod) -> Unknown | None:
    calls = {call.call_id: call for call in timing.calls}
    for branch in timing.branches:
        for wait in branch.waits:
            call = calls.get(wait.call_id)
            if call is None:
                return Unknown(f"branch {branch.branch_id} waits on unrecorded call {wait.call_id}")
            release = _wait_release_ns(call, wait)
            if isinstance(release, Unknown):
                return release
            if abs(release - wait.interval.end_ns) > method.clock_tolerance_ns:
                return Unknown(f"branch {branch.branch_id} wait on {wait.call_id} does not end at its response boundary")
    return None


def outside_waits_ns(timing: CaseTiming, method: TimingMethod = TimingMethod()) -> Metric:
    if not timing.calls and timing.coverage.no_model_calls:
        return total_case_ns(timing)
    if not (timing.coverage.waits and timing.coverage.branches):
        return Unknown("wait or branch coverage is incomplete")
    invalid = _check_waits(timing, method)
    if invalid is not None:
        return invalid
    window = timing.window
    points = {window.start_ns, window.end_ns}
    for branch in timing.branches:
        points.update((branch.live.start_ns, branch.live.end_ns))
        for wait in branch.waits:
            points.update((wait.interval.start_ns, wait.interval.end_ns))
    for activity in timing.activities:
        points.update((activity.interval.start_ns, activity.interval.end_ns))
    bounds = sorted(p for p in points if window.start_ns <= p <= window.end_ns)
    blocked = 0
    for start, end in zip(bounds, bounds[1:]):
        live = [b for b in timing.branches if b.live.contains(start)]
        all_blocked = bool(live) and all(any(w.interval.contains(start) for w in b.waits) for b in live)
        if all_blocked and not any(a.interval.contains(start) for a in timing.activities):
            blocked += end - start
    return total_case_ns(timing) - blocked


def local_cpu_ns(timing: CaseTiming) -> Metric:
    if not timing.coverage.cpu:
        return Unknown("CPU coverage is incomplete")
    by_process: dict[str, int] = {}
    for counter in timing.cpu:
        total = counter.user_ns + counter.system_ns
        if by_process.setdefault(counter.process_id, total) != total:
            return Unknown(f"conflicting CPU counters for process {counter.process_id}")
    return sum(by_process.values())


def _modeled_call_ns(call: UpstreamCall, method: TimingMethod) -> int:
    assert call.input_tokens is not None and call.output_tokens is not None
    return round((call.input_tokens + call.output_tokens) * NS_PER_SECOND / method.reference_tokens_per_second)


def _modeled_frame_offsets(call: UpstreamCall, method: TimingMethod) -> tuple[int, ...]:
    assert call.input_tokens is not None and call.output_tokens is not None
    input_ns = round(call.input_tokens * NS_PER_SECOND / method.reference_tokens_per_second)
    output_ns = round(call.output_tokens * NS_PER_SECOND / method.reference_tokens_per_second)
    total_bytes = sum(f.byte_length for f in call.frames)
    offsets, seen = [], 0
    for frame in call.frames:
        seen += frame.byte_length
        offsets.append(input_ns + round(output_ns * seen / total_bytes))
    return tuple(offsets)


def _observed_frame_offsets(call: UpstreamCall) -> tuple[int, ...]:
    return tuple(f.available_ns - call.interval.start_ns for f in call.frames)


def _longest_path_ns(timing: CaseTiming, durations: dict[str, int], frame_offsets: dict[str, tuple[int, ...]]) -> Metric:
    """Longest dependency path from the case start, or Unknown when the graph is malformed."""
    preds: dict[str, list[Edge]] = {node: [] for node in durations}
    for edge in timing.edges:
        if edge.before not in durations or edge.after not in durations:
            return Unknown(f"dependency {edge.before} -> {edge.after} names an unrecorded activity")
        offsets = frame_offsets.get(edge.before)
        if edge.frame is not None and (offsets is None or not 0 <= edge.frame < len(offsets)):
            return Unknown(f"dependency {edge.before} -> {edge.after} names a missing frame {edge.frame}")
        preds[edge.after].append(edge)
    start: dict[str, int] = {}
    visiting: set[str] = set()

    def start_of(node: str) -> int | None:
        if node in start:
            return start[node]
        if node in visiting:
            return None
        visiting.add(node)
        begin = 0
        for edge in preds[node]:
            before = start_of(edge.before)
            if before is None:
                return None
            release = durations[edge.before] if edge.frame is None else frame_offsets[edge.before][edge.frame]
            begin = max(begin, before + release + edge.lag_ns)
        visiting.discard(node)
        start[node] = begin
        return begin

    for node in durations:
        if start_of(node) is None:
            return Unknown("dependency graph has a cycle")
    return max((start[node] + durations[node] for node in durations), default=0)


def estimated_ns(timing: CaseTiming, method: TimingMethod = TimingMethod()) -> Metric:
    if not timing.calls and timing.coverage.no_model_calls:
        return total_case_ns(timing)
    if not timing.coverage.dependencies:
        return Unknown("dependency evidence is incomplete")
    missing = [c.call_id for c in timing.calls if c.input_tokens is None or c.output_tokens is None]
    if missing:
        return Unknown(f"calls without recorded tokens: {', '.join(missing)}")
    streamed_without_frames = [c.call_id for c in timing.calls if c.streamed and not (c.frames and sum(f.byte_length for f in c.frames) > 0)]
    if streamed_without_frames:
        return Unknown(f"streamed calls without frames: {', '.join(streamed_without_frames)}")
    ids = [a.activity_id for a in timing.activities] + [c.call_id for c in timing.calls]
    if len(set(ids)) != len(ids):
        return Unknown("activity and call ids are not unique")
    observed = {a.activity_id: a.interval.duration_ns for a in timing.activities}
    observed.update({c.call_id: c.interval.duration_ns for c in timing.calls})
    observed_frames = {c.call_id: _observed_frame_offsets(c) for c in timing.calls if c.streamed}
    reproduced = _longest_path_ns(timing, observed, observed_frames)
    if isinstance(reproduced, Unknown):
        return reproduced
    if abs(reproduced - total_case_ns(timing)) > method.clock_tolerance_ns:
        return Unknown(f"dependency graph reproduces {reproduced} ns, not the measured {total_case_ns(timing)} ns")
    modeled = {a.activity_id: a.interval.duration_ns for a in timing.activities}
    modeled.update({c.call_id: _modeled_call_ns(c, method) for c in timing.calls})
    modeled_frames = {c.call_id: _modeled_frame_offsets(c, method) for c in timing.calls if c.streamed}
    return _longest_path_ns(timing, modeled, modeled_frames)


def analyze(timing: CaseTiming, method: TimingMethod = TimingMethod()) -> TimingReport:
    return TimingReport(
        total_case_ns=total_case_ns(timing),
        no_request_ns=no_request_ns(timing),
        outside_waits_ns=outside_waits_ns(timing, method),
        cpu_ns=local_cpu_ns(timing),
        estimated_ns=estimated_ns(timing, method),
    )
