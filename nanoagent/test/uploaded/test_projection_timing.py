"""Timing analysis reproduced through stored records."""

from __future__ import annotations

from nanoagent.uploaded.projection import project
from nanoagent.uploaded.timing import Unknown
from test_projection_trace import Trace, sec


def plan_example(*, instrument_waits: bool = True) -> Trace:
    """0.1 s setup, an 8 s upstream call (600 tokens) in parallel with a 5 s command, a join, then 0.2 s finalizing."""
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    if instrument_waits:
        t.span_start(0.1, "w1", "operation", "await model", parent="root", data={"waits_on_call": "m1"})
        t.span_end(8.1, "w1")
    t.model_call("m1", ordinal=1, start=0.1, end=8.1, usage=(300, 300))
    t.command("r1", "l1", ["make"], start=0.1, end=5.1)
    t.span_end(8.3, "root")
    t.lifecycle(quiesce=8.3, cpu=(2_000_000_000, 500_000_000))
    t.finish(8.4)
    return t


def test_plan_timing_example_through_records() -> None:
    t = plan_example()
    p = project(t.records, t.payloads)
    assert not p.coverage.partial, p.coverage.reasons
    r = p.metrics.timing
    assert r is not None
    assert r.total_case_ns == sec(8.3)
    assert r.no_request_ns == sec(0.3)
    assert r.outside_waits_ns == sec(5.3)
    assert r.estimated_ns == sec(6.3)
    assert r.cpu_ns == sec(2.5)
    assert p.metrics.usage.total.known == 600
    flat = p.metrics.to_dict()
    assert flat["estimated_ns"] == sec(6.3) and flat["timing_method"]["reference_tokens_per_second"] == 100.0


def test_reference_rate_comes_from_the_pinned_method() -> None:
    t = plan_example()
    for r in t.records:
        if r["kind"] == "attempt.started":
            r["data"]["timing"]["reference_tokens_per_second"] = 200.0
    r = project(t.records, t.payloads).metrics.timing
    assert r is not None and r.estimated_ns == sec(5.3)  # modeled call 3 s: the 5 s command bounds 0.1 + 5 + 0.2


def test_without_wait_instrumentation_outside_waits_is_unknown() -> None:
    p = project(plan_example(instrument_waits=False).records, plan_example(instrument_waits=False).payloads)
    r = p.metrics.timing
    assert r is not None
    assert isinstance(r.outside_waits_ns, Unknown) and "wait" in r.outside_waits_ns.reason
    assert r.no_request_ns == sec(0.3) and r.estimated_ns == sec(6.3)


def test_opaque_harness_still_reports_total_cpu_and_no_request_time() -> None:
    t = Trace()
    t.started(expected=("gateway", "process", "worker"))
    t.model_call("m1", ordinal=1, start=0.5, end=1.5, usage=(10, 10))
    t.lifecycle(quiesce=2.0, cpu=(7, 3))
    r = project(t.records, t.payloads).metrics.timing
    assert r is not None
    assert (r.total_case_ns, r.no_request_ns, r.cpu_ns) == (sec(2.0), sec(1.0), 10)
    assert isinstance(r.outside_waits_ns, Unknown) and isinstance(r.estimated_ns, Unknown)


def test_missing_cpu_counters_are_unknown() -> None:
    t = plan_example()
    t.records[:] = [r for r in t.records if r["kind"] != "cpu.counters"]
    r = project(t.records, t.payloads).metrics.timing
    assert r is not None and isinstance(r.cpu_ns, Unknown)


def test_streamed_tool_launched_on_an_early_frame_overlaps_the_model_call() -> None:
    # call m1 streams for 4 s; its tool call completes at frame 1 (1 s in) and the tool starts then
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    t.span_start(0.0, "w1", "operation", "await", parent="root", data={"waits_on_call": "m1"})
    t.span_end(4.0, "w1")
    t.model_call("m1", ordinal=1, start=0.0, end=4.0, usage=(100, 300), frames=((100, 0.5), (100, 1.0), (300, 4.0)), early={"c1": 1},
                 proposals=(t.proposal("c1", "scan", {}, frame=1),))  # fmt: skip
    t.tool("t1", "scan", {}, start=1.0, end=3.0, cause=("m1", "c1"))
    t.span_end(4.0, "root")
    t.lifecycle(quiesce=4.0)
    r = project(t.records, t.payloads).metrics.timing
    assert r is not None
    assert r.total_case_ns == sec(4.0)
    # modeled: input 1 s before the first frame, output 3 s over 500 bytes; frame 1 is at 1 + 3 * 200/500 = 2.2 s,
    # so the tool runs 2.2..4.2 and the case takes 4.2 s instead of the modeled call's 4 s
    assert r.estimated_ns == sec(4.2)


def test_a_call_after_the_harness_closed_its_agent_span_does_not_break_the_graph() -> None:
    # Regression: the agent span ended at 0.01 s, before its (unplaced, so root-owned) call ran 0.05..0.10 s. The graph used to
    # count the time after the span's reported end on top of the call's own, reproducing more than the measured window.
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    t.span_end(0.01, "root")
    t.model_call("m1", ordinal=1, start=0.05, end=0.10, usage=(120, 4))
    t.lifecycle(quiesce=0.5)
    r = project(t.records, t.payloads).metrics.timing
    assert r is not None and r.total_case_ns == sec(0.5)
    # 0.05 s before the call, the call modeled at 124 tokens / 100 per s, then the 0.4 s after it
    assert r.estimated_ns == sec(1.69)


def test_a_case_that_never_ran_gives_every_timing_figure_its_reason() -> None:
    t = Trace()
    t.started()
    flat = project(t.records, t.payloads).metrics.to_dict("the source did not build, so no case ran")
    for name in ("elapsed_ms", "elapsed_ns", "no_request_ns", "outside_waits_ns", "cpu_ns", "estimated_ns"):
        assert flat[name] is None and flat[f"{name}_unknown"] == "the source did not build, so no case ran"
