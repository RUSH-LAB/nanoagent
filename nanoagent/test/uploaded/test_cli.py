"""The uploaded_benchmark steps against the fake RUSH server, run in this process as their run scripts run them."""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

import pytest
from fake_rush import ATTEMPT, BAD_PAYLOAD_SHA, PAYLOAD_SHA, TOKEN, WORKSPACE, FakeRush, make_run, summary
from test_client import publication
from slimconfig import load_layout

NANOAGENT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(NANOAGENT / "examples" / "uploaded_benchmark"), str(NANOAGENT / "examples" / "benchmark")]

import step2_submit_run as step2  # noqa: E402
import step3_trace as step3  # noqa: E402
import step5_results as step5  # noqa: E402

from nanoagent.uploaded.client import BenchmarkClient, PayloadDigestMismatch  # noqa: E402
from nanoagent.uploaded.reference import build_reference  # noqa: E402
from nanoagent.uploaded.source_zip import FIXED_TIME  # noqa: E402


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


@pytest.fixture
def source(tmp_path: Path) -> Path:
    folder = tmp_path / "source"
    (folder / "src").mkdir(parents=True)
    (folder / "harness.yaml").write_text("name: my-harness\nversion: '1.3'\ndialects: [chat_completions]\nrun: [python, main.py]\n")
    (folder / "src" / "main.py").write_text("print('hi')\n")
    return folder


@pytest.fixture
def benchmark(server: FakeRush) -> dict:
    with BenchmarkClient(server.url, WORKSPACE, TOKEN) as member:
        return member.publish_benchmark(publication(name="probe", plugin_id="p", version="1.0.0", limits={"internet_access": False, "max_cost_usd": 2.5}))[1]


def submit_run(monkeypatch, server, tmp_path, source, home="home", *extra):
    run_step(
        monkeypatch, step2, step2.SubmitRun, "step2_submit_run", tmp_path / home, server,
        f"source={source}", "plugin=p", "plugin_version=1.0.0", "benchmark=probe", "idempotency_key=k1", "follow=false", *extra,
    )  # fmt: skip
    return load_layout(tmp_path / home, step2.RunLayout)


def test_zip_source_is_deterministic(source: Path, tmp_path: Path) -> None:
    first = step2.zip_source(str(source))
    (source / "src" / "main.py").touch()
    assert step2.zip_source(str(source)) == first
    with zipfile.ZipFile(io.BytesIO(first)) as archive:
        assert archive.namelist() == ["harness.yaml", "src/main.py"]
        assert {info.date_time for info in archive.infolist()} == {FIXED_TIME}


def test_zip_source_refuses_a_symlink(source: Path) -> None:
    (source / "link").symlink_to(source / "harness.yaml")
    with pytest.raises(ValueError, match="symlink"):
        step2.zip_source(str(source))


def test_submit_twice_with_one_key_is_one_run(server: FakeRush, benchmark, monkeypatch, tmp_path: Path, source: Path) -> None:
    first = submit_run(monkeypatch, server, tmp_path, source, "a").run
    again = submit_run(monkeypatch, server, tmp_path, source, "b", f"preview_id={first.preview_id}").run
    assert (first.replayed, again.replayed) == (False, True)
    assert first.run_id == again.run_id and len(server.runs) == 1
    assert first.attempts[0].verdict == "pass" and first.case_ids == ["c1"] and first.score["value"] == 1
    assert first.benchmark["name"] == "probe" and first.harness["name"] == "my-harness" and first.harness["version"] == "1.3"


def test_the_run_sends_only_the_benchmark_and_policy_and_writes_the_case_set(server: FakeRush, benchmark, monkeypatch, tmp_path: Path, source: Path) -> None:
    layout = submit_run(monkeypatch, server, tmp_path, source, "a", "policy=task_tools")
    preview, run = server.bodies
    assert preview == {"benchmark_id": benchmark["benchmark_id"], "policy": "task_tools"}
    assert run == {**preview, "preview_id": "preview-1", "source_sha256": run["source_sha256"], "idempotency_key": "k1"}
    assert layout.case_set.name == "probe" and [case["case_id"] for case in layout.case_set.cases] == ["c1"] and layout.case_set.plugin["version"] == "1.0.0"


def reference_run(monkeypatch, server, tmp_path, *extra, home="home"):
    run_step(
        monkeypatch, step2, step2.SubmitRun, "step2_submit_run", tmp_path / home, server,
        "plugin=p", "plugin_version=1.0.0", "benchmark=probe", "idempotency_key=k1", "follow=false", *extra,
    )  # fmt: skip
    return load_layout(tmp_path / home, step2.RunLayout).run


def test_a_reference_harness_is_uploaded_under_its_own_name_and_a_version_derived_from_its_content(server: FakeRush, benchmark, monkeypatch, tmp_path: Path) -> None:
    first = reference_run(monkeypatch, server, tmp_path, "reference=claude-code", home="a")
    again = reference_run(monkeypatch, server, tmp_path, "reference=claude-code", "idempotency_key=k2", home="b")
    assert first.harness["name"] == "claude-code" and first.harness["version"] == again.harness["version"] != "1"
    assert zipfile.ZipFile(io.BytesIO(build_reference("claude-code"))).read("harness.yaml").decode().count(f'version: "{first.harness["version"]}"') == 1
    assert any(path.endswith("/sources/references/claude-code") for _, path in server.requests)


def test_a_plain_upload_named_like_a_reference_is_refused(server: FakeRush, benchmark, monkeypatch, tmp_path: Path, source: Path) -> None:
    (source / "harness.yaml").write_text((source / "harness.yaml").read_text().replace("my-harness", "claude-code"))
    with pytest.raises(Exception, match="reserved_harness_name"):
        submit_run(monkeypatch, server, tmp_path, source, "a")


@pytest.mark.parametrize("extra", [[], ["source=/x", "reference=codex"]])
def test_exactly_one_of_source_and_reference_is_set(server: FakeRush, benchmark, monkeypatch, tmp_path: Path, extra: list[str]) -> None:
    with pytest.raises(ValueError, match="exactly one of `source` and `reference`"):
        reference_run(monkeypatch, server, tmp_path, *extra)


def test_an_unknown_benchmark_stops_the_step_before_any_upload(server: FakeRush, benchmark, monkeypatch, tmp_path: Path, source: Path) -> None:
    with pytest.raises(LookupError, match="no benchmark named nope"):
        submit_run(monkeypatch, server, tmp_path, source, "a", "benchmark=nope")
    assert not any(path.endswith("/sources") for _, path in server.requests)


def test_a_stale_preview_stops_the_step_with_the_current_configuration(server: FakeRush, benchmark, monkeypatch, tmp_path: Path, source: Path) -> None:
    server.stale = True
    with pytest.raises(RuntimeError, match="stale") as raised:
        submit_run(monkeypatch, server, tmp_path, source)
    assert "prompt, cases changed" in str(raised.value) and "benchmark: probe (bench-2)" in str(raised.value)
    assert not server.runs
    assert [path for method, path in server.requests if method == "POST" and path.endswith("/runs")] == [
        f"/api/workspaces/{WORKSPACE}/benchmark/runs"
    ]  # one try, never a resubmit


def test_the_preview_prints_the_effective_configuration_and_case_ids(server: FakeRush, benchmark, monkeypatch, tmp_path: Path, source: Path, capsys) -> None:
    submit_run(monkeypatch, server, tmp_path, source, "a")
    out = capsys.readouterr().out
    preview = out[: out.index("queued run")]
    assert "harness my-harness@1.3 (dialects chat_completions) on probe (p @ 1.0.0)" in preview
    assert "benchmark: probe (bench-1)" in preview and "policy: coding" in preview and "prompt: benchmark" in preview
    assert "internet access: off" in preview and "wall_time_ms: 600000" in preview and "max_cost_usd: 2.5" in preview and "Cases (1): c1" in preview


def test_the_summary_prints_primary_metrics_first(server: FakeRush, benchmark, monkeypatch, tmp_path: Path, source: Path, capsys) -> None:
    run_step(
        monkeypatch, step2, step2.SubmitRun, "step2_submit_run", tmp_path / "home", server,
        f"source={source}", "plugin=p", "plugin_version=1.0.0", "benchmark=probe", "idempotency_key=k1", "poll_seconds=0.01",
    )  # fmt: skip
    out = capsys.readouterr().out
    summary = out[out.index("Run run-1") :]
    lines = summary.splitlines()
    assert lines[0] == "Run run-1 (complete): my-harness@1.3 on probe (p @ 1.0.0)"
    assert "internet access: on" in summary and "Cases (1): c1" in summary
    start = lines.index("Primary metrics")
    assert lines[start + 1 : start + 7] == [
        "  total tokens: 30",
        "  input tokens: 20 known, 1 attempt did not report it",
        "  output tokens: 10",
        "  cache-read tokens: 0",
        "  cache-write tokens: 0",
        "  elapsed time: 1.500 s",
    ]
    assert summary.index("Primary metrics") < summary.index("Verdicts") < summary.index("Score")
    assert lines[lines.index("Score (passed cases over scored cases)") + 1] == "  1 (1 of 1 scored, 0 unscored of 1)"


def test_trace_reads_events_spans_payloads_and_never_writes(server: FakeRush, monkeypatch, tmp_path: Path) -> None:
    run_step(monkeypatch, step3, step3.ReadTrace, "step3_trace", tmp_path / "t", server, f"payloads=[{PAYLOAD_SHA}]", "span_kind=tool")
    trace = load_layout(tmp_path / "t", step3.TraceLayout)
    assert [event["cursor"] for event in trace.trace.events] == [1, 2, 3]
    assert trace.trace.sealed and trace.trace.final_cursor == 3
    assert trace.trace.title == "h@1 on probe (p @ 1.0.0)"
    assert trace.trace.spans[0]["kind"] == "tool"
    assert (Path(trace.payloads) / PAYLOAD_SHA).read_bytes() == b"payload bytes"
    assert all(method == "GET" for method, _ in server.requests)


def test_trace_follow_streams_with_reconnect(server: FakeRush, monkeypatch, tmp_path: Path) -> None:
    run_step(monkeypatch, step3, step3.ReadTrace, "step3_trace", tmp_path / "t", server, "follow=true")
    trace = load_layout(tmp_path / "t", step3.TraceLayout).trace
    assert [event["cursor"] for event in trace.events] == [1, 2, 3]
    assert server.connections == 2 and trace.final_cursor == 3


def test_trace_rejects_a_payload_that_does_not_match_its_digest(server: FakeRush, monkeypatch, tmp_path: Path) -> None:
    with pytest.raises(PayloadDigestMismatch):
        run_step(monkeypatch, step3, step3.ReadTrace, "step3_trace", tmp_path / "t", server, f"payloads=[{BAD_PAYLOAD_SHA}]")


def read_results(monkeypatch, server, tmp_path: Path, *overrides: str):
    run_step(monkeypatch, step5, step5.ReadResults, "step5_results", tmp_path / "r", server, *overrides)
    return load_layout(tmp_path / "r", step5.ResultsLayout).results


def other(run_id: str, user_id: str, policy: str, version: str = "1") -> dict:
    run = make_run(run_id, {"benchmark_id": "bench-1", "name": "probe"}, {"name": "theirs", "version": version, "dialects": []}, policy)
    return summary(run, {"id": user_id, "name": "Bo", "github": None})


def test_results_of_a_benchmark_are_split_by_policy_and_grouped_by_member_and_harness(server: FakeRush, benchmark, monkeypatch, tmp_path: Path, source: Path, capsys) -> None:
    submit_run(monkeypatch, server, tmp_path, source, "a")
    server.other_runs += [other("run-x", "user-2", "coding"), other("run-y", "user-2", "task_tools"), other("run-z", "user-2", "coding"), other("run-w", "user-2", "coding", "2")]
    results = read_results(monkeypatch, server, tmp_path, "scope=all", "plugin=p", "plugin_version=1.0.0", "benchmark=probe")
    coding, tools = results.sections
    assert (coding.policy, tools.policy) == ("coding", "task_tools") and results.benchmark["benchmark_id"] == "bench-1"
    assert [(g.user["id"], g.harness, [r["run_id"] for r in g.runs]) for g in coding.groups] == [
        ("user-1", "my-harness@1.3", ["run-1"]), ("user-2", "theirs@1", ["run-x", "run-z"]), ("user-2", "theirs@2", ["run-w"])
    ]
    assert [(g.harness, len(g.runs)) for g in tools.groups] == [("theirs@1", 1)]
    out = capsys.readouterr().out
    assert "Coding (4 runs)" in out and "Task tools (1 runs)" in out and "Una (@una): my-harness@1.3" in out and "Bo: theirs@1" in out
    assert "probe (p @ 1.0.0), mock/model, 30 tokens, 1.500 s" in out


def test_results_of_mine_are_the_callers_runs_and_a_partial_metric_says_so(server: FakeRush, benchmark, monkeypatch, tmp_path: Path, source: Path, capsys) -> None:
    submit_run(monkeypatch, server, tmp_path, source, "a")
    server.runs["run-1"]["metrics"]["total_tokens"] = {"total": 30, "missing_attempts": 1}
    results = read_results(monkeypatch, server, tmp_path, "scope=mine")
    assert results.benchmark is None and [r["run_id"] for g in results.sections[0].groups for r in g.runs] == ["run-1"]
    assert "30 (partial, 1 attempt did not report it) tokens" in capsys.readouterr().out


def test_results_of_all_need_the_benchmark(server: FakeRush, monkeypatch, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="scope all needs"):
        read_results(monkeypatch, server, tmp_path, "scope=all", "benchmark=null")
