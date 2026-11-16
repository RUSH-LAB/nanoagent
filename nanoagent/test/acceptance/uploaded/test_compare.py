"""CLI acceptance gate: compare recorded actions, through step 4 on sealed attempts of the same pinned case.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_compare.py -m uploaded_acceptance

One run and two reruns of the scripted-loop harness take scripted turns in order: attempt A is the baseline, B changes one tool
input, swaps the proposal order of a parallel pair, retries a 429 and keeps the repeated identical calls, and C adds one tool call.
Step 4 reads both attempts' stored events and payloads, so no model is asked anything while comparing.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
import scripted  # noqa: F401 - puts the helper directories on sys.path before the imports below
import support
from rush_server import RushServer, psql, rush_server, unavailable
from scripted import ANSWER, Session, session, turn
from slimconfig import load_layout

import step4_compare  # noqa: E402  (scripted puts the examples on sys.path)
from nanoagent.plugin.package import pack
from nanoagent.uploaded.client import BenchmarkClient

pytestmark = [pytest.mark.gvisor, pytest.mark.uploaded_acceptance]

PROBE = support.NANOAGENT / "test" / "plugins" / "acceptance-probe"
CHANGED_INSTRUCTIONS = "Compare gate: work the task with the wait tool, then submit the digest of the input's token."
SCRIPT = {"dialect": "chat_completions", "instrument": False, "retries": 2, "backoff_s": 0.1}


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable() or support.container_unavailable()
    if reason:
        pytest.skip(reason)
    with rush_server() as server:
        server.seed_plugin(pack(PROBE))
        yield server


def attempt_turns(*, pair: tuple[float, float], changed: float, retry: bool = False, extra: bool = False) -> list[Any]:
    """A parallel pair of waits, the same wait twice, one more wait (`changed` seconds), optionally a retried 429 and one more call, then the answer."""
    return [
        turn(act=[{"wait": pair[0]}, {"wait": pair[1]}], prompt=100, completion=10),
        turn(act={"wait": 0.3}, prompt=120, completion=10),
        turn(act={"wait": 0.3}, prompt=140, completion=10),
        *([turn(status=429)] if retry else []),
        turn(act={"wait": changed}, prompt=160, completion=10),
        *([turn(act={"wait": 0.1}, prompt=170, completion=10)] if extra else []),
        turn(act=ANSWER, prompt=180, completion=10),
    ]


@dataclass
class Compared:
    rush: RushServer
    session: Session
    run: Any
    a: str
    b: str
    c: str
    ab: Path  # step 4's home for A against B
    ac: Path
    calls_before: int
    calls_after: int
    changed_run: Any
    second_run: Any


def compare(sess: Session, name: str, run_a: Any, run_b: Any, a: str, b: str, *overrides: str) -> Path:
    """Step 4 on two runs of the same case set (distinct runs) and one sealed attempt of each, which share the pinned case."""
    assert run_a.run_id != run_b.run_id
    home = sess.run_dir / f"step4-{name}"
    sess.cli.step("4", "compare", home, f"run_a={run_a.run_id}", f"run_b={run_b.run_id}", f"attempt_a={a}", f"attempt_b={b}", *overrides)
    return home


def rows_of(home: Path) -> Any:
    comparison = load_layout(home, step4_compare.CompareLayout).comparison
    assert comparison.attempts is not None
    return comparison.attempts


@pytest.fixture(scope="module")
def compared(rush: RushServer) -> Iterator[Compared]:
    turns = [
        *attempt_turns(pair=(0.2, 0.6), changed=0.4),
        *attempt_turns(pair=(0.6, 0.2), changed=0.45, retry=True),
        *attempt_turns(pair=(0.2, 0.6), changed=0.4, extra=True),
        *attempt_turns(pair=(0.2, 0.6), changed=0.4),  # the fourth run: the first run's work under another prompt and limits
    ]
    with session(rush, "compare", turns) as sess:
        first = sess.submit("a", SCRIPT)
        second = sess.submit("b", SCRIPT)
        third = sess.submit("c", SCRIPT)
        # The prompt and the limit are the benchmark's: the fourth run is on a benchmark of the same cases with other ones.
        changed = sess.publish("loop-compare-changed", instructions=CHANGED_INSTRUCTIONS, limits={"wall_time_ms": 500_000})
        fourth = sess.submit("d", SCRIPT, benchmark=changed)
        a, b, c = (run.attempts[0].attempt_id for run in (first, second, third))
        before = len(sess.handle.ledger.calls)
        ab = compare(sess, "ab", first, second, a, b, "differences_only=false")
        ac = compare(sess, "ac", first, third, a, c, "differences_only=false")
        # Two distinct runs with another prompt and another limit, compared as runs.
        sess.cli.step("4", "compare", sess.run_dir / "step4-runs-ad", f"run_a={first.run_id}", f"run_b={fourth.run_id}")
        yield Compared(rush, sess, first, a, b, c, ab, ac, before, len(sess.handle.ledger.calls), fourth, second)


def rows(home: Path) -> list[dict[str, Any]]:
    return rows_of(home).rows


def tool_rows(home: Path, seconds: float | None = None) -> list[dict[str, Any]]:
    """The rows of tool actions, optionally only those whose input on either side is this wait."""
    found = [row for row in rows(home) if (row["a"] or row["b"])[0]["kind"] == "tool"]
    return found if seconds is None else [row for row in found if {action["input"]["wait_seconds"] for action in (*row["a"], *row["b"])} == {seconds}]


def test_comparison_reads_stored_evidence_and_asks_no_model(compared: Compared) -> None:
    assert compared.calls_before == compared.calls_after == 5 + 6 + 6 + 5  # the requests of the four attempts, and none for step 4
    assert not compared.session.handle.ledger.violations
    for home in (compared.ab, compared.ac):
        header = rows_of(home).header
        assert header["condition_differences"] == [] and header["missing_payloads"] == {"a": [], "b": []}
        [case] = compared.session.rush_run(compared.run)["cases"]
        assert header["case"]["content_digest"] == case["content_digest"] and header["case"]["task_id"] == "probe"
    assert rows_of(compared.ab).header["attempt_a"] == compared.a and rows_of(compared.ab).header["attempt_b"] == compared.b


def test_parallel_calls_proposed_in_a_different_order_show_no_difference_from_that_order(compared: Compared) -> None:
    # A proposes 0.2 then 0.6, B proposes 0.6 then 0.2: the same two keys in one parallel group, equal on both sides.
    shorter, longer = tool_rows(compared.ab, 0.2), tool_rows(compared.ab, 0.6)
    assert [row["status"] for row in (*shorter, *longer)] == ["same", "same"]
    assert shorter[0]["group"] == longer[0]["group"] is not None
    for row in (*shorter, *longer):
        assert row["input_diff"] == [] and row["output_diff"] == [] and row["sequence_changed"] is False
    # What did differ is recorded where it happened: the model's proposals came in the other order.
    [first] = [row for row in rows(compared.ab) if row["index"] == 0]
    assert [diff["path"] for diff in first["output_diff"]] == ["$.proposals[0].arguments.wait_seconds", "$.proposals[1].arguments.wait_seconds"]
    assert [(diff["a"], diff["b"]) for diff in first["output_diff"]] == [(0.2, 0.6), (0.6, 0.2)]


def test_repeated_identical_calls_keep_their_duplicate_count(compared: Compared) -> None:
    for home in (compared.ab, compared.ac):
        repeated = tool_rows(home, 0.3)
        assert [row["status"] for row in repeated] == ["same", "same"]
        assert all(len(row["a"]) == len(row["b"]) == 1 for row in repeated)
        assert repeated[0]["a"][0]["action_id"] != repeated[1]["a"][0]["action_id"]


def test_a_changed_input_is_one_exact_field_difference(compared: Compared) -> None:
    [changed] = [row for row in tool_rows(compared.ab) if row["status"] == "changed"]
    assert changed["a"][0]["input"] == {"wait_seconds": 0.4} and changed["b"][0]["input"] == {"wait_seconds": 0.45}
    assert changed["input_diff"] == [{"path": "$.wait_seconds", "a": 0.4, "b": 0.45, "a_present": True, "b_present": True}]
    assert changed["status_diff"] is None and changed["sequence_changed"] is False
    assert [row["status"] for row in tool_rows(compared.ac) if row["status"] == "changed"] == []


def test_an_additional_call_is_only_in_b_and_the_unpairable_model_calls_are_ambiguous(compared: Compared) -> None:
    [extra] = tool_rows(compared.ac, 0.1)
    assert extra["status"] == "only_b" and extra["a"] == [] and extra["b"][0]["input"] == {"wait_seconds": 0.1}
    [ambiguous] = [row for row in rows(compared.ac) if row["status"] == "ambiguous"]
    assert (len(ambiguous["a"]), len(ambiguous["b"])) == (1, 2) and "cannot be paired" in ambiguous["reason"]


def test_a_retry_is_an_extra_model_call_with_the_same_request_and_stays_ambiguous(compared: Compared) -> None:
    [ambiguous] = [row for row in rows(compared.ab) if row["status"] == "ambiguous"]
    assert (len(ambiguous["a"]), len(ambiguous["b"])) == (2, 3) and "2 vs 3" in ambiguous["reason"]
    # The 429 and its retry carry the same effective request: two of B's candidates are identical.
    digests = [action["input"]["request_sha256"] for action in ambiguous["b"]]
    assert len(digests) == 3 and len(set(digests)) == 2
    assert {action["status"] for action in ambiguous["b"]} >= {"completed", "http_error"}


def test_unrecorded_cost_and_estimate_are_unknown_not_equal(compared: Compared) -> None:
    for home in (compared.ab, compared.ac):
        header = rows_of(home).header
        assert header["estimate_delta_ns"] is None and header["estimate_withheld"] == "an estimate is unknown"
        assert header["unknown_fields"] == ["provider"]
        [first] = [row for row in rows(home) if row["index"] == 0]
        assert first["cost_delta"] == {"unknown": "cost was not recorded on both sides"}


def differs(row: dict[str, Any]) -> bool:
    """A row that records a change, absence or ambiguity; an unknown cost, token or duration is none of those."""
    return row["status"] != "same" or any(row[field] for field in ("input_diff", "output_diff", "status_diff")) or row["sequence_changed"] is True


def test_the_first_difference_is_a_recorded_change_never_an_unknown_cost(compared: Compared) -> None:
    # Every row's cost is unrecorded (the mock reports none), which must not make row 0 the first difference of every comparison.
    ab, ac = rows_of(compared.ab), rows_of(compared.ac)
    model_calls = [row for row in ac.rows if row["status"] == "same" and row["a"][0]["kind"] == "model_call"]
    assert model_calls and all(row["cost_delta"] == {"unknown": "cost was not recorded on both sides"} for row in model_calls)
    # A against B: the first model call differs because its proposals came in the other order.
    assert ab.first_difference == 0 and differs(ab.rows[0]) and ab.rows[0]["output_diff"]
    # A against C: the first model call is identical, so the first difference is further on, and it is a recorded one.
    assert not differs(ac.rows[0])
    assert ac.first_difference is not None and ac.first_difference > 0 and differs(ac.rows[ac.first_difference])
    assert all(not differs(row) for row in ac.rows[: ac.first_difference] if row["group"] is None)


def test_a_payload_lost_on_one_side_makes_the_affected_action_unknown(compared: Compared) -> None:
    client = BenchmarkClient(compared.rush.base_url, compared.rush.workspace_id, compared.rush.token)
    events = client.events(compared.b).events
    [invoked] = [e for e in events if e["kind"] == "tool.invoked" and json.loads(client.payload(compared.b, e["data"]["arguments_sha256"]).data) == {"wait_seconds": 0.45}]
    digest = invoked["data"]["arguments_sha256"]
    deleted = psql(compared.rush.database, f"delete from benchmark_payload where attempt_id = '{compared.b}' and sha256 = '{digest}' returning 1")
    assert deleted == "1"
    home = compare(compared.session, "ab-lost", compared.run, compared.second_run, compared.a, compared.b)
    assert rows_of(home).header["missing_payloads"] == {"a": [], "b": [digest]}
    [lost] = [row for row in rows(home) if any(action["input"] is None for action in row["b"])]
    # The side that lost the input is not read as a difference or an absence: the row is unknown, and A's action is still shown.
    assert lost["status"] == "unknown" and lost["a"]
    assert not compared.session.handle.ledger.violations and len(compared.session.handle.ledger.calls) == compared.calls_after


def test_two_distinct_runs_compare_as_runs_with_the_prompt_and_limit_differences_shown(compared: Compared) -> None:
    comparison = load_layout(compared.session.run_dir / "step4-runs-ad", step4_compare.CompareLayout).comparison.runs
    assert compared.run.run_id != compared.changed_run.run_id
    assert {item["field"] for item in comparison["config"] if item["differs"]} == {"benchmark_id", "limits.wall_time_ms"}
    [wall] = [item for item in comparison["config"] if item["field"] == "limits.wall_time_ms"]
    assert (wall["a"], wall["b"]) == (600_000, 500_000)
    added = "\n".join(part["text"] for part in comparison["prompt_diff"]["text"] if part["type"] == "added")
    assert "Compare gate" in added and "\n".join(part["text"] for part in comparison["prompt_diff"]["text"] if part["type"] == "removed")
    # The one case is shared by content, with another prompt rendered for it; nothing is one-sided.
    [shared] = comparison["shared"]
    assert shared["a"]["case_id"] == shared["b"]["case_id"] and comparison["only_a"] == comparison["only_b"] == []
    [rendered] = comparison["prompt_diff"]["rendered"]
    assert rendered["identical"] is False and comparison["unverified_egress"] == {"a": False, "b": False}
