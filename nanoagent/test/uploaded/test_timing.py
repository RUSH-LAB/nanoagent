from dataclasses import replace

import pytest

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
    TimingMethod,
    Unknown,
    UpstreamCall,
    analyze,
    estimated_ns,
    local_cpu_ns,
    no_request_ns,
    outside_waits_ns,
)

FULL = Coverage(upstream=True, waits=True, branches=True, dependencies=True, cpu=True)


def s(seconds: float) -> int:
    return round(seconds * 1_000_000_000)


def iv(start: float, end: float) -> Interval:
    return Interval(s(start), s(end))


def act(name: str, start: float, end: float) -> Activity:
    return Activity(name, iv(start, end))


def call(name: str, start: float, end: float, tokens: tuple[int, int] | None = (400, 200), **kw) -> UpstreamCall:
    return UpstreamCall(name, iv(start, end), *(tokens or (None, None)), **kw)


def worked_example(upstream_seconds: float = 8.0, tokens: tuple[int, int] = (400, 200)) -> CaseTiming:
    """0.1 s setup, then an upstream call parallel to a 5 s command, then 0.2 s finalize."""
    end_call = 0.1 + upstream_seconds
    return CaseTiming(
        window=iv(0, end_call + 0.2),
        calls=(call("m", 0.1, end_call, tokens),),
        activities=(act("setup", 0, 0.1), act("cmd", 0.1, 5.1), act("fin", end_call, end_call + 0.2)),
        branches=(
            Branch("main0", iv(0, 0.1)),
            Branch("model", iv(0.1, end_call), (BranchWait("m", iv(0.1, end_call)),)),
            Branch("cmd", iv(0.1, 5.1)),
            Branch("main1", iv(end_call, end_call + 0.2)),
        ),
        edges=(Edge("setup", "m"), Edge("setup", "cmd"), Edge("m", "fin"), Edge("cmd", "fin")),
        coverage=FULL,
    )


def test_worked_example_from_the_plan():
    report = analyze(worked_example())
    assert report.total_case_ns == s(8.3)
    assert report.no_request_ns == s(0.3)
    assert report.outside_waits_ns == s(5.3)
    assert report.estimated_ns == s(6.3)


def test_serial_calls():
    timing = CaseTiming(
        window=iv(0, 5),
        calls=(call("a", 1, 2, (50, 50)), call("b", 3, 5, (100, 100))),
        activities=(act("w1", 0, 1), act("w2", 2, 3)),
        branches=(
            Branch("main", iv(0, 5), (BranchWait("a", iv(1, 2)), BranchWait("b", iv(3, 5)))),
        ),
        edges=(Edge("w1", "a"), Edge("a", "w2"), Edge("w2", "b")),
        coverage=FULL,
    )
    assert no_request_ns(timing) == s(2)
    # the activities w1/w2 are not concurrent with the waits, so only waits are subtracted
    assert outside_waits_ns(timing) == s(2)
    # w1 1 s, a 1 s, w2 1 s, b 2 s
    assert estimated_ns(timing) == s(5)


def test_overlapping_requests():
    timing = CaseTiming(
        window=iv(0, 6),
        calls=(call("a", 0, 4, (100, 100)), call("b", 1, 6, (100, 300))),
        activities=(),
        branches=(
            Branch("ba", iv(0, 4), (BranchWait("a", iv(0, 4)),)),
            Branch("bb", iv(1, 6), (BranchWait("b", iv(1, 6)),)),
        ),
        edges=(),
        coverage=FULL,
    )
    assert no_request_ns(timing) == 0
    assert outside_waits_ns(timing) == 0
    # a models 2 s, b models 4 s, both start at the case start
    assert estimated_ns(timing, TimingMethod(clock_tolerance_ns=s(1))) == s(4)


def test_local_work_on_a_parallel_branch_keeps_wait_counted():
    timing = worked_example()
    assert outside_waits_ns(timing) == s(5.3)
    # with no command, the model is the sole blocker for the whole call
    lone = replace(
        timing,
        activities=tuple(a for a in timing.activities if a.activity_id != "cmd"),
        branches=tuple(b for b in timing.branches if b.branch_id != "cmd"),
        edges=(Edge("setup", "m"), Edge("m", "fin")),
    )
    assert outside_waits_ns(lone) == s(0.3)


def test_streamed_tool_launched_before_final_frame():
    # 1000 input+output tokens at 100/s = 10 s modeled; observed 20 s. Input 200 -> 2 s before frame 0.
    frames = (Frame(100, s(5)), Frame(100, s(10)), Frame(200, s(20)))
    streamed = UpstreamCall("m", iv(0, 20), 200, 800, streamed=True, frames=frames)
    timing = CaseTiming(
        window=iv(0, 21),
        calls=(streamed,),
        activities=(act("tool", 5, 21),),
        branches=(),
        edges=(Edge("m", "tool", frame=0),),
        coverage=FULL,
    )
    # observed: tool starts at frame 0 (5 s) and runs 16 s -> 21 s total
    # modeled: frame 0 at 2 s + 8 s * 100/400 = 4 s; tool 16 s -> 20 s (call ends at 10 s)
    assert estimated_ns(timing) == s(4 + 16)


def test_retry_backoff_is_preserved():
    timing = CaseTiming(
        window=iv(0, 13),
        calls=(call("a", 0, 6, (100, 0)), call("b", 8, 13, (100, 100))),
        activities=(act("backoff", 6, 8),),
        branches=(),
        edges=(Edge("a", "backoff"), Edge("backoff", "b")),
        coverage=FULL,
    )
    # a: 1 s, backoff 2 s, b: 2 s
    assert estimated_ns(timing) == s(5)


def test_estimate_is_invariant_to_upstream_delay():
    base = estimated_ns(worked_example(8.0))
    assert base == s(6.3)
    for delay in (6.5, 8.0, 20.0):
        assert estimated_ns(worked_example(delay)) == base


def test_reference_rate_changes_the_estimate():
    timing = worked_example()
    # 600 tokens at 200/s = 3 s, command still 5 s: 0.1 + 5 + 0.2
    assert estimated_ns(timing, TimingMethod(reference_tokens_per_second=200)) == s(5.3)
    assert estimated_ns(timing, TimingMethod(reference_tokens_per_second=50)) == s(12.3)


@pytest.mark.parametrize("rate", [0, -1, float("inf"), float("nan")])
def test_reference_rate_must_be_positive_and_finite(rate: float):
    with pytest.raises(ValueError):
        TimingMethod(reference_tokens_per_second=rate)


def test_missing_tokens_is_unknown():
    timing = worked_example()
    timing = replace(timing, calls=(call("m", 0.1, 8.1, None),))
    result = estimated_ns(timing)
    assert isinstance(result, Unknown) and "m" in result.reason


def test_incomplete_dependency_coverage_is_unknown():
    timing = replace(worked_example(), coverage=replace(FULL, dependencies=False))
    assert isinstance(estimated_ns(timing), Unknown)


def test_graph_that_does_not_reproduce_elapsed_time_is_unknown():
    timing = replace(worked_example(), edges=(Edge("setup", "m"), Edge("setup", "cmd"), Edge("cmd", "fin")))
    result = estimated_ns(timing)
    assert isinstance(result, Unknown) and "reproduces" in result.reason


def test_cycle_and_dangling_edges_are_unknown():
    timing = worked_example()
    assert isinstance(estimated_ns(replace(timing, edges=timing.edges + (Edge("fin", "setup"),))), Unknown)
    assert isinstance(estimated_ns(replace(timing, edges=timing.edges + (Edge("ghost", "setup"),))), Unknown)


def test_streamed_call_without_frames_is_unknown():
    timing = worked_example()
    streamed = replace(timing.calls[0], streamed=True)
    assert isinstance(estimated_ns(replace(timing, calls=(streamed,))), Unknown)


def test_incomplete_wait_or_branch_coverage_is_unknown():
    timing = worked_example()
    assert isinstance(outside_waits_ns(replace(timing, coverage=replace(FULL, waits=False))), Unknown)
    assert isinstance(outside_waits_ns(replace(timing, coverage=replace(FULL, branches=False))), Unknown)


def test_wait_not_ending_at_its_response_boundary_is_unknown():
    timing = worked_example()
    bad = replace(timing.branches[1], waits=(BranchWait("m", iv(0.1, 7.0)),))
    result = outside_waits_ns(replace(timing, branches=(timing.branches[0], bad) + timing.branches[2:]))
    assert isinstance(result, Unknown)


def test_incomplete_upstream_coverage_is_unknown():
    assert isinstance(no_request_ns(replace(worked_example(), coverage=replace(FULL, upstream=False))), Unknown)


def test_cpu_deduplicates_process_identity():
    timing = replace(
        worked_example(),
        cpu=(CpuCounter("p1", 3, 2), CpuCounter("p1", 3, 2), CpuCounter("p2", 10, 0)),
    )
    assert local_cpu_ns(timing) == 15
    conflicting = replace(timing, cpu=(CpuCounter("p1", 3, 2), CpuCounter("p1", 4, 2)))
    assert isinstance(local_cpu_ns(conflicting), Unknown)
    assert isinstance(local_cpu_ns(replace(timing, coverage=replace(FULL, cpu=False))), Unknown)


def test_zero_model_calls_equal_case_time():
    timing = CaseTiming(
        window=iv(0, 3),
        calls=(),
        activities=(act("work", 0, 3),),
        branches=(),
        edges=(),
        coverage=replace(FULL, waits=False, dependencies=False, no_model_calls=True),
    )
    report = analyze(timing)
    assert report.total_case_ns == s(3)
    assert report.outside_waits_ns == s(3)
    assert report.estimated_ns == s(3)
    assert report.no_request_ns == s(3)


def test_zero_calls_without_proof_is_unknown():
    timing = CaseTiming(iv(0, 3), (), (), (), (), replace(FULL, waits=False, dependencies=False))
    assert isinstance(outside_waits_ns(timing), Unknown)
    assert isinstance(estimated_ns(timing), Unknown)


def test_interval_rejects_reversed_bounds():
    with pytest.raises(ValueError):
        Interval(5, 1)
