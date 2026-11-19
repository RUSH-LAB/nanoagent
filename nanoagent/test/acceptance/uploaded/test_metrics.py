"""CLI acceptance gate: token and timing metrics, from real worker runs of the scripted-loop harness.

Run on the host (the worker runs in the worker container, see support.py):

    .venv/bin/python -m pytest test/acceptance/uploaded/test_metrics.py -m uploaded_acceptance

One worker serves one scripted upstream, and the runs are submitted one after the other through step 2, so each takes the next
turns of the scenario. Token rows come from the three dialects (cumulative Anthropic counters, a retry, a missing-usage call,
known-zero fields and a request refused before dispatch). Timing rows hold tokens, local work and dependencies fixed while the
upstream delay (mock `ttfb` and `gap`) or the worker's reference rate changes. Unit-level fixtures for the timing arithmetic are
in test/uploaded/test_timing.py and test_projection_timing.py; everything here comes from a real run's stored evidence.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
import scripted  # noqa: F401 - puts the helper directories on sys.path before the imports below
import support
from rush_server import RushServer, rush_server, unavailable
from scripted import ANSWER, Session, session, turn

from nanoagent.plugin.package import pack
from nanoagent.uploaded.client import BenchmarkClient

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]

PROBE = support.NANOAGENT / "test" / "plugins" / "acceptance-probe"
NS = 1_000_000_000
# The worker YAML's clock tolerance. It must cover how late the harness reacts to a response boundary as the worker sees it: a tool
# launched on a frame is received after the frame was available by the harness reading and parsing the line, starting a thread
# and its request crossing the sandbox network (6-31 ms over the runs below), and a wait ends when the harness's report of it is
# received. The gateway hands frames over within a few ms and journals off that path, so journaling no longer adds to the lag
# (it did, by tens to hundreds of ms per event, which this value used to be 400 ms to absorb). About three times the worst launch lag.
TOLERANCE_NS = 100_000_000
FIELDS = ("total_tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable() or support.container_unavailable()
    if reason:
        pytest.skip(reason)
    with rush_server() as server:
        server.seed_plugin(pack(PROBE))
        yield server


@dataclass
class Ran:
    """One finished run: the step 2 report, the stored events and the accounting, and what the upstream served for it."""

    name: str
    run: Any
    client: BenchmarkClient
    events: list[dict[str, Any]]
    accounting: dict[str, Any]
    served: list[Any]  # the mock's main calls for this run

    @property
    def attempt(self) -> Any:
        return self.run.attempts[0]

    @property
    def metrics(self) -> dict[str, Any]:
        return self.attempt.metrics

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [event for event in self.events if event["kind"] == kind]

    def payload(self, digest: str) -> Any:
        return json.loads(self.client.payload(self.attempt.attempt_id, digest).data)

    @property
    def window_ns(self) -> tuple[int, int]:
        return self.of("case.launched")[0]["data"]["launch_ns"], self.of("case.quiesced")[0]["data"]["quiesced_ns"]

    def harness_events(self) -> list[dict[str, Any]]:
        """Each harness event as the harness sent it, with the time the worker received it."""
        return [{**self.payload(event["data"]["event_sha256"]), "ns": int(event["occurred_ns"])} for event in self.of("harness.event")]

    def calls(self) -> list[tuple[int, int]]:
        """Dispatch and completion of every physical request that reached upstream."""
        return sorted((e["data"]["dispatched_ns"], e["data"]["completed_ns"]) for e in self.of("model_call.response"))


def execute(sess: Session, name: str, script: dict[str, Any], rush: RushServer) -> Ran:
    before = len(sess.handle.ledger.main_calls)
    run = sess.submit(name, script)
    attempt = run.attempts[0]
    client = BenchmarkClient(rush.base_url, rush.workspace_id, rush.token)
    events = client.events(attempt.attempt_id).events
    return Ran(name, run, client, events, client.accounting(attempt.attempt_id), sess.handle.ledger.main_calls[before:])


LOOP = {"dialect": "chat_completions", "instrument": True, "retries": 2, "backoff_s": 0.3}
SERIAL = {"dialect": "chat_completions", "instrument": True}
BRANCH = {**SERIAL, "local_branch_s": 0.5}
EARLY = {**SERIAL, "dialect": "anthropic_messages", "early_tools": True}


def wait_turns(*, ttfb: float, gap: float) -> list[Any]:
    """One streamed tool turn, then the answer: fixed tokens, with only the upstream delay as a parameter."""
    return [
        turn(act={"wait": 0.3}, prompt=400, completion=60, chunks=6, ttfb=ttfb, gap=gap),
        turn(act=ANSWER, prompt=500, completion=20, ttfb=ttfb, gap=gap),
    ]


def early_turns() -> list[Any]:
    """Two parallel one-second tools proposed in a six-chunk stream (0.3 s apart): the first is complete mid-stream, the second near its end."""
    return [
        turn(act=[{"wait": 1.0}, {"wait": 1.0}], prompt=100, completion=300, chunks=6, ttfb=0.05, gap=0.3),
        turn(act=ANSWER, prompt=150, completion=10),
    ]


@dataclass
class Evidence:
    chat: Ran
    responses: Ran
    anthropic: Ran
    base: Ran
    slow: Ran
    branch: Ran
    busy: Ran
    opaque: Ran
    unfinished: Ran
    half_rate: Ran
    early: Ran
    early_responses: Ran
    late: Ran


@pytest.fixture(scope="module")
def evidence(rush: RushServer) -> Iterator[Evidence]:
    turns = [
        # chat: a refused fallback route never reaches upstream; the 429 is retried; one call has known zeros; the last reports no usage
        turn(status=429),
        turn(act={"wait": 0.5}, prompt=1000, cached=400, cache_write=100, completion=40, reasoning=5),
        turn(act={"wait": 0.2}, prompt=200, completion=7),
        turn(act=ANSWER, report_usage=False),
        # responses
        turn(act={"wait": 0.3}, prompt=500, cached=200, completion=20, reasoning=4),
        turn(act=ANSWER, prompt=600, completion=15),
        # anthropic: the stream's message_start carries output 1 and message_delta the cumulative counters
        turn(act={"wait": 0.3}, prompt=800, cached=300, cache_write=200, completion=30, chunks=5, gap=0.05),
        turn(act=ANSWER, prompt=900, cached=800, completion=12),
        *wait_turns(ttfb=0.05, gap=0.1),  # base
        *wait_turns(ttfb=0.5, gap=0.5),  # slow: same tokens, local work and dependencies, a much slower upstream
        *wait_turns(ttfb=0.05, gap=0.1),  # branch
        turn(act=ANSWER, prompt=50, completion=5),  # busy
        turn(act={"wait": 0.2}, prompt=60, completion=6),  # opaque
        turn(act=ANSWER, prompt=70, completion=7),
        turn(act=ANSWER, prompt=80, completion=8),  # unfinished
        *early_turns(),  # early
        *early_turns(),  # early_responses
        *early_turns(),  # late
    ]
    with session(rush, "metrics", turns, tolerance_ns=TOLERANCE_NS) as sess:
        chat = execute(sess, "chat", {**LOOP, "reject_first": True}, rush)
        responses = execute(sess, "responses", {**LOOP, "dialect": "responses"}, rush)
        anthropic = execute(sess, "anthropic", {**LOOP, "dialect": "anthropic_messages"}, rush)
        base = execute(sess, "base", SERIAL, rush)
        slow = execute(sess, "slow", SERIAL, rush)
        branch = execute(sess, "branch", BRANCH, rush)
        busy = execute(sess, "busy", {**LOOP, "busy_s": 1.5}, rush)
        opaque = execute(sess, "opaque", {**LOOP, "instrument": False}, rush)
        unfinished = execute(sess, "unfinished", {**LOOP, "hold_root": True}, rush)
        early = execute(sess, "early", EARLY, rush)
        early_responses = execute(sess, "early-responses", {**EARLY, "dialect": "responses"}, rush)
        late = execute(sess, "late", {**EARLY, "early_tools": False}, rush)
        assert not sess.handle.ledger.violations
    # The same source and fixed tokens under a worker whose YAML sets half the reference rate.
    with session(rush, "metrics-half", wait_turns(ttfb=0.05, gap=0.1), rate=50, tolerance_ns=TOLERANCE_NS) as half:
        half_rate = execute(half, "base", SERIAL, rush)
        assert not half.handle.ledger.violations
    yield Evidence(chat, responses, anthropic, base, slow, branch, busy, opaque, unfinished, half_rate, early, early_responses, late)


def known(ran: Ran) -> dict[str, int]:
    return {field: ran.metrics[field] for field in FIELDS}


def union_ns(intervals: list[tuple[int, int]], window: tuple[int, int]) -> int:
    """Nanoseconds of ``window`` covered by ``intervals``, each counted once."""
    covered, reach = 0, window[0]
    for start, end in sorted((max(a, window[0]), min(b, window[1])) for a, b in intervals):
        start = max(start, reach)
        if end > start:
            covered += end - start
            reach = end
    return covered


def blocked_ns(ran: Ran) -> int:
    """Nanoseconds in which every live harness branch waits on upstream data and no tool runs, from the stored events alone."""
    spans: dict[str, dict[str, Any]] = {}
    for event in ran.harness_events():
        if event["event"] == "span.start":
            spans[event["span_id"]] = {"kind": event["kind"], "parent": event.get("parent_span_id"), "start": event["ns"], "end": None, "waits": event["data"].get("waits_on_call")}
        elif event["event"] == "span.end":
            spans[event["span_id"]]["end"] = event["ns"]

    def branch(span_id: str) -> str:
        while spans[span_id]["kind"] not in ("agent", "subagent"):
            span_id = spans[span_id]["parent"]
        return span_id

    window = ran.window_ns
    flights = {e["data"]["call_id"]: (e["data"]["dispatched_ns"], e["data"]["completed_ns"]) for e in ran.of("model_call.response")}
    for span in spans.values():  # a branch is blocked only while its request is in flight, whatever the report's own latency
        if span["waits"] in flights:
            span["start"], span["end"] = max(span["start"], flights[span["waits"]][0]), min(span["end"] or window[1], flights[span["waits"]][1])
    tools = []
    for invoked in ran.of("tool.invoked"):
        [completed] = [e for e in ran.of("tool.completed") if e["data"]["call_id"] == invoked["data"]["call_id"]]
        tools.append((invoked["data"]["received_ns"], int(completed["occurred_ns"])))
    branches = {i: s for i, s in spans.items() if s["kind"] in ("agent", "subagent")}
    points = sorted({window[0], window[1], *(p for s in spans.values() for p in (s["start"], s["end"]) if p is not None), *(p for t in tools for p in t)})
    blocked = 0
    for start, end in zip(points, points[1:], strict=False):
        if start < window[0] or end > window[1]:
            continue
        middle = (start + end) // 2
        live = [i for i, s in branches.items() if s["start"] <= middle < (s["end"] or window[1])]
        waiting = {branch(i) for i, s in spans.items() if s["waits"] and s["start"] <= middle < (s["end"] or window[1])}
        if live and set(live) <= waiting and not any(a <= middle < b for a, b in tools):
            blocked += end - start
    return blocked


# -- tokens -------------------------------------------------------------------------------------------------------------


def test_chat_counts_are_exact_and_missing_calls_are_counted_not_summed(evidence: Evidence) -> None:
    chat = evidence.chat
    assert chat.attempt.execution_status == "answered" and chat.attempt.verdict == "pass"
    assert chat.metrics["usage_complete"] is False  # two calls reported no usage
    assert known(chat) == {"total_tokens": 1247, "input_tokens": 1200, "output_tokens": 47, "cache_read_tokens": 400, "cache_write_tokens": 100}
    # The 429 reached upstream and returned no usage, and the last call reported none: two calls missing every field.
    assert chat.metrics["missing_calls"] == {"total": 2, "input": 2, "output": 2, "cache_read": 2, "cache_write": 2}
    assert chat.metrics["model_calls"] == 4
    # The run sums the known subtotal and counts the attempt as one that did not fully report the field.
    assert {field: chat.run.metrics[field] for field in FIELDS} == {field: {"total": known(chat)[field], "missing_attempts": 1} for field in FIELDS}
    assert chat.run.metrics["elapsed_ms"]["missing_attempts"] == 0
    # What the upstream ledger says the wire carried for the two calls that reported usage.
    first, second = (call.usage for call in chat.served[:2])
    total = first + second
    assert (total.input, total.output, total.cached, total.cache_write) == (1200, 47, 400, 100)


def test_known_zero_fields_are_zero_and_a_refused_request_is_not_a_call(evidence: Evidence) -> None:
    usages = [event["data"]["usage"] for event in evidence.chat.of("model_call.response") if event["data"]["usage"] is not None]
    reported = [usage for usage in usages if usage["input"] is not None]
    # The second call's cache and reasoning counts are reported zeros: known, not missing.
    assert [(u["cache_read"], u["cache_write"], u["reasoning"]) for u in reported] == [(400, 100, 5), (0, 0, 0)]
    [silent] = [u for u in usages if u["input"] is None]
    assert {key: silent[key] for key in ("input", "output", "total", "cache_read", "cache_write", "reasoning")} == dict.fromkeys(
        ("input", "output", "total", "cache_read", "cache_write", "reasoning")
    )
    # The refused fallback route never reached upstream: rejected before admission, with no reservation and not one of the calls.
    [rejected] = evidence.chat.of("model_call.rejected")
    assert (rejected["data"]["code"], rejected["data"]["admitted"]) == ("fallback_forbidden", False)
    assert rejected["data"]["call_id"] not in {call["call_id"] for call in evidence.chat.accounting["calls"]}
    assert len(evidence.chat.accounting["calls"]) == 4 == evidence.chat.metrics["model_calls"] == len(evidence.chat.of("model_call.response"))


def test_a_retry_is_its_own_physical_call_with_its_own_accounting(evidence: Evidence) -> None:
    chat = evidence.chat
    failed, *others = chat.of("model_call.response")
    assert (failed["data"]["terminal"], failed["data"]["http_status"], failed["data"]["usage"]) == ("http_error", 429, None)
    assert len({event["data"]["call_id"] for event in chat.of("model_call.response")}) == 4 and len(others) == 3
    [admission] = [call["admission"] for call in chat.accounting["calls"] if call["call_id"] == failed["data"]["call_id"]]
    assert (admission["status"], admission["provenance"]) == ("settled", {"source": "http_429"})
    assert chat.accounting["totals"]["calls"] == 4
    # The retry is linked to the call it repeats by the request digest, and both stay actions of their own.
    trace = chat.client.spans(chat.attempt.attempt_id)
    [retry] = [link for link in trace["links"] if link["kind"] == "retry"]
    assert retry["method"] == "request_digest" and retry["to"] == f"m:{failed['data']['call_id']}" and retry["from"] != retry["to"]


@pytest.mark.parametrize(
    ("name", "expected", "missing"),
    [
        # Responses carries no cache-write field: its subtotal is 0 over zero reporting calls, and both calls are counted missing.
        ("responses", {"total_tokens": 1135, "input_tokens": 1100, "output_tokens": 35, "cache_read_tokens": 200, "cache_write_tokens": 0}, {"cache_write": 2}),
        # Anthropic: inclusive input is uncached + cache reads + cache creation, and the stream's cumulative counters are not summed.
        ("anthropic", {"total_tokens": 1742, "input_tokens": 1700, "output_tokens": 42, "cache_read_tokens": 1100, "cache_write_tokens": 200}, {}),
    ],
)
def test_dialect_counts_are_exact(evidence: Evidence, name: str, expected: dict[str, int], missing: dict[str, int]) -> None:
    ran = getattr(evidence, name)
    assert ran.attempt.verdict == "pass" and ran.metrics["model_calls"] == 2 == len(ran.served)
    assert known(ran) == expected
    assert ran.metrics["missing_calls"] == {"total": 0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0} | missing
    assert ran.metrics["usage_complete"] is (not missing)  # a field no call reported leaves the usage incomplete
    served = ran.served[0].usage + ran.served[1].usage
    assert (served.input, served.output, served.cached) == (expected["input_tokens"], expected["output_tokens"], expected["cache_read_tokens"])
    assert {call.dialect for call in ran.served} == {name if name == "responses" else "anthropic"}
    # A partial field is counted, not hidden: the run reports the attempt as one that did not fully report it.
    assert ran.run.metrics["cache_write_tokens"]["missing_attempts"] == (1 if missing else 0)


# -- timing -------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["chat", "responses", "anthropic", "busy", "base", "slow", "branch", "half_rate"])
def test_no_request_time_is_the_union_of_the_recorded_request_intervals(evidence: Evidence, name: str) -> None:
    ran = getattr(evidence, name)
    start, end = ran.window_ns
    assert ran.metrics["elapsed_ns"] == end - start
    assert ran.metrics["no_request_ns"] == end - start - union_ns(ran.calls(), ran.window_ns)


@pytest.mark.parametrize("name", ["chat", "responses", "anthropic", "busy", "base", "slow"])
def test_serial_runs_measure_time_outside_waits_and_reproduce_it_from_their_intervals(evidence: Evidence, name: str) -> None:
    ran = getattr(evidence, name)
    start, end = ran.window_ns
    assert abs(ran.metrics["outside_waits_ns"] - (end - start - blocked_ns(ran))) < 5_000_000
    assert ran.metrics["outside_waits_ns"] >= ran.metrics["no_request_ns"]  # a branch waits only while its request is in flight
    assert ran.metrics["timing_method"] == {"id": "rush-timing/1", "clock_tolerance_ns": TOLERANCE_NS, "reference_tokens_per_second": 100}


def modeled_ns(ran: Ran, rate: float = 100) -> int:
    return round(ran.metrics["total_tokens"] * NS / rate)


@pytest.mark.parametrize("name", ["responses", "anthropic", "busy", "base", "slow"])
def test_serial_estimate_is_the_local_time_plus_the_modeled_calls(evidence: Evidence, name: str) -> None:
    ran = getattr(evidence, name)
    # No call overlaps anything: the critical path is every local gap plus each call at (input + output) / 100 tokens per second.
    assert ran.metrics["estimated_ns"] == ran.metrics["no_request_ns"] + modeled_ns(ran)


def test_the_estimate_ignores_upstream_delay_and_the_measured_times_follow_it(evidence: Evidence) -> None:
    base, slow = evidence.base, evidence.slow
    assert known(base) == known(slow) and base.metrics["model_calls"] == slow.metrics["model_calls"] == 2
    # Only the mock's ttfb and gap changed: the case takes seconds longer, but the estimate moves only by local jitter.
    assert slow.metrics["elapsed_ns"] - base.metrics["elapsed_ns"] > 3 * NS
    assert abs(slow.metrics["estimated_ns"] - base.metrics["estimated_ns"]) < 600_000_000
    assert base.metrics["estimated_ns"] == base.metrics["no_request_ns"] + modeled_ns(base)


def test_the_reference_rate_in_the_worker_yaml_moves_the_estimate_by_the_modeled_difference(evidence: Evidence) -> None:
    base, half = evidence.base, evidence.half_rate
    assert half.metrics["timing_method"]["reference_tokens_per_second"] == 50 and base.metrics["timing_method"]["reference_tokens_per_second"] == 100
    assert known(half) == known(base)
    # Every call takes twice as long when modeled, so 9.8 s of modeled time becomes 19.6 s; local work is the same up to jitter.
    assert abs((half.metrics["estimated_ns"] - base.metrics["estimated_ns"]) - (modeled_ns(base, 50) - modeled_ns(base, 100))) < 600_000_000


def test_work_on_a_parallel_branch_stays_outside_the_waits(evidence: Evidence) -> None:
    branch = evidence.branch
    start, end = branch.window_ns
    assert abs(branch.metrics["outside_waits_ns"] - (end - start - blocked_ns(branch))) < 5_000_000
    # The branch's 0.5 s of CPU work runs while the root waits on the model: that time is outside the waits, which therefore
    # exceed the no-request time by at least the part of the work the request covered.
    assert branch.metrics["outside_waits_ns"] > branch.metrics["no_request_ns"]
    # The branch is off the critical path (0.5 s of work against a modeled call of seconds), so the estimate is the serial one,
    # except that the branch and the first request begin together: the harness's start-up between the branch's start report
    # and the request's dispatch overlaps the branch and is not a gap on the root's own path.
    [branch_start] = [e["ns"] for e in branch.harness_events() if e["event"] == "span.start" and e["span_id"] == "branch-1"]
    lead = min(call["data"]["dispatched_ns"] for call in branch.of("model_call.response")) - branch_start
    assert 0 <= lead < 100_000_000
    assert abs(branch.metrics["estimated_ns"] - (branch.metrics["no_request_ns"] + modeled_ns(branch) - lead)) < TOLERANCE_NS


def test_cpu_and_wall_counters_follow_a_busy_loop(evidence: Evidence) -> None:
    busy = evidence.busy
    [counters] = busy.of("cpu.counters")
    by_role = {p["identity"]["role"]: (p["user_ns"] + p["system_ns"]) / NS for p in counters["data"]["processes"]}
    assert set(by_role) == {"harness", "tool"}
    # 1.5 s of CPU in the loop plus interpreter start and the gateway round trips of the run, under the sandbox's one CPU.
    assert 1.5 <= by_role["harness"] <= 3.2
    assert busy.metrics["cpu_ns"] == sum(p["user_ns"] + p["system_ns"] for p in counters["data"]["processes"])
    start, end = busy.window_ns
    assert 1.5 * NS <= end - start <= 7 * NS and busy.metrics["elapsed_ns"] == end - start
    # The idle harness of the opaque run spent far less CPU.
    [idle] = evidence.opaque.of("cpu.counters")
    [idle_harness] = [p for p in idle["data"]["processes"] if p["identity"]["role"] == "harness"]
    assert (idle_harness["user_ns"] + idle_harness["system_ns"]) / NS < by_role["harness"] - 1.0


def test_incomplete_evidence_leaves_the_affected_metric_unknown(evidence: Evidence) -> None:
    # An opaque harness reports no waits or dependencies, and one that never ends its root span leaves both open.
    for ran in (evidence.opaque, evidence.unfinished):
        assert ran.metrics["outside_waits_ns"] is None and ran.metrics["outside_waits_ns_unknown"] == "wait or branch coverage is incomplete"
        assert ran.metrics["estimated_ns"] is None and ran.metrics["estimated_ns_unknown"] == "dependency evidence is incomplete"
        # What does not depend on the missing evidence is still measured.
        assert ran.metrics["no_request_ns"] is not None and ran.metrics["cpu_ns"] > 0 and ran.metrics["usage_complete"] is True
    assert known(evidence.opaque)["total_tokens"] == 143 and known(evidence.unfinished)["total_tokens"] == 88
    # A call with no reported usage leaves the estimate Unknown and names the calls, while outside waits stay measured.
    chat = evidence.chat
    assert chat.metrics["estimated_ns"] is None and chat.metrics["estimated_ns_unknown"].startswith("calls without recorded tokens: ")
    assert chat.metrics["outside_waits_ns"] is not None


# -- delivery and early-launched tools ------------------------------------------------------------------------------------

# Upstream availability to the relay's hand-over to the harness's connection: the gateway forwards each chunk at once and
# journals off that path, so this is local scheduling only. Measured per frame from every streamed call below.
DELIVERY_BOUND_NS = 50_000_000
# From the frame that completed a proposal being available to the tool call reaching the broker: the stream crossing the
# relay and the sandbox network, the harness parsing the line, starting a thread and its POST crossing back.
LAUNCH_LAG_BOUND_NS = TOLERANCE_NS  # a longer lag would not be reproduced by the dependency graph within the clock tolerance


def streamed_calls(ran: Ran) -> list[dict[str, Any]]:
    return sorted((e["data"] for e in ran.of("model_call.response") if e["data"].get("frames_payload_sha256")), key=lambda d: d["dispatched_ns"])


def test_frames_are_handed_to_the_harness_as_they_arrive_and_the_delivery_overhead_is_recorded(evidence: Evidence) -> None:
    worst_frame, worst_end, frames_seen = 0, 0, 0
    for name in ("chat", "responses", "anthropic", "base", "slow", "branch", "early", "early_responses", "late"):
        ran = getattr(evidence, name)
        for data in streamed_calls(ran):
            frames = ran.payload(data["frames_payload_sha256"])
            assert all(f["delivered_ns"] is not None and f["available_ns"] <= f["delivered_ns"] for f in frames)
            assert data["completed_ns"] <= data["delivered_ns"]
            worst_frame = max(worst_frame, *(f["delivered_ns"] - f["available_ns"] for f in frames))
            worst_end = max(worst_end, data["delivered_ns"] - data["completed_ns"])
            frames_seen += len(frames)
    print(f"delivery overhead over {frames_seen} frames: worst frame {worst_frame / 1e6:.2f} ms, worst stream end {worst_end / 1e6:.2f} ms")
    assert worst_frame < DELIVERY_BOUND_NS and worst_end < DELIVERY_BOUND_NS


def tool_times(ran: Ran) -> list[dict[str, Any]]:
    """Each brokered tool call with the proposal it answers and the interval the timing analysis gives it."""
    found = []
    for invoked in ran.of("tool.invoked"):
        [completed] = [e for e in ran.of("tool.completed") if e["data"]["call_id"] == invoked["data"]["call_id"]]
        end = int(completed["occurred_ns"])
        start = min(end - completed["data"]["duration_ns"], invoked["data"]["received_ns"])
        found.append({"proposal": invoked["data"]["cause"]["tool_call_id"], "received_ns": invoked["data"]["received_ns"], "start_ns": start, "end_ns": end})
    return sorted(found, key=lambda t: t["start_ns"])


def modeled_offsets(ran: Ran, data: dict[str, Any], rate: float = 100) -> tuple[int, list[int]]:
    """The call's modeled duration and the modeled availability of each frame, from its stored usage and frame lengths."""
    usage = data["usage"]
    input_ns, output_ns = round(usage["input"] * NS / rate), round(usage["output"] * NS / rate)
    frames = ran.payload(data["frames_payload_sha256"])
    total, seen, offsets = sum(f["bytes"] for f in frames), 0, []
    for frame in frames:
        seen += frame["bytes"]
        offsets.append(input_ns + round(output_ns * seen / total))
    return round((usage["input"] + usage["output"]) * NS / rate), offsets


def expected_estimate(ran: Ran) -> int:
    """The estimate of a run of one streamed call with parallel tools, then one more call, worked out from the stored evidence.

    A tool launched on a frame starts at that frame's modeled availability, so the first call and its tools form one cluster that the
    next call waits for. A tool launched after the response ended starts a measured gap after the call's modeled end. Everything
    else is local time kept as measured.
    """
    first, second = streamed_calls(ran)
    call_ns, offsets = modeled_offsets(ran, first)
    regs = {r["tool_call_id"]: r for r in first["registrations"]}
    tools = tool_times(ran)
    second_ns = modeled_offsets(ran, second)[0]
    start, end = ran.window_ns
    if all(t["start_ns"] >= first["completed_ns"] for t in tools):
        # Tools called after the response ended wait for its modeled end, then run as measured: only the two calls are replaced.
        return (end - start) - (first["completed_ns"] - first["dispatched_ns"]) - (second["completed_ns"] - second["dispatched_ns"]) + call_ns + second_ns
    cluster = (min(first["dispatched_ns"], *(t["start_ns"] for t in tools)), max(first["completed_ns"], *(t["end_ns"] for t in tools)))
    modeled_path = max(
        call_ns,
        *(offsets[regs[t["proposal"]]["frame_index"]] + t["end_ns"] - t["start_ns"] for t in tools),
    )
    local = (end - start) - (cluster[1] - cluster[0]) - (second["completed_ns"] - second["dispatched_ns"])
    return local + modeled_path + second_ns


@pytest.mark.parametrize("name", ["early", "early_responses"])
def test_a_tool_launched_on_an_early_frame_starts_before_the_response_ends(evidence: Evidence, name: str) -> None:
    ran = getattr(evidence, name)
    [first, _] = streamed_calls(ran)
    frames = ran.payload(first["frames_payload_sha256"])
    regs = {r["tool_call_id"]: r for r in first["registrations"]}
    tools = tool_times(ran)
    assert len(tools) == len(regs) == 2 and all(r["early"] for r in regs.values())
    lags = []
    for tool in tools:
        frame = frames[regs[tool["proposal"]]["frame_index"]]
        assert regs[tool["proposal"]]["registered_ns"] == frame["available_ns"]  # registered the moment its frame was available
        lags.append(tool["received_ns"] - frame["available_ns"])
    print(f"{name}: launch lag from frame availability {[round(lag / 1e6, 2) for lag in lags]} ms")
    assert all(0 <= lag < LAUNCH_LAG_BOUND_NS for lag in lags)
    # The first tool is called while the model's response is still arriving; the second's frame is among the stream's last, so it is
    # called about when the response ends.
    assert tools[0]["received_ns"] < first["completed_ns"] - 100_000_000
    # The first tool's frame comes before the second's, so the second is called later in the same response.
    assert regs[tools[0]["proposal"]]["frame_index"] < regs[tools[1]["proposal"]]["frame_index"] and tools[0]["received_ns"] < tools[1]["received_ns"]


@pytest.mark.parametrize("name", ["early", "early_responses", "late"])
def test_estimate_with_early_launched_tools_is_known_and_matches_its_critical_path(evidence: Evidence, name: str) -> None:
    ran = getattr(evidence, name)
    assert ran.attempt.verdict == "pass" and ran.metrics["model_calls"] == 2
    assert ran.metrics["estimated_ns"] == expected_estimate(ran), ran.metrics.get("estimated_ns_unknown")
    start, end = ran.window_ns
    assert abs(ran.metrics["outside_waits_ns"] - (end - start - blocked_ns(ran))) < 5_000_000
    assert ran.metrics["timing_method"]["clock_tolerance_ns"] == TOLERANCE_NS


def test_launching_a_tool_early_shortens_the_run_and_its_estimate(evidence: Evidence) -> None:
    early, late = evidence.early, evidence.late
    assert known(early) == known(late)
    # Same tokens and tools; the late run starts them only after the response ends.
    assert late.metrics["elapsed_ns"] - early.metrics["elapsed_ns"] > 100_000_000
    assert early.metrics["estimated_ns"] < late.metrics["estimated_ns"]
    assert [t["received_ns"] > streamed_calls(late)[0]["completed_ns"] for t in tool_times(late)] == [True, True]
