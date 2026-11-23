"""CLI acceptance: recovery. Faults are injected into the real stack and read back through the member API and the database.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_recovery_access.py -m uploaded_acceptance

* A worker is paused (SIGSTOP) past its lease, then resumed: the server ends the attempt on its own as a worker error, keeping its committed
  evidence, and queues the case again (a rerun of it), which the resumed worker runs.
* A run is canceled while its case session is in flight: the attempt ends `canceled`, nothing is committed after its seal, and no sandbox of
  it is left. (Who may read a run is test_private_runs.py's.)

Each runs a case of `nanoagent` whose script holds the agent in a long `sleep`.
"""

from __future__ import annotations

import os
import signal
import time

import pytest
import stack as st
from stack import Stack, attempt_containers, wait_until

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]

LEASE_S = 30


@pytest.fixture
def server_timing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCHMARK_LEASE_SECONDS", str(LEASE_S))
    monkeypatch.setenv("BENCHMARK_SWEEP_SECONDS", "2")


def in_flight(s: Stack, key: str) -> tuple[str, str]:
    """Submits the case with an agent held in a long `sleep`; returns its run and attempt once its session has launched."""
    s.script(st.B_WINS, "nanoagent", st.script_of({"wait": 600}))
    [report] = s.submit("ab-report", ["nanoagent"], key, follow=False)
    run_id = report["run_id"]
    attempt = s.client.run(run_id)["cases"][0]["attempts"][0]["attempt_id"]
    wait_until(lambda: "case.launched" in {event["kind"] for event in s.events(attempt)}, "the case session to launch", 300)
    time.sleep(5)  # the agent is at its `sleep`
    return run_id, attempt


def test_an_expired_lease_is_a_worker_error_that_keeps_its_evidence_and_queues_the_case_again(server_timing: None) -> None:
    if reason := st.skip_reason():
        pytest.skip(reason)
    with st.stack("test_recovery_access_lease") as s:
        s.publish("ab-report", st.AB_B_CASES)
        run_id, attempt = in_flight(s, "lease")
        committed = s.events(attempt)
        os.kill(s.worker.pid, signal.SIGSTOP)  # the worker stops renewing its lease
        try:
            state = wait_until(
                lambda: (found := s.row(f"select state || '|' || coalesce(execution_status, '') from benchmark_attempt where attempt_id = '{attempt}'")) == "final|worker_error" and found,
                "the server to end the attempt as a worker error", LEASE_S + 90, interval=1,
            )  # fmt: skip
        finally:
            os.kill(s.worker.pid, signal.SIGCONT)
        assert state == "final|worker_error"
        after = s.events(attempt)
        assert after[: len(committed)] == committed and "attempt.started" in {event["kind"] for event in after}
        # The same transaction queued the case again: a second attempt, a rerun of the first (the resumed worker may have claimed it already).
        attempts = s.client.run(run_id)["cases"][0]["attempts"]
        assert [(a["attempt_no"], a["rerun_of"]) for a in attempts] == [(1, None), (2, attempt)]
        assert attempts[0]["execution"]["status"] == "worker_error" and attempts[1]["state"] in ("queued", "leased")
        # The resumed worker is not the first attempt's any more (its lease changed): it commits nothing more and the seal stands.
        time.sleep(10)
        assert s.events(attempt) == after and s.attempt(attempt)["execution"]["status"] == "worker_error"


def test_cancel_ends_the_attempt_and_nothing_is_committed_after_its_seal() -> None:
    if reason := st.skip_reason():
        pytest.skip(reason)
    with st.stack("test_recovery_access_cancel") as s:
        s.publish("ab-report", st.AB_B_CASES)
        run_id, attempt = in_flight(s, "cancel")
        s.client.cancel(run_id)
        wait_until(lambda: s.attempt(attempt)["sealed"], "the canceled attempt to seal", 180, interval=1)
        assert s.attempt(attempt)["execution"]["status"] == "canceled" and s.client.run(run_id)["status"] == "canceled"
        sealed = s.events(attempt)
        time.sleep(10)
        assert s.events(attempt) == sealed
        assert wait_until(lambda: attempt_containers(attempt) == [] or None, "the attempt's sandboxes to be removed", 60) is not None
