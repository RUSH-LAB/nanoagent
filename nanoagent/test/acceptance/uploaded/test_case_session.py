"""CLI acceptance, step 2 with one case: a benchmark case is a Terminal session. The workspace starts as the case's fixtures, the first
message the model gets is the case's prompt byte for byte, nothing of the case's typed input or reference enters the VM, the session leaves
the capture a Harness-tab session leaves, and the verdict follows the harness' exit, the snapshot and the worker's one verifier run.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_case_session.py -m uploaded_acceptance

The real RUSH server, the real worker and its microsandbox VMs, `nanoagent` and `claude` installed from the mocked registries, the
scripted OpenRouter upstream.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
import stack as st
from stack import Stack

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]

LISTING = "find . -type f -not -path './.rush/*' -exec sha256sum {} +; echo ---ENV---; env | sort"
# Names only the case's typed input and the reference's before-state have: none may reach the model, the VM's environment or its files.
PRIVATE = ("csv_paths", "cloud_path", "output_path", "bucket_prefix", "log_entry", "seeded_sha256", "empty_scenarios", "cloud_buckets", "cloud_logs")


@dataclass
class Session:
    harness: str
    run: Any
    ledger: Any
    attempt: dict[str, Any]
    events: list[dict[str, Any]]

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [event for event in self.events if event["kind"] == kind]


@pytest.fixture(scope="module")
def stacked() -> Iterator[tuple[Stack, dict[str, Session], dict[str, Any]]]:
    if reason := st.skip_reason():
        pytest.skip(reason)
    with st.stack("test_case_session") as s:
        published = s.publish("ab-report", st.AB_B_CASES)
        benchmark = s.client.benchmark(published["benchmark"]["benchmark_id"])
        sessions = {}
        for harness in ("nanoagent", "claude"):
            run = s.script(st.B_WINS, harness, st.scenario(st.turn([{"shell": LISTING}]), st.turn(st.ab_acts("b_wins")), st.turn(text="done", repeat=0)))
            [report] = s.submit("ab-report", [harness], f"session-{harness}")
            [line] = report["attempts"]
            sessions[harness] = Session(harness, report, run.ledger, s.attempt(line["attempt_id"]), s.events(line["attempt_id"]))
        yield s, sessions, benchmark


def test_the_b_wins_case_passes_with_nanoagent_and_with_claude(stacked: Any) -> None:
    _, sessions, _ = stacked
    for session in sessions.values():
        assert session.run["status"] == "complete" and session.run["score"]["value"] == 1, session.run
        assert (session.attempt["execution"], session.attempt["verdict"], session.attempt["sealed"]) == ({"status": "answered", "reason": None}, "pass", True)
        assert [(check["name"], check["status"]) for check in session.attempt["checks"]] == [
            (name, "passed") for name in ("outcome_exists", "schema_valid", "values_match", "side_effects", "no_extra_changes")
        ]
        assert not session.ledger.violations


def test_the_workspace_at_start_holds_exactly_the_fixtures_and_the_seeded_answer(stacked: Any) -> None:
    _, sessions, benchmark = stacked
    fixtures = benchmark["cases"][0]["fixtures"]["files"]
    for session in sessions.values():
        # The agent listed its workspace before touching it: the tool result is in the model's next request.
        listed = set(re.findall(r"([0-9a-f]{64})  \./([^\\\n\"]+)", json.dumps(session.ledger.calls[1].request.body)))
        seen = {path: digest for digest, path in listed}
        assert "answer.json" in seen, session.harness  # the worker's seeded, unfilled answer
        assert {path: digest for path, digest in seen.items() if path != "answer.json"} == fixtures, session.harness


def test_the_first_user_message_is_the_prompt_byte_for_byte(stacked: Any) -> None:
    _, sessions, benchmark = stacked
    prompt = benchmark["cases"][0]["prompt"]
    for session in sessions.values():
        first = session.ledger.calls[0].request
        assert prompt in st.user_texts(first), session.harness


def test_nothing_of_the_typed_input_or_the_reference_enters_the_vm(stacked: Any) -> None:
    s, sessions, _ = stacked
    for session in sessions.values():
        # Every request the model got holds the agent's own listing of its environment, so what the VM held is what the model saw.
        bodies = [json.dumps(call.request.body) for call in session.ledger.calls if call.request]
        assert "---ENV---" in bodies[1] and "RUSH_PROMPT" in bodies[1]
        files = s.workspace(session.attempt["attempt_id"])
        for name in PRIVATE:
            assert not any(name in body for body in bodies), (session.harness, name)
            assert not any(name.encode() in data for data in files.values()), (session.harness, name)


def test_the_trace_orders_the_harness_exit_the_snapshot_and_the_one_verdict(stacked: Any) -> None:
    for session in stacked[1].values():
        kinds = [event["kind"] for event in session.events]
        assert kinds.index("case.exited") < kinds.index("snapshot.taken") < kinds.index("result.read") < kinds.index("verdict"), kinds
        assert kinds.count("verdict") == 1 and kinds.count("snapshot.taken") == 1
        [exited] = session.of("case.exited")
        assert exited["data"]["termination"] == {"status": "exited", "exit_code": 0}
        [verdict] = session.of("verdict")
        assert verdict["data"]["verdict"] == "pass" and len(verdict["data"]["checks"]) == 5
        [outcome] = session.of("result.read")
        assert outcome["data"]["outcome"] == {"status": "answered", "answer": {"record": "record.json"}}
        # The snapshot diff is what the agent made against the seeded fixtures, and the session's own state is not in it.
        [snapshot] = session.of("snapshot.taken")
        assert {entry["path"]: entry["change"] for entry in snapshot["data"]["diff"]} == {
            "answer.json": "modified", "record.json": "added", "inputs/cloud.json": "modified",
        }, snapshot["data"]["diff"]  # fmt: skip


def test_a_case_attempt_leaves_the_capture_a_harness_tab_session_leaves(stacked: Any) -> None:
    s, sessions, benchmark = stacked
    prompt = benchmark["cases"][0]["prompt"]
    for session in sessions.values():
        attempt_id = session.attempt["attempt_id"]
        # The terminal recording is readable, and holds what the agent said.
        assert "done" in s.recording(attempt_id), session.harness
        # The worker's collector, the process recorder and the gateway's accounting are all there.
        assert session.of("collector.health") and session.of("process.exec") and session.of("model_call.response")
        assert session.attempt["coverage"]["status"] == "complete", session.attempt["coverage"]
        # finalize carried the agent CLI's chats, and the workspace archive was uploaded and holds the files the agent left.
        [chats] = s.row(f"select chats from benchmark_attempt where attempt_id = '{attempt_id}'").splitlines()
        held = json.loads(chats)
        # Claude Code keeps its conversation where the session reads it (chats.py); NanoAgent's chats are taken from the recording.
        assert [chat["agent"] for chat in held] == (["claude"] if session.harness == "claude" else []), (session.harness, held)
        assert all(prompt.startswith(chat["title"].removesuffix("…")) and chat["id"] and chat["started_ns"] for chat in held), held
        files = s.workspace(attempt_id)
        assert {"record.json", "answer.json", "inputs/cloud.json", "inputs/ab_Beauty.csv"} <= set(files)
        assert json.loads(files["record.json"])["winner"] == "B"
