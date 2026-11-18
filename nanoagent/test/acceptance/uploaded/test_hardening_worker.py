"""CLI acceptance gate: worker hardening.

Run on the host (the worker runs in the worker container, see support.py):

    .venv/bin/python -m pytest test/acceptance/uploaded/test_hardening_worker.py -m uploaded_acceptance

* Generation-lookup reconciliation, end to end: the scripted upstream answers `GET /api/v1/generation` with 404 for a delay
  after each reply completes, then with OpenRouter-shaped accounting. The real worker reconciles in the background with
  bounded retries and posts a new accounting version; events are untouched; the reservations that were kept because the
  response carried no cost settle at the looked-up cost. Historical reads (CLI steps 3 and 4) never ask the upstream.
* A tool container that fails to launch ends only that attempt: the worker logs it, stops renewing, removes the attempt's
  sandbox and network, and claims and completes the next attempt. The server interrupts the faulted attempt on its own.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import scripted  # noqa: F401 - puts the helper directories on sys.path
import support
from recovery_support import attempt_containers, db, wait_until
from rush_server import RushServer, rush_server, unavailable
from scripted import ANSWER, session, turn

from nanoagent.plugin.package import pack
from nanoagent.uploaded.client import BenchmarkClient
from nanoagent.uploaded.reconcile import DEFAULT_DELAYS_S
from slimconfig import load_layout

import step4_compare  # noqa: E402  (scripted puts the examples on sys.path)

pytestmark = [pytest.mark.gvisor, pytest.mark.uploaded_acceptance]

PROBE = support.NANOAGENT / "test" / "plugins" / "acceptance-probe"
FAULT_WORKER = Path(__file__).resolve().parent / "fault_worker.py"
LEASE_S = 30
GENERATION_DELAY_S = 8.0
COST = 0.0123
SCRIPT = {"dialect": "chat_completions", "instrument": True}
NATIVE_PROMPT, NATIVE_COMPLETION = 410, 61


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable() or support.container_unavailable()
    if reason:
        pytest.skip(reason)
    with pytest.MonkeyPatch.context() as env:
        env.setenv("BENCHMARK_LEASE_SECONDS", str(LEASE_S))
        env.setenv("BENCHMARK_SWEEP_SECONDS", "2")
        with rush_server() as server:
            server.seed_plugin(pack(PROBE))
            yield server


def wait_turns(count: int) -> list[Any]:
    """``count`` runs of a streamed tool turn and the answer (the wire usage differs from the generation's native counts)."""
    return [t for _ in range(count) for t in (turn(act={"wait": 0.3}, prompt=400, completion=60, chunks=4), turn(act=ANSWER, prompt=500, completion=20))]


def calls_of(client: BenchmarkClient, attempt: str) -> list[dict[str, Any]]:
    return client.accounting(attempt)["calls"]


def test_generation_lookup_reconciles_in_the_background_and_historical_reads_never_look_up(rush: RushServer) -> None:
    from mockllm.engine import Generation, Usage

    generation = Generation(lookup=True, delay=GENERATION_DELAY_S, cost=COST, native=Usage(prompt=NATIVE_PROMPT, completion=NATIVE_COMPLETION))
    with session(rush, "genlookup", wait_turns(2), generation=generation) as sess:
        client = BenchmarkClient(rush.base_url, rush.workspace_id, rush.token)
        first = sess.submit("first", SCRIPT)
        attempt = first.attempts[0].attempt_id
        assert first.attempts[0].execution_status == "answered"
        events_before = client.events(attempt)
        before = calls_of(client, attempt)
        responses = [e for e in events_before.events if e["kind"] == "model_call.response"]
        generation_ids = sorted(e["data"]["generation_id"] for e in responses)
        assert len(generation_ids) >= 2 and all(g.startswith("gen-") for g in generation_ids)
        # The response carried no cost, so every reservation was kept (uncertain) and no accounting version exists yet.
        assert {c["admission"]["status"] for c in before} == {"uncertain"} and all(c["accounting"] is None for c in before)

        def reconciled() -> list[dict[str, Any]] | None:
            current = calls_of(client, attempt)
            return current if all(c["accounting"] is not None and c["admission"]["status"] == "settled" for c in current) else None

        after = wait_until(reconciled, "every call of the attempt to be reconciled", 180, interval=1.0)
        # Events are not rewritten: the same events, the same seal, provisional usage still as the wire carried it.
        events_after = client.events(attempt)
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
        totals = client.accounting(attempt)["totals"]
        assert totals["uncertain_calls"] == 0 and totals["reserved_usd"] == 0 and totals["settled_usd"] == pytest.approx(COST * len(after))
        # Bounded retries: the first lookup 404ed (it was inside its delay), and each generation was found once and never asked
        # about again. Calls are looked up one after another, so a later generation's delay may have passed by its first lookup.
        lookups = sess.handle.ledger.lookups
        assert lookups[0].status == 404, [(lookup.generation_id, lookup.status) for lookup in lookups]
        for generation_id in generation_ids:
            statuses = [lookup.status for lookup in lookups if lookup.generation_id == generation_id]
            assert statuses.count(200) == 1 and statuses[-1] == 200 and len(statuses) <= len(DEFAULT_DELAYS_S) + 1, statuses

        # A second attempt, so step 4 has two sealed attempts to compare; wait for its reconciliation too.
        second = sess.rerun("second", first)
        other = second.attempts[-1].attempt_id
        assert other != attempt
        wait_until(lambda: all(c["accounting"] is not None for c in calls_of(client, other)) and calls_of(client, other), "the rerun to be reconciled", 180, interval=1.0)
        sess.worker.stop()
        lookups_after = len(sess.handle.ledger.lookups)
        served = len(sess.handle.ledger.calls)

        # Historical reads, with the worker gone: CLI step 3 (trace and accounting) and step 4 (compare) never ask the upstream.
        trace = sess.trace(attempt, "history", extra=("accounting=true",))
        assert trace.accounting["calls"] == after
        home = sess.run_dir / "step4-history"
        sess.cli.step("4", "compare", home, f"run_a={first.run_id}", f"run_b={first.run_id}", f"attempt_a={attempt}", f"attempt_b={other}")
        assert load_layout(home, step4_compare.CompareLayout).comparison.attempts.rows
        assert len(sess.handle.ledger.lookups) == lookups_after and len(sess.handle.ledger.calls) == served
        sess.handle.ledger.assert_clean()


def test_a_tool_container_launch_failure_ends_only_that_attempt_and_the_worker_runs_the_next(rush: RushServer) -> None:
    with session(rush, "toolfault", wait_turns(1), entry=(str(FAULT_WORKER),)) as sess:
        client = BenchmarkClient(rush.base_url, rush.workspace_id, rush.token)
        faulted = sess.submit("faulted", SCRIPT, follow=False)
        attempt = faulted.attempts[0].attempt_id
        sess.worker.wait_for(f"INJECTED_TOOL_LAUNCH_FAILURE attempt={attempt}", 300)
        sess.worker.wait_for("platform fault", 60)
        # The worker is still polling: it did not exit, and the next submission is claimed and completes.
        assert sess.worker.process is not None and sess.worker.process.poll() is None
        second = sess.submit("next", SCRIPT)
        assert second.attempts[0].execution_status == "answered" and second.attempts[0].attempt_id != attempt
        # The faulted attempt stopped renewing, so the server interrupts it on its own (the sweep; no claim or read needed), keeping its evidence.
        deadline = time.monotonic() + LEASE_S + 60
        state = ""
        while time.monotonic() < deadline:
            state = db(rush, f"select state || '|' || coalesce(execution_status, '') from benchmark_attempt where attempt_id = '{attempt}'")
            if state == "final|interrupted":
                break
            time.sleep(1)
        assert state == "final|interrupted", state
        assert "attempt.started" in {e["kind"] for e in client.events(attempt).events}
        # Nothing of the faulted attempt is left in the worker container: containers, volumes, network.
        assert attempt_containers(attempt) == []
        leftovers = support.inside("bash", "-c", f"docker volume ls -q --filter name={attempt}; docker network ls -q --filter name={attempt}", timeout=120).stdout.split()
        assert leftovers == [], leftovers
        assert "Traceback" in sess.worker.text() and "injected launch failure" in sess.worker.text()
