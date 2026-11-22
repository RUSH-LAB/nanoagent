"""CLI acceptance, steps 4 and 3: two harnesses compared on one benchmark, and one attempt opened.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_compare_harnesses.py -m uploaded_acceptance

`nanoagent` and `claude` work the three `ab-report` cases; `claude` is scripted to get the A-wins case's rates wrong, so the pair differs
in a verdict, and the attempts at the B-wins case, which both pass by different tool calls, differ in their actions.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
import stack as st
from stack import Stack

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]

B_CASE, A_CASE, REFUSAL = "acceptance-probe-01", "acceptance-probe-02", "acceptance-probe-03"
REFUSE = [{"refuse": "inputs/ab_Missing.csv is not in the workspace"}]
CHECKS = ["outcome_exists", "schema_valid", "values_match", "side_effects", "no_extra_changes"]


@dataclass
class Compared:
    s: Stack
    runs: dict[str, dict[str, Any]]
    ledgers: dict[str, dict[str, Any]]
    comparison: dict[str, Any]


@pytest.fixture(scope="module")
def compared() -> Iterator[Compared]:
    if reason := st.skip_reason():
        pytest.skip(reason)
    with st.stack("test_compare_harnesses") as s:
        s.publish("ab-report", st.AB_CASES)
        ledgers: dict[str, dict[str, Any]] = {"nanoagent": {}, "claude": {}}
        for harness, shift in (("nanoagent", 0.0), ("claude", 0.1)):
            for case, key, acts in (
                (B_CASE, st.B_WINS, st.ab_acts("b_wins")),
                (A_CASE, st.A_WINS, st.ab_acts("a_wins", shift=shift)),
                (REFUSAL, st.MISSING, REFUSE),
            ):
                ledgers[harness][case] = s.script(key, harness, st.script_of(*acts)).ledger
        runs = {run["harness"]: run for run in s.submit("ab-report", ["nanoagent", "claude"], "compare")}
        yield Compared(s, runs, ledgers, s.compare("ab-report", "nanoagent", "claude", case=B_CASE))


def test_the_pairs_table_has_a_row_per_harness_in_the_order_asked(compared: Compared) -> None:
    table = compared.comparison["table"]
    assert table["cases"] == [B_CASE, A_CASE, REFUSAL] and [row["harness"] for row in table["rows"]] == ["nanoagent", "claude"]
    assert [row["verdicts"] for row in table["rows"]] == [
        {B_CASE: "pass", A_CASE: "pass", REFUSAL: "pass"},
        {B_CASE: "pass", A_CASE: "fail", REFUSAL: "pass"},
    ]
    assert [row["run_id"] for row in table["rows"]] == [compared.runs["nanoagent"]["run_id"], compared.runs["claude"]["run_id"]]


def test_the_attempts_at_one_case_are_aligned_action_by_action_with_the_first_difference(compared: Compared) -> None:
    attempts = compared.comparison["attempts"]
    rows = {row["harness"]: row for row in compared.comparison["table"]["rows"]}
    assert attempts["case"] == B_CASE
    assert (attempts["attempt_a"], attempts["attempt_b"]) == (rows["nanoagent"]["attempts"][B_CASE], rows["claude"]["attempts"][B_CASE])
    # Different agents work the case by different tool calls, so the alignment finds actions and the first one that differs.
    assert attempts["rows"] and isinstance(attempts["first_difference"], int) and 0 <= attempts["first_difference"] < len(attempts["rows"]), attempts["first_difference"]
    assert {row["status"] for row in attempts["rows"]} - {"same"}, [row["status"] for row in attempts["rows"]]
    header = attempts["header"]
    assert (header["attempt_a"], header["attempt_b"]) == (attempts["attempt_a"], attempts["attempt_b"])


def test_the_step_refuses_two_equal_harnesses_and_a_harness_never_run(compared: Compared) -> None:
    done = compared.s.cli.step("4", "compare", compared.s.home("bad"), f"plugin={st.PLUGIN}", "plugin_version=0.1.0", "benchmark=ab-report", "harness_a=claude", "harness_b=claude", check=False)
    assert done.returncode != 0 and done.stderr.strip().splitlines()[-1] == "ValueError: harness_a and harness_b are two harnesses"
    done = compared.s.cli.step("4", "compare", compared.s.home("bad"), f"plugin={st.PLUGIN}", "plugin_version=0.1.0", "benchmark=ab-report", "harness_a=claude", "harness_b=codex", f"case={B_CASE}", check=False)
    assert done.returncode != 0 and done.stderr.strip().splitlines()[-1] == "LookupError: you have no run of codex on ab-report"


def test_the_trace_of_an_attempt_shows_its_outcome_verdict_checks_and_workspace_diff(compared: Compared) -> None:
    s = compared.s
    line = next(line for line in compared.runs["claude"]["attempts"] if line["case_id"] == A_CASE)
    trace = s.trace(line["attempt_id"])
    assert trace["sealed"] is True and trace["attempt"]["attempt_id"] == line["attempt_id"] and "claude" in trace["title"]
    assert trace["outcome"] == {"status": "answered", "reason": None, "answer": {"record": "record.json"}}
    assert trace["verdict"]["verdict"] == "fail" and trace["verdict"]["verifier_error"] is None
    assert [(check["name"], check["status"]) for check in trace["verdict"]["checks"]] == [
        ("outcome_exists", "passed"), ("schema_valid", "passed"), ("values_match", "failed"), ("side_effects", "skipped"), ("no_extra_changes", "skipped"),
    ]  # fmt: skip
    assert {entry["path"]: entry["change"] for entry in trace["workspace_diff"]["entries"]} == {"answer.json": "added", "record.json": "added", "inputs/cloud.json": "modified"}
    assert trace["workspace_diff"]["truncated"] is False
    # The events and the gateway's accounting are the attempt's own: every model call the mock served.
    ledger = compared.ledgers["claude"][A_CASE]
    assert trace["accounting"]["totals"]["calls"] == len([call for call in ledger.calls if call.kind in ("main", "side")]) and trace["events"] and trace["spans"]
