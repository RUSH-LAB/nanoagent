"""Deterministic clock fixtures for the timing metrics, reproduced through stored records and the projection: serial calls, overlapping
requests, local work on a parallel branch, a retry with backoff, and the estimate under a changed upstream delay."""

from __future__ import annotations

from nanoagent.uploaded.projection import project
from nanoagent.uploaded.timing import Unknown
from test_projection_trace import Trace, sec


def waiting_call(t: Trace, call: str, wait: str, ordinal: int, start: float, end: float, usage: tuple[int, int] = (100, 100), parent: str = "root") -> None:
    """A call and the harness span that waits on it for exactly its duration."""
    t.span_start(start, wait, "operation", "await model", parent=parent, data={"waits_on_call": call})
    t.span_end(end, wait)
    t.model_call(call, ordinal=ordinal, start=start, end=end, usage=usage, span_ref=parent)


def timing(t: Trace):
    result = project(t.records, t.payloads).metrics.timing
    assert result is not None
    return result


def test_serial_calls_no_request_time_and_waits_are_exact() -> None:
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    waiting_call(t, "m1", "w1", 1, 0.0, 2.0)
    waiting_call(t, "m2", "w2", 2, 3.0, 5.0)
    t.span_end(6.0, "root")
    t.lifecycle(quiesce=6.0)
    r = timing(t)
    # 6 s in total: 4 s with a request in flight, and the branch blocked on upstream data for the same 4 s
    assert (r.total_case_ns, r.no_request_ns, r.outside_waits_ns) == (sec(6.0), sec(2.0), sec(2.0))
    # each call is modeled at 200 tokens / 100 per second = 2 s; the 1 s gap and the 1 s tail stay local: 2 + 1 + 2 + 1
    assert r.estimated_ns == sec(6.0)


def test_overlapping_requests_count_once_in_the_no_request_union() -> None:
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    t.span_start(0.0, "one", "subagent", "first branch", parent="root", data={"parent_blocked": True})
    t.span_start(2.0, "two", "subagent", "second branch", parent="root", data={"parent_blocked": True})
    waiting_call(t, "m1", "w1", 1, 0.0, 4.0, parent="one")
    waiting_call(t, "m2", "w2", 2, 2.0, 6.0, parent="two")
    t.span_end(4.0, "one")
    t.span_end(6.0, "two")
    t.span_end(7.0, "root")
    t.lifecycle(quiesce=7.0)
    r = timing(t)
    # the union of [0, 4] and [2, 6] is 6 s of the 7 s case, not 8 s
    assert (r.total_case_ns, r.no_request_ns) == (sec(7.0), sec(1.0))
    assert r.outside_waits_ns == sec(1.0)  # the root is held by its two branches and each is blocked on upstream data while it lives: only the last second is local


def test_local_work_on_a_parallel_branch_stays_outside_the_waits() -> None:
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    waiting_call(t, "m1", "w1", 1, 0.0, 8.0, usage=(300, 300))
    t.span_start(1.0, "work", "subagent", "local work", parent="root", data={"parent_blocked": False})
    t.span_end(5.0, "work")
    t.span_end(8.2, "root")
    t.lifecycle(quiesce=8.2)
    r = timing(t)
    # the model is the only blocker from 0 to 1 and from 5 to 8 (4 s): the work in between and the last 0.2 s are measured local time
    assert (r.total_case_ns, r.no_request_ns, r.outside_waits_ns) == (sec(8.2), sec(0.2), sec(4.2))
    # modeled call 6 s; the branch's 4 s of work overlaps it
    assert r.estimated_ns == sec(6.2)


def test_retry_backoff_is_local_time_the_estimate_preserves() -> None:
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    waiting_call(t, "m1", "w1", 1, 0.0, 1.0, usage=(50, 50))
    t.span_start(1.0, "pause", "operation", "retry backoff", parent="root")
    t.span_end(3.0, "pause")
    waiting_call(t, "m2", "w2", 2, 3.0, 5.0, usage=(100, 100))
    t.span_end(5.0, "root")
    t.lifecycle(quiesce=5.0)
    r = timing(t)
    # the 2 s of backoff is neither a request nor a wait; the calls are modeled at 1 s and 2 s
    assert (r.no_request_ns, r.outside_waits_ns, r.estimated_ns) == (sec(2.0), sec(2.0), sec(5.0))


def test_the_estimate_ignores_upstream_delay_while_the_measured_times_follow_it() -> None:
    def case(upstream_seconds: float):
        t = Trace()
        t.started()
        t.span_start(0.0, "root", "agent", "main")
        waiting_call(t, "m1", "w1", 1, 0.1, 0.1 + upstream_seconds, usage=(200, 400))
        t.span_end(0.1 + upstream_seconds + 0.2, "root")
        t.lifecycle(quiesce=0.1 + upstream_seconds + 0.2)
        return timing(t)

    fast, slow = case(2.0), case(30.0)
    assert fast.estimated_ns == slow.estimated_ns == sec(0.1 + 6.0 + 0.2)
    assert (fast.total_case_ns, slow.total_case_ns) == (sec(2.3), sec(30.3))
    assert (fast.no_request_ns, slow.no_request_ns) == (sec(0.3), sec(0.3))


def queued_tools_case(*, received: bool) -> Trace:
    """Two tools the harness launches together at 1.0 s; the second reaches its invocation only at 1.5 s, queued behind journaling."""
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    waiting_call(t, "m1", "w1", 1, 0.0, 1.0, usage=(50, 50))
    t.tool("t1", "scan", {}, start=1.0, end=2.0)
    t.tool("t2", "scan", {"slow": True}, start=1.5, end=3.0)
    if received:
        for record in t.records:
            if record["kind"] == "tool.invoked":
                record["data"]["received_ns"] = int(record["occurred_ns"]) + 1000 - (sec(0.5) if record["data"]["call_id"] == "t2" else 0)
    t.span_end(3.0, "root")
    t.lifecycle(quiesce=3.0)
    return t


def test_a_tool_queued_before_its_invocation_still_reproduces_elapsed_time_from_its_receipt() -> None:
    r = timing(queued_tools_case(received=True))
    assert r.estimated_ns == sec(1.0 + 2.0)  # the model call modeled at 1 s, then the longer tool from its receipt at 1.0 s
    # without the receipt the second tool looks like 1.5 s of work launched with the first: the path cannot reproduce the 3 s case
    assert isinstance(timing(queued_tools_case(received=False)).estimated_ns, Unknown)


def test_tools_launched_after_a_streamed_response_ended_keep_their_own_measured_gap_after_its_modeled_end() -> None:
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    t.span_start(0.0, "w1", "operation", "await model", parent="root", data={"waits_on_call": "m1"})
    t.span_end(2.0, "w1")
    # The gateway registered both proposals on early frames, but the harness started its tools only after the stream ended.
    t.model_call("m1", ordinal=1, start=0.0, end=2.0, usage=(100, 300), frames=((100, 0.5), (100, 1.0), (300, 2.0)), early={"c1": 0, "c2": 1},
                 proposals=(t.proposal("c1", "scan", {}, frame=0), t.proposal("c2", "scan", {}, frame=1)))  # fmt: skip
    t.tool("t1", "scan", {}, start=2.1, end=4.1, cause=("m1", "c1"))
    t.tool("t2", "scan", {}, start=2.15, end=4.2, cause=("m1", "c2"))  # reaches the broker 50 ms after the first
    waiting_call(t, "m2", "w2", 2, 4.3, 5.3, usage=(50, 50))
    t.span_end(5.4, "root")
    t.lifecycle(quiesce=5.4)
    r = timing(t)
    assert r.total_case_ns == sec(5.4)
    # m1 is modeled at 4 s (input 1 s, output 3 s). t1 starts 0.1 s after its end and runs 2.0 s; t2 starts 0.15 s after it and runs 2.05 s,
    # so it ends at 6.2 s. Then the 0.1 s gap, m2 modeled at 1 s, and the 0.1 s tail: 6.2 + 0.1 + 1.0 + 0.1.
    assert r.estimated_ns == sec(7.4)
