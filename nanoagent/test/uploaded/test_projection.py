"""Trace projection: the plan's worked trace example and the join, coverage and usage rules."""

from __future__ import annotations

from nanoagent.uploaded.compare import compare
from nanoagent.uploaded.projection import PARSER_VERSION, project, to_compare_attempt
from nanoagent.uploaded.records import Record
from test_projection_trace import S, T0, Trace, chat_request, sec


def worked_example() -> Trace:
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    t.model_call("m1", ordinal=1, start=0.2, end=1.2, span_ref="root", proposals=(t.proposal("call_1", "validate", {"path": "config.yaml"}),), usage=(100, 40))
    output = t.tool("t1", "validate", {"path": "config.yaml"}, start=1.3, end=1.8, cause=("m1", "call_1"), span_ref="root", output={"valid": True})
    t.model_call("m2", ordinal=2, start=1.9, end=3.0, span_ref="root", request=chat_request(("call_1", output)), usage=(150, 20))
    t.command("r1", "launch-1", ["go", "test", "./pkg/config"], start=1.3, end=2.3, cwd="pkg", span_ref="root")
    t.process(11, ["go", "test", "./pkg/config"], start=1.35, end=2.25, start_time=7, launch_id="launch-1")
    t.process(12, ["compile"], start=1.5, end=2.0, start_time=8, parent=(11, 7))
    t.process(13, ["sh", "-c", "rogue"], start=2.0, end=2.1, start_time=9)
    t.span_end(3.1, "root")
    t.lifecycle(quiesce=3.2, cpu=(40, 10))
    t.finish(3.3)
    return t


def run(t: Trace):
    return project(t.records, t.payloads, t.redactions)


def link(p, kind, to=None):
    found = [x for x in p.links if x.kind == kind and (to is None or x.to_id == to)]
    assert len(found) == 1, (kind, found)
    return found[0]


def test_worked_example_links_and_tree() -> None:
    p = run(worked_example())
    assert p.parser_version == PARSER_VERSION
    assert not p.coverage.partial, p.coverage.reasons
    spans = {s.id: s for s in p.spans}
    assert spans["h:root"].parent == "phase:harness" and spans["h:root"].provenance == "harness_reported"
    for sid in ("m:m1", "m:m2", "t:t1", "c:r1"):
        assert spans[sid].parent == "h:root", sid
        assert spans[sid].provenance == "observed"
        assert spans[sid].attributes["span_ref"] == {"span_id": "root", "provenance": "harness_reported", "verified": True}
        assert spans[sid].attributes["parser_version"] == PARSER_VERSION and spans[sid].attributes["evidence"]
    assert spans["m:m1/call_1"].parent == "m:m1"
    assert {"root", "phase:harness", "snapshot"} <= spans.keys() and "phase:verifier" not in spans

    pl = link(p, "proposal_invocation")
    assert (pl.from_id, pl.to_id, pl.method) == ("m:m1/call_1", "t:t1", "broker_cause")
    assert pl.attributes["model_call_id"] == "m1" and pl.attributes["tool_call_id"] == "call_1" and not pl.attributes["adapted"]
    rl = link(p, "result_delivery")
    assert (rl.from_id, rl.to_id, rl.method) == ("t:t1", "m:m2", "tool_result_call_id")
    assert rl.attributes["content_match"] == "exact"
    cp = link(p, "command_process")
    assert (cp.from_id, cp.to_id, cp.method) == ("c:r1", "p:11@7", "launch_id")
    assert cp.attributes["exit_code"] == 0
    lineage = link(p, "process_lineage")
    assert (lineage.from_id, lineage.to_id, lineage.method) == ("p:11@7", "p:12@8", "clone")
    assert spans["p:11@7"].parent == "c:r1" and spans["p:12@8"].parent == "p:11@7"
    # an unlinked direct subprocess sits in the process tree with its own evidence
    assert spans["p:13@9"].parent == "proctree" and spans["p:13@9"].attributes["evidence"]
    assert [d["path"] for d in p.workspace_diff] == ["config.yaml", "new.txt"]
    assert spans["snapshot"].attributes["changes"] == {"added": 1, "modified": 1, "deleted": 0}


def test_spans_request_has_the_server_shape() -> None:
    p = run(worked_example())
    body = p.spans_request(fence=3)
    assert body["fence"] == 3
    ids = {s["id"] for s in body["spans"]}
    assert len(ids) == len(body["spans"])
    for s in body["spans"]:
        assert set(s) == {"id", "kind", "name", "parent", "scope", "status", "start_ns", "end_ns", "provenance", "target", "attributes"}
        assert s["parent"] is None or s["parent"] in ids
        assert s["start_ns"] is None or isinstance(s["start_ns"], str)
    for x in body["links"]:
        assert set(x) == {"kind", "from", "to", "method", "attributes"} and x["from"] in ids and x["to"] in ids


def test_worked_example_metrics_come_first() -> None:
    m = run(worked_example()).metrics
    assert (m.usage.total.known, m.usage.input.known, m.usage.output.known) == (310, 250, 60)
    assert m.usage.total.missing == 0 and m.usage_complete
    assert m.total_case_ns == sec(3.2)
    flat = m.to_dict()
    assert flat["total_tokens"] == 310 and flat["cache_read_tokens"] == 0 and flat["elapsed_ms"] == 3200
    assert flat["cpu_ns"] == 50


def test_compare_input_uses_canonical_inputs() -> None:
    t = worked_example()
    p = run(t)
    attempt = to_compare_attempt(p, t.payloads, t.redactions)
    by_id = {a.action_id: a for a in attempt.actions}
    assert by_id["c:r1"].input == {"argv": ["go", "test", "./pkg/config"], "cwd": "pkg"} and by_id["c:r1"].target == "go"
    assert by_id["t:t1"].input == {"path": "config.yaml"} and by_id["t:t1"].target == "validate"
    assert by_id["m:m2"].after == ("t:t1",) and by_id["t:t1"].after == ("m:m1",)
    assert attempt.conditions.harness_revision == "rev1" and attempt.conditions.coverage == "complete"
    assert attempt.conditions.reference_tokens_per_second == 100.0 and attempt.conditions.model == "vendor/model"
    assert all(row.is_equal for row in compare(attempt, attempt).rows)


def test_subagent_with_parallel_tool_calls() -> None:
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    t.span_start(0.1, "sub", "subagent", "researcher", parent="root")
    props = (t.proposal("ca", "read", {"f": "a"}), t.proposal("cb", "read", {"f": "b"}))
    t.model_call("m1", ordinal=1, start=0.2, end=1.0, span_ref="sub", proposals=props)
    t.tool("ta", "read", {"f": "a"}, start=1.1, end=2.0, cause=("m1", "ca"), span_ref="sub")
    t.tool("tb", "read", {"f": "b"}, start=1.1, end=1.9, cause=("m1", "cb"), span_ref="sub")
    t.span_end(2.1, "sub")
    t.span_end(2.2, "root")
    t.lifecycle(quiesce=2.3)
    t.finish(2.4)
    p = run(t)
    assert not p.coverage.partial
    spans = {s.id: s for s in p.spans}
    assert spans["h:sub"].parent == "h:root" and spans["h:sub"].scope == "agent/researcher"
    assert spans["t:ta"].parent == "h:sub" and spans["t:tb"].parent == "h:sub"
    assert {(x.from_id, x.to_id) for x in p.links_of("proposal_invocation")} == {("m:m1/ca", "t:ta"), ("m:m1/cb", "t:tb")}
    attempt = to_compare_attempt(p, t.payloads)
    assert {a.scope for a in attempt.actions} == {("researcher",)}
    assert ("researcher",) in attempt.covered_scopes


def test_retry_links_same_request_after_failed_call() -> None:
    t = Trace()
    t.started()
    body = chat_request(extra="same")
    t.model_call("m1", ordinal=1, start=0.1, end=0.5, request=body, terminal="http_error", usage=(None, None))
    t.model_call("m2", ordinal=2, start=0.8, end=1.5, request=body)
    t.lifecycle(quiesce=2.0)
    p = run(t)
    r = link(p, "retry")
    assert (r.from_id, r.to_id, r.method) == ("m:m2", "m:m1", "request_digest")
    assert r.attributes["failed_terminal"] == "http_error"
    u = p.metrics.usage
    assert (u.calls, u.total.known, u.total.missing) == (2, 150, 1)


def test_adaptation_is_linked_and_marked() -> None:
    t = Trace()
    t.started()
    t.model_call("m1", ordinal=1, start=0.1, end=1.0, proposals=(t.proposal("c1", "edit", {"n": 1}),))
    adaptation = {"model_call_id": "m1", "tool_call_id": "c1", "proposal_arguments": {"n": 1}, "actual_arguments": {"n": 2}}
    t.tool("t1", "edit", {"n": 2}, start=1.1, end=1.2, cause=("m1", "c1"), adaptation=adaptation)
    t.lifecycle(quiesce=2.0)
    p = run(t)
    pl = link(p, "proposal_invocation")
    assert pl.method == "broker_cause_adaptation" and pl.attributes["adapted"] and pl.attributes["adaptation"] == adaptation


def test_unverified_cause_is_flagged_without_a_link() -> None:
    t = Trace()
    t.started()
    t.model_call("m1", ordinal=1, start=0.1, end=1.0, proposals=(t.proposal("c1", "edit", {}),))
    t.tool("t1", "edit", {}, start=1.1, end=1.2, cause=("m1", "ghost"))
    t.lifecycle(quiesce=2.0)
    p = run(t)
    assert not p.links_of("proposal_invocation")
    assert any(i.code == "unverified_cause" for i in p.issues) and p.coverage.partial


def test_a_broker_call_without_cause_is_a_harness_initiated_call_and_keeps_the_trace_complete() -> None:
    """A decide task's tool calls are built by the harness, not proposed by the model: no cause, no link, no partial trace."""
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    t.span_start(0.1, "decision", "decision", "decide", parent="root")
    t.tool("t1", "lookup", {"key": "a"}, start=0.2, end=0.4, span_ref="decision", output={"found": True})
    t.span_end(0.5, "decision")
    t.span_end(0.6, "root")
    t.lifecycle(quiesce=1.0)
    t.finish(1.1)
    p = run(t)
    assert not p.links_of("proposal_invocation")
    assert not any(i.code == "unverified_cause" for i in p.issues)
    assert not p.coverage.partial, p.coverage


def test_harness_reference_to_unknown_call_is_flagged() -> None:
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    t.model_call("m1", ordinal=1, start=0.1, end=1.0, span_ref="root")
    t.span_start(1.0, "good", "operation", "g", parent="root", data={"call_id": "m1"})
    t.span_end(1.1, "good")
    t.span_start(1.1, "bad", "tool", "b", parent="root", data={"call_id": "no-such-call"})
    t.span_end(1.2, "bad")
    t.span_end(1.3, "root")
    t.model_call("m2", ordinal=2, start=1.4, end=1.5, span_ref="nowhere")
    t.lifecycle(quiesce=2.0)
    p = run(t)
    refs = p.links_of("harness_reference")
    assert [(x.from_id, x.to_id, x.method) for x in refs] == [("h:good", "m:m1", "harness_reported")]
    codes = {i.code for i in p.issues}
    assert {"unknown_reference", "unknown_span_reference"} <= codes
    assert {s.id: s for s in p.spans}["m:m2"].parent == "phase:harness"
    # unverified harness references leave the dependency evidence unusable
    assert p.metrics.timing is not None and hasattr(p.metrics.timing.estimated_ns, "reason")


def test_collector_loss_makes_the_trace_partial_and_keeps_evidence() -> None:
    t = worked_example()
    for r in t.records:
        if r["kind"] == "collector.health":
            r["data"] = {"complete": False, "loss_reasons": ["connection_lost"], "frames": 3, "reported_drops": 2}
    p = run(t)
    assert p.coverage.partial and p.coverage.collector_complete is False
    assert any("connection_lost" in reason for reason in p.coverage.reasons)
    assert {"t:t1", "c:r1", "p:11@7"} <= {s.id for s in p.spans}
    assert p.coverage.to_dict()["status"] == "partial"
    assert to_compare_attempt(p, t.payloads).covered_scopes == frozenset()


def test_missing_expected_source_and_sequence_gap_are_partial() -> None:
    t = Trace()
    t.started()
    t.add("gateway", "model_call.rejected", T0, {"call_id": "g1", "code": "budget_exhausted", "message": "no", "http_status": 402}, skip_sequence=1)
    t.lifecycle(quiesce=1.0)
    p = run(t)
    reasons = " ".join(p.coverage.reasons)
    assert "harness" in p.coverage.missing_sources and "gateway sequence has gaps" in reasons
    assert [(r.source, r.code) for r in p.coverage.rejected] == [("gateway", "budget_exhausted")]
    assert p.metrics.usage.calls == 0 and not p.metrics.usage_complete


def test_zero_model_call_attempt_is_all_zeros() -> None:
    t = Trace()
    t.started()
    t.span_start(0.0, "root", "agent", "main")
    t.span_end(1.0, "root")
    t.lifecycle(quiesce=1.0, cpu=(5, 5))
    t.finish(1.1)
    p = run(t)
    assert not p.coverage.partial, p.coverage.reasons
    u = p.metrics.usage
    assert (u.calls, u.total.known, u.total.missing) == (0, 0, 0) and p.metrics.usage_complete
    r = p.metrics.timing
    assert r is not None
    assert (r.total_case_ns, r.no_request_ns, r.outside_waits_ns, r.estimated_ns, r.cpu_ns) == (S, S, S, S, 10)


def test_usage_with_one_missing_call_keeps_known_subtotal() -> None:
    t = Trace()
    t.started()
    t.model_call("m1", ordinal=1, start=0.1, end=0.5, usage=(100, 20))
    t.model_call("m2", ordinal=2, start=0.6, end=1.0, usage=(None, None))
    t.model_call("m3", ordinal=3, start=1.1, end=1.5, usage=(30, 5))
    t.lifecycle(quiesce=2.0)
    u = run(t).metrics.usage
    assert (u.calls, u.input.known, u.input.missing, u.output.known, u.total.known, u.total.missing) == (3, 130, 1, 25, 155, 1)
    flat = run(t).metrics.to_dict()
    assert flat["total_tokens"] == 155 and flat["missing_calls"]["total"] == 1
    assert flat["usage_complete"] is False  # a call without usage makes the aggregate partial, whatever the subtotal says


def test_record_input_accepts_parsed_records_and_dedupes_retransmissions() -> None:
    t = worked_example()
    parsed = [Record.from_dict(r) for r in t.records]
    p = project([*parsed, *t.records], t.payloads)
    assert len(p.model_calls) == 2 and not p.coverage.partial


def test_truncated_and_redacted_payloads_are_reported() -> None:
    t = worked_example()
    sha = next(iter(t.payloads))
    other = list(t.payloads)[1]
    t.redactions[sha] = "truncated"
    t.redactions[other] = "redacted"
    p = run(t)
    assert p.coverage.partial and other in p.coverage.redacted
    assert any(sha in x for x in p.coverage.truncated)
