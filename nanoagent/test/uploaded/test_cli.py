"""The uploaded_benchmark steps against the fake RUSH server, run in this process as their run scripts run them."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

import pytest
from fake_rush import ATTEMPT, BAD_PAYLOAD_SHA, PAYLOAD_SHA, TOKEN, WORKSPACE, FakeRush, publication
from slimconfig import load_layout

NANOAGENT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(NANOAGENT / "examples" / "uploaded_benchmark")]

import step2_submit_run as step2  # noqa: E402
import step3_trace as step3  # noqa: E402
import step5_results as step5  # noqa: E402

from nanoagent.uploaded.client import BenchmarkClient, PayloadDigestMismatch  # noqa: E402


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(NANOAGENT)
    monkeypatch.setenv("RUSH_SESSION_TOKEN", TOKEN)
    monkeypatch.setenv("RUSH_WORKSPACE_ID", WORKSPACE)
    monkeypatch.setenv("RUSH_ATTEMPT_ID", ATTEMPT)
    with FakeRush() as fake:
        yield fake


def run_step(monkeypatch: pytest.MonkeyPatch, step, cls, name: str, home: Path, server: FakeRush, *overrides: str) -> None:
    config = f"examples/uploaded_benchmark/configs/{name}.yaml"
    arguments = ["step", f"config={config}", f"home={home}", "--", f"server.base_url={server.url}", *overrides]
    monkeypatch.setattr(sys, "argv", arguments)
    with pytest.raises(SystemExit) as exit:
        cls().run()
    assert exit.value.code in (None, 0)


def test_trace_reads_events_spans_payloads_and_never_writes(server: FakeRush, monkeypatch, tmp_path: Path) -> None:
    run_step(monkeypatch, step3, step3.ReadTrace, "step3_trace", tmp_path / "t", server, f"payloads=[{PAYLOAD_SHA}]", "span_kind=tool")
    trace = load_layout(tmp_path / "t", step3.TraceLayout)
    assert [event["cursor"] for event in trace.trace.events] == [1, 2, 3]
    assert trace.trace.sealed and trace.trace.final_cursor == 3
    assert trace.trace.title == "claude on probe (p @ 1.0.0)"
    assert trace.trace.spans[0]["kind"] == "tool"
    assert (Path(trace.payloads) / PAYLOAD_SHA).read_bytes() == b"payload bytes"
    assert all(method == "GET" for method, _ in server.requests)


def test_trace_follow_streams_with_reconnect(server: FakeRush, monkeypatch, tmp_path: Path) -> None:
    run_step(monkeypatch, step3, step3.ReadTrace, "step3_trace", tmp_path / "t", server, "follow=true")
    trace = load_layout(tmp_path / "t", step3.TraceLayout).trace
    assert [event["cursor"] for event in trace.events] == [1, 2, 3]
    assert server.connections == 2 and trace.final_cursor == 3


def test_trace_follow_reads_the_attempt_once_the_stream_says_sealed(server: FakeRush, monkeypatch, tmp_path: Path, capsys) -> None:
    seen: list[bool] = []
    stream, attempt = BenchmarkClient.stream, BenchmarkClient.attempt

    def streamed(self, *args):
        for event in stream(self, *args):
            seen.append(bool(event.get("sealed")))
            yield event

    def live(self, attempt_id):
        # Until the stream says sealed the attempt is still running: no execution, verdict or checks yet.
        found = attempt(self, attempt_id)
        return found if any(seen) else {**found, "state": "running", "execution": None, "verdict": None, "checks": []}

    monkeypatch.setattr(BenchmarkClient, "stream", streamed)
    monkeypatch.setattr(BenchmarkClient, "attempt", live)
    run_step(monkeypatch, step3, step3.ReadTrace, "step3_trace", tmp_path / "t", server, "follow=true")
    trace = load_layout(tmp_path / "t", step3.TraceLayout).trace
    assert trace.attempt["state"] == "final" and trace.outcome["status"] == "answered" and trace.verdict["verdict"] == "pass"
    assert "checks: outcome_exists=passed values_match=passed" in capsys.readouterr().out


def test_trace_rejects_a_payload_that_does_not_match_its_digest(server: FakeRush, monkeypatch, tmp_path: Path) -> None:
    with pytest.raises(PayloadDigestMismatch):
        run_step(monkeypatch, step3, step3.ReadTrace, "step3_trace", tmp_path / "t", server, f"payloads=[{BAD_PAYLOAD_SHA}]")


def test_trace_shows_the_outcome_the_verdict_with_its_checks_and_the_workspace_diff(server: FakeRush, monkeypatch, tmp_path: Path, capsys) -> None:
    run_step(monkeypatch, step3, step3.ReadTrace, "step3_trace", tmp_path / "t", server)
    trace = load_layout(tmp_path / "t", step3.TraceLayout).trace
    assert trace.outcome == {"status": "answered", "reason": None, "answer": {"digest": "abc"}}
    assert trace.verdict["verdict"] == "pass" and [check["name"] for check in trace.verdict["checks"]] == ["outcome_exists", "values_match"]
    assert trace.workspace_diff == {"entries": [{"path": "answer.json", "change": "added", "size": 20}], "truncated": False}
    out = capsys.readouterr().out
    assert "outcome: answered, answer {'digest': 'abc'}" in out and "checks: outcome_exists=passed values_match=passed" in out
    assert "added answer.json (20 bytes)" in out


def submit_overrides(*extra: str) -> tuple[str, ...]:
    return ("plugin=p", "plugin_version=1.0.0", "benchmark=probe", "follow=false", *extra)


def publish_two_cases(server: FakeRush) -> None:
    cases = [{"case_id": f"c{n}", "kind": "answer", "prompt": "p", "arguments": {}, "fixtures": None, "expected_error": None} for n in (1, 2)]
    with server.client_of() as member:
        member.publish_benchmark(publication(cases=cases, private={"c1": None, "c2": None}))


def test_submit_runs_the_benchmark_once_per_harness_and_all_its_cases(server: FakeRush, monkeypatch, tmp_path: Path) -> None:
    publish_two_cases(server)
    run_step(monkeypatch, step2, step2.SubmitRun, "step2_submit_run", tmp_path / "s", server, *submit_overrides("harnesses=[claude,nanoagent]"))
    reports = load_layout(tmp_path / "s", step2.RunLayout).runs.runs
    assert [report.harness for report in reports] == ["claude", "nanoagent"]
    assert [report.case_ids for report in reports] == [["c1", "c2"], ["c1", "c2"]]
    assert [body["idempotency_key"] for body in server.bodies] == ["acceptance-probe-run-1-claude", "acceptance-probe-run-1-nanoagent"]
    assert all("cases" not in body for body in server.bodies)
    assert reports[0].attempts[0].checks == [{"name": "outcome_exists", "status": "passed"}, {"name": "values_match", "status": "passed"}]
    case_set = load_layout(tmp_path / "s", step2.RunLayout).case_set
    assert [case["case_id"] for case in case_set.cases] == ["c1", "c2"]


def test_a_repeated_submit_replays_its_run(server: FakeRush, monkeypatch, tmp_path: Path) -> None:
    publish_two_cases(server)
    for home in ("first", "again"):
        run_step(monkeypatch, step2, step2.SubmitRun, "step2_submit_run", tmp_path / home, server, *submit_overrides("harnesses=[rush my-agent]"))
    first, again = (load_layout(tmp_path / home, step2.RunLayout).runs.runs[0] for home in ("first", "again"))
    assert first.case_ids == again.case_ids == ["c1", "c2"] and (first.replayed, again.replayed) == (False, True)
    assert len(server.runs) == 1


def test_submit_refuses_a_harness_listed_twice(server: FakeRush, monkeypatch, tmp_path: Path) -> None:
    publish_two_cases(server)
    with pytest.raises(ValueError, match="each harness once"):
        run_step(monkeypatch, step2, step2.SubmitRun, "step2_submit_run", tmp_path / "s", server, *submit_overrides("harnesses=[claude,claude]"))


def read_results(monkeypatch, server, tmp_path: Path, *overrides: str):
    run_step(
        monkeypatch,
        step5,
        step5.ReadResults,
        "step5_results",
        tmp_path / "r",
        server,
        "plugin=p",
        "plugin_version=1.0.0",
        "benchmark=probe",
        *overrides,
    )
    return load_layout(tmp_path / "r", step5.ResultsLayout).table


def test_results_are_a_table_of_the_newest_run_per_harness_and_a_column_per_case(server: FakeRush, monkeypatch, tmp_path: Path, capsys) -> None:
    publish_two_cases(server)
    server.verdicts[("codex", "c2")] = "fail"
    with server.client_of() as member:
        benchmark = member.find_benchmark("p", "1.0.0", "probe")
        for key, harness in (("k1", "claude"), ("k2", "codex"), ("k3", "claude")):
            member.create_run(benchmark_id=benchmark["benchmark_id"], harness=harness, idempotency_key=key)
    server.costs["run-3-c1"] = 0.5
    table = read_results(monkeypatch, server, tmp_path)
    assert table.cases == ["c1", "c2"] and [row.harness for row in table.rows] == ["claude", "codex"]
    claude, codex = table.rows
    assert claude.run_id == "run-3", "the newest run of a harness is its row"
    assert claude.verdicts == {"c1": "pass", "c2": "pass"} and codex.verdicts == {"c1": "pass", "c2": "fail"}
    assert (claude.pass_rate, codex.pass_rate, codex.passed, codex.scored) == (1.0, 0.5, 1, 2)
    assert (claude.total_tokens, claude.cost_usd, claude.elapsed_ms, claude.tokens_missing_attempts) == (60, 0.75, 3000, 0)
    assert codex.attempts == {"c1": "run-2-c1", "c2": "run-2-c2"}
    out = capsys.readouterr().out
    assert out.splitlines()[0].split() == ["harness", "c1", "c2", "pass", "rate", "tokens", "cost", "elapsed"]
    assert "codex" in out and "0.50 (1/2 of 2)" in out and "$0.7500" in out


def test_results_as_json_print_the_same_table_the_layout_keeps(server: FakeRush, monkeypatch, tmp_path: Path, capsys) -> None:
    publish_two_cases(server)
    with server.client_of() as member:
        member.create_run(benchmark_id=member.find_benchmark("p", "1.0.0", "probe")["benchmark_id"], harness="pi", idempotency_key="k")
    table = read_results(monkeypatch, server, tmp_path, "as_json=true")
    assert json.loads(capsys.readouterr().out) == asdict(table)


def test_results_leave_out_other_benchmarks(server: FakeRush, monkeypatch, tmp_path: Path) -> None:
    publish_two_cases(server)
    with server.client_of() as member:
        benchmark = member.find_benchmark("p", "1.0.0", "probe")
        member.create_run(benchmark_id=benchmark["benchmark_id"], harness="dsh", idempotency_key="k")
        other = member.publish_benchmark(publication(name="other"))[1]
        member.create_run(benchmark_id=other["benchmark_id"], harness="claude", idempotency_key="k-other")
    table = read_results(monkeypatch, server, tmp_path)
    assert [row.harness for row in table.rows] == ["dsh"] and table.rows[0].verdicts == {"c1": "pass", "c2": "pass"}


def test_results_mark_the_cost_a_lower_bound_when_an_attempt_has_a_call_of_unknown_cost(server: FakeRush, monkeypatch, tmp_path: Path, capsys) -> None:
    publish_two_cases(server)
    with server.client_of() as member:
        benchmark = member.find_benchmark("p", "1.0.0", "probe")
        for key, harness in (("k1", "claude"), ("k2", "codex"), ("k3", "pi")):
            member.create_run(benchmark_id=benchmark["benchmark_id"], harness=harness, idempotency_key=key)
    server.uncertain["run-1-c1"] = 1  # claude: one call of unknown cost beside the settled ones
    server.costs["run-2-c2"] = None  # codex: an attempt with no settled cost at all
    table = read_results(monkeypatch, server, tmp_path)
    pi, codex, claude = table.rows
    assert (claude.cost_usd, claude.cost_lower_bound) == (0.5, True)
    assert (codex.cost_usd, codex.cost_lower_bound) == (0.25, True)
    assert (pi.cost_usd, pi.cost_lower_bound) == (0.5, False)
    out = capsys.readouterr().out
    assert [line.split()[-3] for line in out.splitlines()[1:]] == ["$0.5000", "$0.2500+", "$0.5000+"]


def test_results_as_json_say_the_cost_is_a_lower_bound(server: FakeRush, monkeypatch, tmp_path: Path, capsys) -> None:
    publish_two_cases(server)
    with server.client_of() as member:
        member.create_run(benchmark_id=member.find_benchmark("p", "1.0.0", "probe")["benchmark_id"], harness="pi", idempotency_key="k")
    server.uncertain["run-1-c2"] = 2
    read_results(monkeypatch, server, tmp_path, "as_json=true")
    [row] = json.loads(capsys.readouterr().out)["rows"]
    assert (row["cost_usd"], row["cost_lower_bound"]) == (0.5, True)
