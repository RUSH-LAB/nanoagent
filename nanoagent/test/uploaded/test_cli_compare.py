"""Step 4 (compare two harnesses) against a fake RUSH server holding two recorded attempts built with the projection trace builder."""

from __future__ import annotations

import base64
import sys
from pathlib import Path
from typing import Any

import pytest
from fake_rush import TOKEN, WORKSPACE, FakeRush, make_run, publication
from slimconfig import load_layout
from starlette.requests import Request
from starlette.responses import JSONResponse
from test_projection_trace import Trace, chat_request

from nanoagent.uploaded.client import BenchmarkError
from nanoagent.uploaded.compare_view import compare_attempts

NANOAGENT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(NANOAGENT / "examples" / "uploaded_benchmark")]

import step4_compare as step4  # noqa: E402


def recorded(*, argv=("go", "test", "./..."), extra_tool=False, swap=False, reference=100.0) -> Trace:
    t = Trace()
    t.started(reference=reference)
    t.span_start(0.0, "root", "agent", "main")
    proposals = (t.proposal("ca", "read", {"f": "a"}), t.proposal("cb", "read", {"f": "b"}))
    t.model_call("m1", ordinal=1, start=0.2, end=1.0, span_ref="root", proposals=proposals)
    out_a = t.tool("ta", "read", {"f": "a"}, start=1.1, end=1.9 if swap else 2.0, cause=("m1", "ca"), span_ref="root")
    out_b = t.tool("tb", "read", {"f": "b"}, start=1.1, end=2.0 if swap else 1.9, cause=("m1", "cb"), span_ref="root")
    extra = (t.proposal("cc", "validate", {"path": "config.yaml"}),) if extra_tool else ()
    t.model_call("m2", ordinal=2, start=2.1, end=3.0, span_ref="root", request=chat_request(("ca", out_a), ("cb", out_b)), proposals=extra)
    if extra_tool:
        t.tool("tc", "validate", {"path": "config.yaml"}, start=3.1, end=3.3, cause=("m2", "cc"), span_ref="root")
    t.command("r1", "launch-1", list(argv), start=3.4, end=4.0, span_ref="root")
    t.process(11, list(argv), start=3.45, end=3.95, start_time=7, launch_id="launch-1")
    t.span_end(4.1, "root")
    t.lifecycle(quiesce=4.2)
    t.finish(4.3)
    return t


class CompareServer(FakeRush):
    """Compares the registered attempts the way the server's `GET /compare/attempts` does: from their records and payloads, by NanoAgent's own comparison."""

    def __init__(self) -> None:
        super().__init__()
        self.traces: dict[str, Trace] = {}
        self.evidence: dict[str, dict[str, Any]] = {}

    def add(self, attempt_id: str, trace: Trace, *, sealed: bool = True, digest: str = "d1") -> None:
        self.traces[attempt_id] = trace
        self.evidence[attempt_id] = {"sealed": sealed, "digest": digest}

    def compare_attempts(self, request: Request) -> JSONResponse:
        ids = [request.query_params["a"], request.query_params["b"]]
        held = [self.evidence[i] for i in ids]
        if not all(h["sealed"] for h in held):
            return self.error(409, "attempt_not_sealed")
        if held[0]["digest"] != held[1]["digest"]:
            return self.error(409, "not_same_case", differing=["content_digest"])
        sides = [
            {
                "records": [{**record, "cursor": i + 1} for i, record in enumerate(self.traces[id].records)],
                "payloads": {sha: base64.b64encode(data).decode() for sha, data in self.traces[id].payloads.items()},
                "redactions": {sha: "none" for sha in self.traces[id].payloads},
            }
            for id in ids
        ]
        result = compare_attempts(*sides)
        case = {"package_sha256": "pkg", "task_id": "t", "content_digest": held[0]["digest"]}
        rows, first = result.pop("rows"), result.pop("first_difference")
        return JSONResponse({"header": {"attempt_a": ids[0], "attempt_b": ids[1], "case": case, **result}, "rows": rows, "first_difference": first})


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(NANOAGENT)
    monkeypatch.setenv("RUSH_SESSION_TOKEN", TOKEN)
    monkeypatch.setenv("RUSH_WORKSPACE_ID", WORKSPACE)
    with CompareServer() as fake:
        yield fake


def seeded(server: CompareServer) -> None:
    """The member's own runs of two harnesses on the benchmark: the attempts at its one case are `a` and `b`."""
    with server.client_of() as member:
        benchmark = member.publish_benchmark(publication())[1]
    for harness, attempt, verdict in (("claude", "a", "pass"), ("codex", "b", "fail")):
        run_id = f"run-{harness}"
        server.runs[run_id] = make_run(run_id, benchmark, {"name": harness}, {"c1": (attempt, verdict)})


def compare(monkeypatch, server: CompareServer, tmp_path: Path, *overrides: str):
    config = "examples/uploaded_benchmark/configs/step4_compare.yaml"
    arguments = [
        "step",
        f"config={config}",
        f"home={tmp_path / 'home'}",
        "--",
        f"server.base_url={server.url}",
        "plugin=p",
        "plugin_version=1.0.0",
        "benchmark=probe",
        "harness_a=claude",
        "harness_b=codex",
        "case=c1",
        *overrides,
    ]
    monkeypatch.setattr(sys, "argv", arguments)
    with pytest.raises(SystemExit) as exit:
        step4.CompareHarnesses().run()
    assert exit.value.code in (None, 0)
    return load_layout(tmp_path / "home", step4.CompareLayout).comparison


def pair(server: CompareServer, a: Trace, b: Trace, **kwargs: Any) -> None:
    seeded(server)
    server.add("a", a)
    server.add("b", b, **kwargs)


def test_identical_attempts_have_no_difference(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded())
    result = compare(monkeypatch, server, tmp_path, "differences_only=true").attempts
    assert result.first_difference is None and result.rows == []
    assert result.header["condition_differences"] == [] and result.header["estimate_withheld"] is None
    assert result.header["case"] == {"package_sha256": "pkg", "task_id": "t", "content_digest": "d1"}
    assert all(method == "GET" for method, _ in server.requests[1:]), "after the set-up publish, the step only reads"


def test_a_changed_command_argv_is_a_field_diff(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded(argv=("go", "test", "./pkg")))
    result = compare(monkeypatch, server, tmp_path, "differences_only=true").attempts
    assert [row["status"] for row in result.rows] == ["changed"]
    row = result.rows[0]
    assert [d["path"] for d in row["input_diff"]] == ["$.argv[2]"]
    assert result.first_difference == row["index"]


def test_an_extra_tool_call_is_only_in_b(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded(extra_tool=True))
    result = compare(monkeypatch, server, tmp_path, "differences_only=true").attempts
    # The model call that proposed the extra call differs in its output; the extra call itself is only in B.
    assert [row["status"] for row in result.rows if row["status"] != "same"] == ["only_b"]
    assert [row["b"][0]["target"] for row in result.rows if row["status"] == "only_b"] == ["validate"]
    assert result.first_difference is not None


def test_parallel_calls_finishing_in_another_order_are_not_a_difference(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded(swap=True))
    result = compare(monkeypatch, server, tmp_path, "differences_only=true").attempts
    assert result.rows == [] and result.first_difference is None
    full = compare(monkeypatch, server, tmp_path / "full", "differences_only=false").attempts
    assert len(full.rows) > 0 and {row["status"] for row in full.rows} == {"same"}


def test_a_different_reference_rate_withholds_the_estimate_delta(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded(reference=50.0))
    result = compare(monkeypatch, server, tmp_path).attempts
    assert result.header["estimate_delta_ns"] is None and "reference rate" in result.header["estimate_withheld"]
    assert [d["name"] for d in result.header["condition_differences"]] == ["reference_tokens_per_second"]


def test_an_unsealed_attempt_is_rejected_by_the_server(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded(), sealed=False)
    with pytest.raises(BenchmarkError) as raised:
        compare(monkeypatch, server, tmp_path)
    assert (raised.value.status, raised.value.code) == (409, "attempt_not_sealed")


def test_different_case_content_is_rejected_by_the_server(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded(), digest="d2")
    with pytest.raises(BenchmarkError) as raised:
        compare(monkeypatch, server, tmp_path)
    assert (raised.value.status, raised.value.code) == (409, "not_same_case")
    assert server.attempt_compares == [{"a": "a", "b": "b"}]
    assert all(method == "GET" for method, _ in server.requests[1:]), "after the set-up publish, the step only reads"


def test_the_pair_s_table_and_the_attempts_are_found_by_case_and_harness_not_by_run_id(server, monkeypatch, tmp_path: Path, capsys) -> None:
    pair(server, recorded(), recorded(argv=("go", "test", "./pkg")))
    result = compare(monkeypatch, server, tmp_path)
    assert [(row.harness, row.verdicts) for row in result.table.rows] == [("claude", {"c1": "pass"}), ("codex", {"c1": "fail"})]
    assert (result.attempts.case, result.attempts.attempt_a, result.attempts.attempt_b) == ("c1", "a", "b")
    assert server.attempt_compares == [{"a": "a", "b": "b"}]
    out = capsys.readouterr().out
    assert out.splitlines()[0].split()[:2] == ["harness", "c1"] and "first difference: row" in out


def test_without_a_case_only_the_table_is_made(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded())
    result = compare(monkeypatch, server, tmp_path, "case=null")
    assert result.attempts is None and len(result.table.rows) == 2 and server.attempt_compares == []


def test_a_harness_you_never_ran_is_named(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded())
    with pytest.raises(LookupError, match="no run of pi"):
        compare(monkeypatch, server, tmp_path, "harness_b=pi")
