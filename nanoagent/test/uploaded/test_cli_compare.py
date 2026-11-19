"""Step 4 (compare) against a fake RUSH server holding two recorded attempts built with the projection trace builder."""

from __future__ import annotations

import base64
import sys
from pathlib import Path
from typing import Any

import pytest
from fake_rush import TOKEN, WORKSPACE, FakeRush
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
        self.attempts: dict[str, dict[str, Any]] = {}

    def add(self, attempt_id: str, trace: Trace, *, sealed: bool = True, digest: str = "d1") -> None:
        self.traces[attempt_id] = trace
        self.attempts[attempt_id] = {"sealed": sealed, "digest": digest}

    def compare_attempts(self, request: Request) -> JSONResponse:
        ids = [request.query_params["a"], request.query_params["b"]]
        held = [self.attempts[i] for i in ids]
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


def compare(monkeypatch, server: CompareServer, tmp_path: Path, *overrides: str):
    config = "examples/uploaded_benchmark/configs/step4_compare.yaml"
    arguments = [
        "step",
        f"config={config}",
        f"home={tmp_path / 'home'}",
        "--",
        f"server.base_url={server.url}",
        "run_a=run-a",
        "run_b=run-b",
        "attempt_a=a",
        "attempt_b=b",
        *overrides,
    ]
    monkeypatch.setattr(sys, "argv", arguments)
    with pytest.raises(SystemExit) as exit:
        step4.CompareRuns().run()
    assert exit.value.code in (None, 0)
    return load_layout(tmp_path / "home", step4.CompareLayout).comparison.attempts


def pair(server: CompareServer, a: Trace, b: Trace, **kwargs: Any) -> None:
    server.add("a", a)
    server.add("b", b, **kwargs)


def test_identical_attempts_have_no_difference(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded())
    result = compare(monkeypatch, server, tmp_path, "differences_only=true")
    assert result.first_difference is None and result.rows == []
    assert result.header["condition_differences"] == [] and result.header["estimate_withheld"] is None
    assert result.header["case"] == {"package_sha256": "pkg", "task_id": "t", "content_digest": "d1"}
    assert all(method == "GET" for method, _ in server.requests)


def test_a_changed_command_argv_is_a_field_diff(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded(argv=("go", "test", "./pkg")))
    result = compare(monkeypatch, server, tmp_path, "differences_only=true")
    assert [row["status"] for row in result.rows] == ["changed"]
    row = result.rows[0]
    assert [d["path"] for d in row["input_diff"]] == ["$.argv[2]"]
    assert result.first_difference == row["index"]


def test_an_extra_tool_call_is_only_in_b(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded(extra_tool=True))
    result = compare(monkeypatch, server, tmp_path, "differences_only=true")
    # The model call that proposed the extra call differs in its output; the extra call itself is only in B.
    assert [row["status"] for row in result.rows if row["status"] != "same"] == ["only_b"]
    assert [row["b"][0]["target"] for row in result.rows if row["status"] == "only_b"] == ["validate"]
    assert result.first_difference is not None


def test_parallel_calls_finishing_in_another_order_are_not_a_difference(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded(swap=True))
    result = compare(monkeypatch, server, tmp_path, "differences_only=true")
    assert result.rows == [] and result.first_difference is None
    full = compare(monkeypatch, server, tmp_path / "full", "differences_only=false")
    assert len(full.rows) > 0 and {row["status"] for row in full.rows} == {"same"}


def test_a_different_reference_rate_withholds_the_estimate_delta(server, monkeypatch, tmp_path: Path) -> None:
    pair(server, recorded(), recorded(reference=50.0))
    result = compare(monkeypatch, server, tmp_path)
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
    assert all(method == "GET" for method, _ in server.requests)


def test_the_run_comparison_prints_the_configuration_and_prompt_differences(server, monkeypatch, tmp_path: Path, capsys) -> None:
    server.comparison = {
        "config": [
            {"field": "policy", "a": "coding", "b": "task_tools", "differs": True},
            {"field": "limits.internet_access", "a": True, "b": False, "differs": True},
            {"field": "model", "a": "m", "b": "m", "differs": False},
        ],
        "prompt_diff": {
            "a_kind": "template", "b_kind": "template",
            "text": [{"type": "removed", "text": "Solve it\n"}, {"type": "added", "text": "Solve it well\n"}, {"type": "same", "text": "x\n"}],
            "rendered": [{"content_digest": "cd1", "identical": False}, {"content_digest": "cd2", "identical": True}],
        },
        "shared": [{"a": {"case_id": "c1", "verdict": "fail", "outcome": "answered", "explanation": "invalid_answer", "cost_usd": None, "uncertain_cost": True}, "b": {"case_id": "c1", "verdict": "pass", "outcome": "answered", "explanation": None, "cost_usd": 0.5, "uncertain_cost": False}}], "only_a": [], "only_b": [{}],
        "unverified_egress": {"a": True, "b": False},
    }
    pair(server, recorded(), recorded())
    compare(monkeypatch, server, tmp_path)
    out = capsys.readouterr().out
    assert server.compares == [{"a": "run-a", "b": "run-b"}]
    assert "policy: 'coding' -> 'task_tools'" in out and "limits.internet_access: True -> False" in out and "model" not in out.split("prompt differences")[0].split("configuration differences")[1]
    assert "- Solve it" in out and "+ Solve it well" in out and "differ in 1 shared case(s)" in out
    assert "c1: a fail invalid_answer, cost unknown (uncertain); b pass, cost $0.5" in out
    assert "cases: 1 shared, 0 only in a, 1 only in b" in out and "unverified egress (internet access on): a True, b False" in out


def test_a_run_comparison_alone_skips_the_attempts(server, monkeypatch, tmp_path: Path) -> None:
    result = compare(monkeypatch, server, tmp_path, "attempt_a=null", "attempt_b=null")
    assert result is None


def test_the_comparison_is_titled_with_each_runs_harness_benchmark_and_plugin_version(server, monkeypatch, tmp_path: Path, capsys) -> None:
    compare(monkeypatch, server, tmp_path, "attempt_a=null", "attempt_b=null")
    comparison = load_layout(tmp_path / "home", step4.CompareLayout).comparison
    assert comparison.title_a == comparison.title_b == "h@1 on probe (p @ 1.0.0)"
    assert "h@1 on probe (p @ 1.0.0)\n  against\nh@1 on probe (p @ 1.0.0)" in capsys.readouterr().out
