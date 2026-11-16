"""CLI acceptance gate: save and reopen. A finished run is read again in fresh CLI processes after the scripted upstream is shut
down and the worker restarted: the same sealed cursor, prompts, payload digests, usage and verdict, a selected span, and no new
model request.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_reopen.py -m uploaded_acceptance
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
import scripted  # noqa: F401 - puts the helper directories on sys.path before the imports below
import support
from rush_server import RushServer, rush_server, unavailable
from scripted import ANSWER, session, turn

from nanoagent.plugin.package import pack

pytestmark = [pytest.mark.gvisor, pytest.mark.uploaded_acceptance]

PROBE = support.NANOAGENT / "test" / "plugins" / "acceptance-probe"
SCRIPT = {"dialect": "chat_completions", "instrument": False}


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable() or support.vm_available()
    if reason:
        pytest.skip(reason)
    with pytest.MonkeyPatch.context() as env:
        env.setenv("BENCHMARK_WORKER_TOKEN", "worker-acceptance-token")
        with rush_server() as server:
            server.seed_plugin(pack(PROBE))
            yield server


@dataclass
class Reopened:
    run: Any
    live: Any  # step 3's Trace while the upstream and the worker were up
    live_tool: Any  # the same read narrowed to the tool spans
    live_payloads: Any
    reopened: Any
    reopened_tool: Any
    reopened_payloads: Any
    served: int
    served_after: int
    restart_log: str
    digests: list[str]
    run_dir: Path


@pytest.fixture(scope="module")
def reopen(rush: RushServer) -> Iterator[Reopened]:
    turns = [
        turn(act={"wait": 0.3}, prompt=300, cached=100, cache_write=50, completion=20, ttfb=0.1),
        turn(act=ANSWER, prompt=400, cached=300, completion=10),
    ]
    with session(rush, "reopen", turns) as sess:
        run = sess.submit("loop", SCRIPT)
        attempt = run.attempts[0].attempt_id
        live = sess.trace(attempt, "live")
        # The selected span and its stored payloads: the tool span, its arguments, and the first model call's three payloads.
        [invoked] = [event for event in live.events if event["kind"] == "tool.invoked"]
        [completed] = [event for event in live.events if event["kind"] == "tool.completed"]
        [admitted, *_] = [event for event in live.events if event["kind"] == "model_call.admitted"]
        [first, *_] = [event for event in live.events if event["kind"] == "model_call.response"]
        digests = [invoked["data"]["arguments_sha256"], completed["data"]["output_sha256"], admitted["data"]["submitted_request_sha256"]]
        digests.append(first["data"]["stream_payload_sha256"])
        live_tool = sess.trace(attempt, "live-tool", *digests[:3], extra=("span_kind=tool",))
        live_payloads = sess.trace(attempt, "live-response", digests[3])
        served = len(sess.handle.ledger.calls)
        sess.close_upstream()
        restarted = sess.restart_worker("reopen-restarted")
        restarted.wait_for("204 No Content", 300)  # it is up and polling for work: and finds none
        reopened = sess.trace(attempt, "reopened")
        reopened_tool = sess.trace(attempt, "reopened-tool", *digests[:3], extra=("span_kind=tool",))
        reopened_payloads = sess.trace(attempt, "reopened-response", digests[3])
        yield Reopened(run, live, live_tool, live_payloads, reopened, reopened_tool, reopened_payloads, served, len(sess.handle.ledger.calls), restarted.text(), digests, sess.run_dir)


def test_the_sealed_cursor_events_and_attempt_are_unchanged(reopen: Reopened) -> None:
    live, again = reopen.live, reopen.reopened
    assert live.sealed and again.sealed
    assert live.final_cursor == again.final_cursor == live.high_water_cursor == again.high_water_cursor == len(live.events)
    assert again.events == live.events
    assert again.attempt == live.attempt and again.spans == live.spans and again.links == live.links


def test_prompts_digests_usage_and_verdict_are_the_stored_ones(reopen: Reopened) -> None:
    live, again = reopen.live, reopen.reopened
    assert again.attempt["prompt"] == live.attempt["prompt"]
    assert again.attempt["verdict"] == "pass" == live.attempt["verdict"]
    digests = lambda trace: sorted({d for event in trace.events for d in event["payload_sha256s"]})  # noqa: E731
    assert digests(again) == digests(live) and len(digests(live)) > 5
    usage = lambda trace: [event["data"]["usage"] for event in trace.events if event["kind"] == "model_call.response"]  # noqa: E731
    assert usage(again) == usage(live)
    assert [(u["input"], u["output"], u["cache_read"], u["cache_write"]) for u in usage(again)] == [(300, 20, 100, 50), (400, 10, 300, 0)]
    assert again.attempt["metrics"] == live.attempt["metrics"] and again.accounting == live.accounting
    assert again.attempt["metrics"]["total_tokens"] == 730


def test_a_selected_span_and_its_payloads_are_read_back_identically(reopen: Reopened) -> None:
    live, again = reopen.live_tool, reopen.reopened_tool
    [span] = live.spans
    assert span["kind"] == "tool" and again.spans == live.spans
    assert [(p.sha256, p.size, p.content_type, p.redaction) for p in again.payloads] == [(p.sha256, p.size, p.content_type, p.redaction) for p in live.payloads]
    assert [p.sha256 for p in again.payloads] == reopen.digests[:3]
    for before, after, digest in [("live-tool", "reopened-tool", d) for d in reopen.digests[:3]] + [("live-response", "reopened-response", reopen.digests[3])]:
        stored = (reopen.run_dir / f"trace-{before}" / "payloads" / digest).read_bytes()
        assert (reopen.run_dir / f"trace-{after}" / "payloads" / digest).read_bytes() == stored


def test_nothing_new_is_asked_of_the_model(reopen: Reopened) -> None:
    assert reopen.served == reopen.served_after == 2
    assert "model_call" not in reopen.restart_log and "finalized" not in reopen.restart_log and "attempt " not in reopen.restart_log.replace("attempts/", "")
