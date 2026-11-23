"""CLI acceptance: save and reopen. A finished attempt is read again in fresh CLI processes after the worker was restarted: the same sealed
cursor, events, prompt, payload digests, usage and verdict, a selected span's payloads, and no new model request.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_reopen.py -m uploaded_acceptance
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
import stack as st
from mockllm import Turn, Usage
from stack import Stack

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]


@dataclass
class Reopened:
    s: Stack
    attempt_id: str
    live: dict[str, Any]
    reopened: dict[str, Any]
    live_payloads: dict[str, Any]
    reopened_payloads: dict[str, Any]
    digests: list[str]
    served: int
    served_after: int
    restart_log: str


def payloads(s: Stack, trace: dict[str, Any], folder: Path) -> dict[str, bytes]:
    return {payload["sha256"]: (folder / payload["file"]).read_bytes() for payload in trace["payloads"]}


@pytest.fixture(scope="module")
def reopen() -> Iterator[Reopened]:
    if reason := st.skip_reason():
        pytest.skip(reason)
    with st.stack("test_reopen") as s:
        s.publish("ab-report", st.AB_B_CASES)
        run = s.script(
            st.B_WINS, "nanoagent",
            st.scenario(
                Turn(act=st.ab_acts("b_wins"), usage=Usage(prompt=300, cached=100, cache_write=50, completion=20)),
                Turn(text="done", usage=Usage(prompt=400, cached=300, completion=10), repeat=0),
            ),
        )  # fmt: skip
        [report] = s.submit("ab-report", ["nanoagent"], "reopen")
        attempt_id = report["attempts"][0]["attempt_id"]
        live = s.trace(attempt_id)
        [admitted, *_] = [event for event in live["events"] if event["kind"] == "model_call.admitted"]
        [first, *_] = [event for event in live["events"] if event["kind"] == "model_call.response"]
        digests = [admitted["data"]["submitted_request_sha256"], first["payload_sha256s"][0]]
        live_payloads = s.trace(attempt_id, f"payloads=[{','.join(digests)}]", "span_kind=model_call")
        served = len(run.ledger.calls)
        s.worker.stop()
        s.worker.start()
        s.worker.wait_for("204 No Content", 300)  # it is up and polling for work, and finds none
        reopened = s.trace(attempt_id)
        reopened_payloads = s.trace(attempt_id, f"payloads=[{','.join(digests)}]", "span_kind=model_call")
        yield Reopened(s, attempt_id, live, reopened, live_payloads, reopened_payloads, digests, served, len(run.ledger.calls), s.worker.text())


def test_the_sealed_cursor_events_and_attempt_are_unchanged(reopen: Reopened) -> None:
    live, again = reopen.live, reopen.reopened
    assert live["sealed"] and again["sealed"]
    assert live["final_cursor"] == again["final_cursor"] == live["high_water_cursor"] == again["high_water_cursor"] == len(live["events"])
    assert again["events"] == live["events"]
    assert again["attempt"] == live["attempt"] and again["spans"] == live["spans"] and again["links"] == live["links"]


def test_prompts_digests_usage_and_verdict_are_the_stored_ones(reopen: Reopened) -> None:
    live, again = reopen.live, reopen.reopened
    assert again["attempt"]["verdict"] == "pass" == live["attempt"]["verdict"] and again["verdict"] == live["verdict"]
    digests = lambda trace: sorted({d for event in trace["events"] for d in event["payload_sha256s"]})  # noqa: E731
    assert digests(again) == digests(live) and len(digests(live)) > 5
    usage = lambda trace: [event["data"]["usage"] for event in trace["events"] if event["kind"] == "model_call.response"]  # noqa: E731
    assert usage(again) == usage(live)
    assert [(u["input"], u["output"], u["cache_read"], u["cache_write"]) for u in usage(again)] == [(300, 20, 100, 50), (400, 10, 300, 0)]
    assert again["attempt"]["metrics"] == live["attempt"]["metrics"] and again["accounting"] == live["accounting"]
    assert again["attempt"]["metrics"]["total_tokens"] == 730


def test_a_selected_span_and_its_payloads_are_read_back_identically(reopen: Reopened) -> None:
    live, again = reopen.live_payloads, reopen.reopened_payloads
    assert live["spans"] and again["spans"] == live["spans"] and all(span["kind"] == "model_call" for span in live["spans"])
    assert [(p["sha256"], p["size"], p["content_type"], p["redaction"]) for p in again["payloads"]] == [
        (p["sha256"], p["size"], p["content_type"], p["redaction"]) for p in live["payloads"]
    ]
    assert [p["sha256"] for p in again["payloads"]] == reopen.digests


def test_nothing_new_is_asked_of_the_model(reopen: Reopened) -> None:
    assert reopen.served == reopen.served_after == 2
    # The startup line listing the advertised capabilities names `max_model_calls`; it is not a model call.
    log = "\n".join(line for line in reopen.restart_log.splitlines() if "advertised capabilities:" not in line)
    assert "model_call" not in log and "finalized" not in log and "attempt " not in log.replace("attempts/", "")
