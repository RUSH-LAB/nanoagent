"""CLI acceptance, step 2 with `nanoagent`: how a case is scored. Each scenario is one attempt of the real stack whose model script makes
the agent do one thing wrong (or right), and the attempt's verdict, the failing check, the explanation and whether the verifier ran are what
RUSH recorded.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_case_scoring.py -m uploaded_acceptance

The `ab-report` cases are the acceptance-probe plugin's state task (fixtures, a reference tool computing the before-state, a verifier of five
named checks); the verifier-error case is a copy of the plugin whose verifier raises for one token.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import plugins
import pytest
import yaml
import stack as st
from stack import Stack

from nanoagent.plugin.package import pack

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]

# A run is a whole suite, so each case is its own one-case benchmark (stack.AB_B_CASES, AB_A_CASES, AB_REFUSAL_CASES), named by what it holds.
B_WINS_BENCHMARK, A_WINS_BENCHMARK, REFUSAL_BENCHMARK = "ab-b-wins", "ab-a-wins", "ab-refusal"
CHECKS = ("outcome_exists", "schema_valid", "values_match", "side_effects", "no_extra_changes")
CRASH = "probe-crash"
# The agent's own tool times out (about 30 s) on a long `sleep`; the wall limit must come first.
WALL_MS, SMALL_BYTES = 15_000, 100_000


@dataclass
class Attempt:
    report: dict[str, Any]
    line: dict[str, Any]
    attempt: dict[str, Any]
    events: list[dict[str, Any]]

    @property
    def verifier_ran(self) -> bool:
        return any(event["kind"] == "verdict" for event in self.events)

    @property
    def failed_check(self) -> str | None:
        failed = [check["name"] for check in self.attempt["checks"] or [] if check["status"] == "failed"]
        return failed[0] if failed else None


# name -> (benchmark, case key, acts)
SCORED: dict[str, tuple[str, str, list[Any]]] = {
    "no_record": (B_WINS_BENCHMARK, st.B_WINS, st.ab_acts("b_wins", record=False)),
    "malformed_record": (B_WINS_BENCHMARK, st.B_WINS, st.ab_acts("b_wins", record="{not json")),
    "rate_off_by_a_tenth": (B_WINS_BENCHMARK, st.B_WINS, st.ab_acts("b_wins", shift=0.1)),
    "trap_scenario_reported": (B_WINS_BENCHMARK, st.B_WINS, st.ab_acts("b_wins", trap=True)),
    "bucket_added_when_a_wins": (A_WINS_BENCHMARK, st.A_WINS, st.ab_acts("a_wins", cloud="wrong")),
    "csv_edited": (B_WINS_BENCHMARK, st.B_WINS, st.ab_acts("b_wins", edit_csv="inputs/ab_Beauty.csv")),
    "extra_file": (B_WINS_BENCHMARK, st.B_WINS, st.ab_acts("b_wins", extra_file="notes.txt")),
    "refusal_refused": (REFUSAL_BENCHMARK, st.MISSING, [{"refuse": "inputs/ab_Missing.csv is not in the workspace"}]),
    "answer_case_refused": (B_WINS_BENCHMARK, st.B_WINS, [{"refuse": "I will not"}]),
    "refusal_case_answered": (REFUSAL_BENCHMARK, st.MISSING, [{"write": {"path": "answer.json", "text": '{"record": "record.json"}'}}]),
}
EXECUTION: dict[str, tuple[str, str, list[Any]]] = {
    "wall_limit": ("ab-report-wall", st.B_WINS, [{"wait": 600}]),
    "workspace_over_bound": ("ab-report-small", st.B_WINS, [*st.ab_acts("b_wins"), {"write": {"path": "big.bin", "text": "x" * (2 * SMALL_BYTES)}}]),
}


class Scenarios:
    """The module's stack, and each scenario's attempt, run the first time a test asks for it (so `-k` runs only what it needs)."""

    def __init__(self, s: Stack) -> None:
        self.s = s
        self.found: dict[str, Attempt] = {}
        for name, cases, limits in (
            (B_WINS_BENCHMARK, st.AB_B_CASES, None), (A_WINS_BENCHMARK, st.AB_A_CASES, None), (REFUSAL_BENCHMARK, st.AB_REFUSAL_CASES, None),
            ("ab-report-wall", st.AB_B_CASES, {"wall_time_ms": WALL_MS}), ("ab-report-small", st.AB_B_CASES, {"workspace_bytes": SMALL_BYTES}),
        ):
            s.publish(name, cases, limits=limits)

    def run(self, name: str, benchmark: str, key: str, scenario: Any, plugin: str = st.PLUGIN) -> Attempt:
        s = self.s
        s.script(key, "nanoagent", scenario)
        [report] = s.submit(benchmark, ["nanoagent"], name.replace("_", "-"), plugin=plugin)
        [line] = report["attempts"]
        found = Attempt(report, line, s.attempt(line["attempt_id"]), s.events(line["attempt_id"]))
        (s.logs / f"{name}.json").write_text(json.dumps({"attempt": found.attempt, "events": found.events}, indent=1))
        self.found[name] = found
        return found

    def __getitem__(self, name: str) -> Attempt:
        if name in self.found:
            return self.found[name]
        if name in SCORED or name in EXECUTION:
            benchmark, key, acts = {**SCORED, **EXECUTION}[name]
            return self.run(name, benchmark, key, st.script_of(*acts))
        if name == "nonzero_exit":
            # A provider that fails every call ends the agent with a nonzero status.
            return self.run(name, B_WINS_BENCHMARK, st.B_WINS, st.scenario(st.turn(status=400, repeat=0)))
        assert name == "verifier_error", name
        # A verifier that raises: a copy of the plugin whose probe verifier raises for the token verifier-crash.
        s = self.s
        s.rush.seed_plugin(pack(plugins.variant(s.run_dir / CRASH, plugin_id=CRASH, crash_token=True)))
        prompt = "Wait 0 seconds, then answer with the digest of the token verifier-crash: the first 12 lowercase hex digits of the SHA-256 of the token's UTF-8 bytes."
        crash_cases = s.run_dir / "crash_cases.yaml"
        crash_cases.write_text(yaml.safe_dump({"plugin": CRASH, "task": "probe", "cases": [{"prompt": prompt, "arguments": {"token": "verifier-crash", "wait_seconds": 0}}], "refuse": []}))
        s.publish(CRASH, crash_cases, plugin=CRASH)
        return self.run(name, CRASH, "token verifier-crash:", st.script_of(*st.digest_acts("verifier-crash")), plugin=CRASH)


@pytest.fixture(scope="module")
def results() -> Iterator[Scenarios]:
    if reason := st.skip_reason():
        pytest.skip(reason)
    with st.stack("test_case_scoring") as s:
        yield Scenarios(s)


@pytest.mark.parametrize(
    ("name", "check"),
    [
        ("no_record", "outcome_exists"),
        ("malformed_record", "schema_valid"),
        ("rate_off_by_a_tenth", "values_match"),
        ("trap_scenario_reported", "values_match"),
        ("bucket_added_when_a_wins", "side_effects"),
        ("csv_edited", "no_extra_changes"),
        ("extra_file", "no_extra_changes"),
    ],
)
def test_a_wrong_state_fails_naming_the_check_that_caught_it(results: Scenarios, name: str, check: str) -> None:
    run = results[name]
    assert (run.attempt["execution"]["status"], run.attempt["verdict"]) == ("answered", "fail"), run.attempt
    assert run.failed_check == check
    # A check after the failed one is skipped, so a missing file, a malformed one and a wrong value read differently.
    statuses = {item["name"]: item["status"] for item in run.attempt["checks"]}
    assert [statuses[each] for each in CHECKS] == ["passed"] * CHECKS.index(check) + ["failed"] + ["skipped"] * (len(CHECKS) - CHECKS.index(check) - 1)
    assert run.verifier_ran and run.report["score"]["value"] == 0


def test_a_refusal_case_refused_passes(results: Scenarios) -> None:
    run = results["refusal_refused"]
    assert (run.attempt["execution"]["status"], run.attempt["verdict"], run.attempt["explanation"]) == ("refused", "pass", None)
    assert run.report["score"]["value"] == 1


@pytest.mark.parametrize(
    ("name", "status", "explanation"),
    [("answer_case_refused", "refused", "refused_answer_case"), ("refusal_case_answered", "answered", "answered_refusal_case")],
)
def test_refusing_an_answer_case_and_answering_a_refusal_case_fail_with_their_explanations(results: Scenarios, name: str, status: str, explanation: str) -> None:
    attempt = results[name].attempt
    assert (attempt["execution"]["status"], attempt["verdict"], attempt["explanation"]) == (status, "fail", explanation)


@pytest.mark.parametrize(
    ("name", "reason"), [("wall_limit", "timed_out"), ("nonzero_exit", "nonzero_exit"), ("workspace_over_bound", "invalid_result")]
)
def test_an_execution_that_failed_is_unverified_and_says_why(results: Scenarios, name: str, reason: str) -> None:
    run = results[name]
    assert run.attempt["execution"] == {"status": "execution_failed", "reason": reason}, run.attempt
    # The verifier did not run: the attempt is a scored failure with the explanation execution_failed and no checks, never a verifier verdict.
    assert (run.attempt["verdict"], run.attempt["explanation"], run.attempt["checks"]) == ("fail", "execution_failed", None), run.attempt
    [verdict] = [event for event in run.events if event["kind"] == "verdict"]
    assert verdict["data"] == {"verdict": "fail", "explanation": "execution_failed"}, verdict


def test_a_verifier_that_raises_leaves_the_case_unscored_never_passed(results: Scenarios) -> None:
    run = results["verifier_error"]
    assert run.attempt["execution"]["status"] == "answered"
    assert run.attempt["verdict"] is None and run.attempt["verifier_error"], run.attempt
    assert run.report["score"]["value"] is None and run.report["score"]["unscored"] == 1 and run.report["score"]["verifier_errors"] == 1, run.report["score"]
    assert "the verifier raised" or run.attempt["verifier_error"]
