"""CLI acceptance: worker hardening.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_hardening_worker.py -m uploaded_acceptance

* Generation-lookup reconciliation, end to end: the scripted upstream answers `GET /api/v1/generation` with 404 for a delay after each reply
  completes, then with OpenRouter-shaped accounting. The real worker reconciles in the background with bounded retries and posts a new
  accounting version; events are untouched; the reservations that were kept because the response carried no cost settle at the looked-up
  cost. Reading the attempt again (CLI step 3) never asks the upstream.
* A tool container that fails to launch is the worker's error, not the harness's: each attempt is finalized `worker_error` (no verifier),
  RUSH queues the case again, and after the third attempt the case, and so the run, is a worker error and not graded. The worker logs each,
  removes the attempt's sandbox and network, and claims and completes the next run's case.

Both run a case of `nanoagent`, the one agent the plugin's task tools are offered to (the tool container launches for it).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import stack as st
from mockllm.engine import Generation, Usage
from stack import Stack, attempt_containers, wait_until

from nanoagent.uploaded.reconcile import DEFAULT_DELAYS_S

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]

FAULT_WORKER = Path(__file__).resolve().parent / "fault_worker.py"
LEASE_S = 30
# Longer than the case session takes to end (a reply's lookups start once the attempt is final), so the first lookups come inside the delay.
GENERATION_DELAY_S = 25.0
COST = 0.0123
NATIVE_PROMPT, NATIVE_COMPLETION = 410, 61


@pytest.fixture
def server_timing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCHMARK_LEASE_SECONDS", str(LEASE_S))
    monkeypatch.setenv("BENCHMARK_SWEEP_SECONDS", "2")


def calls_of(s: Stack, attempt: str) -> list[dict[str, Any]]:
    return s.client.accounting(attempt)["calls"]


def test_generation_lookup_reconciles_in_the_background_and_historical_reads_never_look_up(server_timing: None) -> None:
    if reason := st.skip_reason():
        pytest.skip(reason)
    generation = Generation(lookup=True, delay=GENERATION_DELAY_S, cost=COST, native=Usage(prompt=NATIVE_PROMPT, completion=NATIVE_COMPLETION))
    with st.stack("test_hardening_worker_generation") as s:
        s.publish("ab-report", st.AB_B_CASES)
        run = s.script(st.B_WINS, "nanoagent", st.script_of(*st.ab_acts("b_wins"), generation=generation))
        [report] = s.submit("ab-report", ["nanoagent"], "genlookup")
        attempt = report["attempts"][-1]["attempt_id"]  # the newest: a worker error on an earlier try is retried, and the run's attempt is the last
        assert report["attempts"][-1]["execution_status"] == "answered"
        events_before = s.client.events(attempt)
        before = calls_of(s, attempt)
        responses = [e for e in events_before.events if e["kind"] == "model_call.response"]
        generation_ids = sorted(e["data"]["generation_id"] for e in responses)
        assert len(generation_ids) >= 2 and all(g.startswith("gen-") for g in generation_ids)
        # The response carried no cost, so every reservation was kept (uncertain) and no accounting version exists yet.
        assert {c["admission"]["status"] for c in before} == {"uncertain"} and all(c["accounting"] is None for c in before)

        def reconciled() -> list[dict[str, Any]] | None:
            current = calls_of(s, attempt)
            return current if all(c["accounting"] is not None and c["admission"]["status"] == "settled" for c in current) else None

        after = wait_until(reconciled, "every call of the attempt to be reconciled", 180, interval=1.0)
        # Events are not rewritten: the same events, the same seal, provisional usage still as the wire carried it.
        events_after = s.client.events(attempt)
        assert events_after.events == events_before.events and events_after.final_cursor == events_before.final_cursor and events_after.sealed
        provisional = {e["data"]["generation_id"]: e["data"]["usage"] for e in responses}
        assert all(u is not None and u["cost_usd"] is None for u in provisional.values())
        # The new version is the lookup's accounting, with native counts and total_cost, and settles the reservation at that cost.
        by_call = {e["data"]["call_id"]: e["data"]["generation_id"] for e in responses}
        for call in after:
            assert call["accounting"]["version"] == 1
            record = call["accounting"]["record"]
            assert record["provenance"] == "openrouter_generation" and record["cost_usd"] == pytest.approx(COST)
            assert record["generation_id"] == by_call[call["call_id"]] and record["generation"]["id"] == record["generation_id"]
            assert (record["generation"]["native_tokens_prompt"], record["generation"]["native_tokens_completion"]) == (NATIVE_PROMPT, NATIVE_COMPLETION)
            assert call["admission"]["cost_usd"] == pytest.approx(COST) and call["admission"]["provenance"]["source"] == "generation_lookup"
        totals = s.client.accounting(attempt)["totals"]
        assert totals["uncertain_calls"] == 0 and totals["reserved_usd"] == 0 and totals["settled_usd"] == pytest.approx(COST * len(after))
        # Bounded retries: each generation was found once and never asked about again, and the delay was honoured (the worker reconciles one
        # call after another, so the first generation 404ed, inside its delay, before it was found).
        by_generation = {g: [lookup.status for lookup in run.ledger.lookups if lookup.generation_id == g] for g in generation_ids}
        for statuses in by_generation.values():
            assert statuses.count(200) == 1 and statuses[-1] == 200 and len(statuses) <= len(DEFAULT_DELAYS_S) + 1, by_generation
        assert any(statuses[0] == 404 for statuses in by_generation.values()), by_generation

        s.worker.stop()
        lookups_after, served = len(run.ledger.lookups), len(run.ledger.calls)
        # Historical reads, with the worker gone: CLI step 3 (trace and accounting) never asks the upstream.
        trace = s.trace(attempt, "accounting=true")
        assert trace["accounting"]["calls"] == after
        assert len(run.ledger.lookups) == lookups_after and len(run.ledger.calls) == served
        run.ledger.assert_clean()


def test_a_tool_container_launch_failure_is_retried_twice_then_a_worker_error_and_the_worker_runs_the_next(server_timing: None) -> None:
    if reason := st.skip_reason():
        pytest.skip(reason)
    with st.stack("test_hardening_worker_fault", entry=(str(FAULT_WORKER),)) as s:
        s.publish("ab-report", st.AB_B_CASES)
        s.publish("ab-a-wins", st.AB_A_CASES)
        s.script(st.B_WINS, "nanoagent", st.script_of(*st.ab_acts("b_wins")))
        s.script(st.A_WINS, "nanoagent", st.script_of(*st.ab_acts("a_wins")))
        [faulted] = s.submit("ab-report", ["nanoagent"], "faulted")
        # The plugin's tools not starting is the platform's fault, not the harness's: each attempt is finalized a worker error with the
        # exception as its reason, RUSH queues the case again, and the third ends it: three attempts, the run not graded.
        attempts = faulted["attempts"]
        assert [(a["attempt_no"], a["execution_status"], a["verdict"], a["checks"]) for a in attempts] == [(n, "worker_error", None, None) for n in (1, 2, 3)]
        for failed in attempts:
            attempt = failed["attempt_id"]
            assert f"INJECTED_TOOL_LAUNCH_FAILURE attempt={attempt}" in s.worker.text()
            assert f"attempt {attempt}: the plugin's tools could not start: start_failed: create tool container: injected launch failure" in s.worker.text()
            assert f"attempt {attempt}: worker error" in s.worker.text()
            reason = s.attempt(attempt)["execution"]["reason"]
            assert reason.startswith("SandboxError: start_failed") and "injected launch failure" in reason
            assert attempt_containers(attempt) == []  # nothing of a faulted attempt is left: no sandbox of it
        assert faulted["status"] == "complete" and faulted["score"]["value"] is None and faulted["score"]["unavailable_reason"] == "worker_error"
        assert s.client.run(faulted["run_id"])["cases"][0]["attempts"][1]["rerun_of"] == attempts[0]["attempt_id"]
        # The worker is still polling: it did not exit, and the next submission is claimed and completes.
        assert s.worker.process is not None and s.worker.process.poll() is None
        [report] = s.submit("ab-a-wins", ["nanoagent"], "next")
        assert len(report["attempts"]) == 1 and report["attempts"][0]["execution_status"] == "answered"
        assert report["attempts"][0]["verdict"] == "pass" and report["score"]["value"] == 1.0
        assert "attempt.started" in {e["kind"] for e in s.client.events(attempts[0]["attempt_id"]).events}
