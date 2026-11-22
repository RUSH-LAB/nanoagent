"""CLI acceptance, steps 2 and 5: a whole benchmark run with several harnesses. One step 2 call runs every case of the benchmark once per
harness and follows the runs to the end (or only the cases it names); step 5's table has a row per harness and a column per case, and its
verdicts, tokens and cost are what the scripts and the mock's ledger say.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_full_benchmark.py -m uploaded_acceptance

`nanoagent`, `claude` and `codex` each work the three `ab-report` cases (two to answer, one to refuse) and are scripted to differ.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
import stack as st
from stack import Stack

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]

HARNESSES = ["nanoagent", "claude", "codex"]
CASES = ["acceptance-probe-01", "acceptance-probe-02", "acceptance-probe-03"]
REFUSE = [{"refuse": "inputs/ab_Missing.csv is not in the workspace"}]
# harness -> case -> (acts, the verdict the script earns)
SCRIPTS: dict[str, dict[str, tuple[tuple[str, list[Any]], str]]] = {
    "nanoagent": {
        CASES[0]: ((st.B_WINS, st.ab_acts("b_wins")), "pass"),
        CASES[1]: ((st.A_WINS, st.ab_acts("a_wins")), "pass"),
        CASES[2]: ((st.MISSING, REFUSE), "pass"),
    },
    "claude": {
        CASES[0]: ((st.B_WINS, st.ab_acts("b_wins")), "pass"),
        CASES[1]: ((st.A_WINS, st.ab_acts("a_wins", shift=0.1)), "fail"),
        CASES[2]: ((st.MISSING, REFUSE), "pass"),
    },
    "codex": {
        CASES[0]: ((st.B_WINS, st.ab_acts("b_wins", record=False)), "fail"),
        CASES[1]: ((st.A_WINS, st.ab_acts("a_wins")), "pass"),
        CASES[2]: ((st.MISSING, [{"write": {"path": "answer.json", "text": '{"record": "record.json"}'}}]), "fail"),
    },
}


@dataclass
class Full:
    s: Stack
    runs: list[dict[str, Any]]
    ledgers: dict[str, list[Any]]
    table: dict[str, Any]
    printed: str


@pytest.fixture(scope="module")
def full() -> Iterator[Full]:
    if reason := st.skip_reason():
        pytest.skip(reason)
    with st.stack("test_full_benchmark") as s:
        s.publish("ab-report", st.AB_CASES)
        ledgers: dict[str, list[Any]] = {harness: [] for harness in HARNESSES}
        for harness, cases in SCRIPTS.items():
            for (key, acts), _ in cases.values():
                ledgers[harness].append(s.script(key, harness, st.script_of(*acts)).ledger)
        runs = s.submit("ab-report", HARNESSES, "full")
        printed, kept = s.table("ab-report")
        yield Full(s, runs, ledgers, kept, printed)


def test_one_call_runs_every_case_once_per_harness_and_follows_the_runs_to_the_end(full: Full) -> None:
    assert [run["harness"] for run in full.runs] == HARNESSES
    for run in full.runs:
        assert run["status"] == "complete" and run["case_ids"] == CASES and len(run["attempts"]) == 3, run
        assert all(attempt["sealed"] and attempt["state"] == "final" for attempt in run["attempts"])


def test_the_table_has_a_row_per_harness_and_a_column_per_case_with_the_scenarios_verdicts(full: Full) -> None:
    table = full.table
    # One row per harness, the harness whose run was submitted last first.
    assert table["cases"] == CASES and [row["harness"] for row in table["rows"]] == HARNESSES[::-1]
    for row in table["rows"]:
        expected = {case: verdict for case, (_, verdict) in SCRIPTS[row["harness"]].items()}
        assert row["verdicts"] == expected, row
        passed = sum(verdict == "pass" for verdict in expected.values())
        assert (row["passed"], row["scored"], row["total"], row["pass_rate"]) == (passed, 3, 3, passed / 3)
        assert set(row["attempts"]) == set(CASES)


def test_tokens_equal_the_ledger_exactly_and_cost_follows_from_the_mocks_prices(full: Full) -> None:
    for row in full.table["rows"]:
        usage = [ledger.usage("main", "side") for ledger in full.ledgers[row["harness"]]]
        assert all(not ledger.violations for ledger in full.ledgers[row["harness"]])
        tokens_in, tokens_out = sum(each.input for each in usage), sum(each.output for each in usage)
        assert row["total_tokens"] == tokens_in + tokens_out and row["tokens_missing_attempts"] == 0, (row["harness"], row["total_tokens"], usage)
        # Every call, main or side, carries the same tokens, so what the gateway settled is the worker's price of the ledger's tokens.
        assert row["cost_usd"] == pytest.approx(tokens_in * st.INPUT_PRICE + tokens_out * st.OUTPUT_PRICE, rel=1e-9), row["harness"]


def test_the_printed_json_is_the_table_the_step_kept_and_the_text_shows_the_same_cells(full: Full) -> None:
    as_json, kept = full.s.table("ab-report", as_json=True)
    assert as_json == {key: value for key, value in kept.items() if key != "_"} == {key: value for key, value in full.table.items() if key != "_"}
    lines = full.printed.strip().splitlines()
    header = re.split(r"\s{2,}", lines[0])
    assert header[:1] + header[1:4] == ["harness", *CASES]
    for line, row in zip(lines[1:], full.table["rows"], strict=True):
        cells = re.split(r"\s{2,}", line)
        assert cells[0] == row["harness"] and cells[1:4] == [row["verdicts"][case] for case in CASES], line
        assert cells[4].startswith(f"{row['pass_rate']:.2f} ({row['passed']}/{row['scored']} of {row['total']})")
        assert cells[5] == f"{row['total_tokens']:,}"
