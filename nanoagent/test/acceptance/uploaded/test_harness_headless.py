"""CLI acceptance, step 2 with every agent of the shell harness: each of `claude`, `codex`, `pi`, `dsh`, `hermes` and `nanoagent` runs one
case headless from the command its row of `harnesses.yaml` declares, in a real VM, installed from the mocked registries; the first message
the model gets is the case's prompt, the shell exits by itself, and the verdict is the scripted one. `nanoagent` alone is offered the plugin's
task tools.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_harness_headless.py -m uploaded_acceptance

All six run by default: none is skipped, and a missing agent is a failure.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
import stack as st
import yaml

from nanoagent.uploaded import reference

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]

TABLE = {row["name"]: row for row in yaml.safe_load((reference.FOLDER / "shell" / "harnesses.yaml").read_text())}


@dataclass
class Headless:
    report: dict[str, Any]
    ledger: Any
    attempt: dict[str, Any]
    events: list[dict[str, Any]]


@pytest.fixture(scope="module")
def runs() -> Iterator[tuple[dict[str, Headless], dict[str, Any]]]:
    if reason := st.skip_reason():
        pytest.skip(reason)
    with st.stack("test_harness_headless") as s:
        published = s.publish("ab-report", st.AB_B_CASES)
        benchmark = s.client.benchmark(published["benchmark"]["benchmark_id"])
        ledgers = {harness: s.script(st.B_WINS, harness, st.script_of(*st.ab_acts("b_wins"))).ledger for harness in st.HARNESSES}
        reports = {report["harness"]: report for report in s.submit("ab-report", list(st.HARNESSES), "headless")}
        found = {}
        for harness in st.HARNESSES:
            [line] = reports[harness]["attempts"]
            found[harness] = Headless(reports[harness], ledgers[harness], s.attempt(line["attempt_id"]), s.events(line["attempt_id"]))
            (s.logs / f"{harness}.json").write_text(json.dumps({"attempt": found[harness].attempt, "events": found[harness].events}, indent=1))
        yield found, benchmark


@pytest.mark.parametrize("harness", st.HARNESSES)
def test_each_agent_runs_the_case_headless_and_the_verdict_is_the_scripted_one(runs: Any, harness: str) -> None:
    found, benchmark = runs
    run = found[harness]
    assert run.report["status"] == "complete" and run.report["score"]["value"] == 1, run.report
    assert (run.attempt["execution"], run.attempt["verdict"]) == ({"status": "answered", "reason": None}, "pass"), run.attempt
    assert not run.ledger.violations
    # The first message the model got is the case's prompt, the same text for every agent.
    assert benchmark["cases"][0]["prompt"] in st.user_texts(run.ledger.calls[0].request)
    # The shell exited by itself, with the agent's status, well inside the wall limit.
    [exited] = [event for event in run.events if event["kind"] == "case.exited"]
    assert exited["data"]["termination"] == {"status": "exited", "exit_code": 0}, exited
    assert run.attempt["metrics"]["elapsed_ms"] < benchmark["limits"]["wall_time_ms"] / 2


@pytest.mark.parametrize("harness", st.HARNESSES)
def test_the_agent_was_started_by_its_declared_headless_command(runs: Any, harness: str) -> None:
    found, benchmark = runs
    command = [*TABLE[harness]["headless"], benchmark["cases"][0]["prompt"]]
    argvs = [event["data"]["argv"] for event in found[harness].events if event["kind"] == "process.exec"]
    assert command in argvs, (command[:-1], [argv[:5] for argv in argvs][:12])


def test_nanoagent_alone_is_offered_the_plugins_task_tools(runs: Any) -> None:
    found, _ = runs
    offered = {harness: {tool.name for tool in run.ledger.calls[0].request.tools} for harness, run in found.items()}
    assert "wait" in offered["nanoagent"], offered["nanoagent"]
    assert [harness for harness, names in offered.items() if "wait" in names or "ab_reference" in names] == ["nanoagent"], offered
