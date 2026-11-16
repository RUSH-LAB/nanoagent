"""CLI acceptance gate: recovery and access.

Run on the host (workers run in the worker container, see support.py):

    .venv/bin/python -m pytest test/acceptance/uploaded -m uploaded_acceptance -k recovery

Faults are injected into the real stack and read back through the CLI steps, the member API and the database:

* a worker is paused (SIGSTOP) past its lease, then resumed: the attempt is interrupted with its evidence kept;
* a worker is killed (SIGKILL) while an upstream request it already sent is unanswered;
* a run is canceled while a model stream, a workspace-writing tool and a managed command are in flight;
* a harness exits with all of those in flight, and the worker re-reads the workspace after its snapshot (recovery_worker.py);
* a harness fires concurrent model requests at a tight attempt budget, and a hand-driven worker races the member and
  workspace caps on a server with small caps.

Access checks run against the attempts those faults left behind.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import math
import sys
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from slimconfig import load_layout

NANOAGENT = Path(__file__).resolve().parents[3]
sys.path[:0] = [
    str(NANOAGENT / "test" / "uploaded"),
    str(NANOAGENT / "test" / "acceptance" / "benchmark"),
    str(NANOAGENT / "examples" / "uploaded_benchmark"),
    str(NANOAGENT / "examples" / "benchmark"),
]

import step2_submit_run  # noqa: E402
import step3_trace  # noqa: E402
import support  # noqa: E402
from mockllm import MockProvider, load_scenario  # noqa: E402
from recovery_support import (  # noqa: E402
    db,
    Member,
    WorkerApi,
    alice,
    attempt_containers,
    host_url,
    join_workspace,
    new_workspace,
    read_stream,
    remove_attempt_leftovers,
    signal_worker,
    wait_until,
)
from rush_server import RushServer, rush_server, unavailable, worker_credential  # noqa: E402
from support import REFERENCE, Cli, Worker  # noqa: E402

from nanoagent.plugin.package import pack  # noqa: E402

pytestmark = pytest.mark.uploaded_acceptance

PROBE = NANOAGENT / "test" / "plugins" / "acceptance-probe"
SLOW_WRITER = Path(__file__).resolve().parent / "plugins" / "slow-writer"
RECOVERY_HARNESS = Path(__file__).resolve().parent / "harnesses" / "recovery"
RECOVERY_WORKER = Path(__file__).resolve().parent / "recovery_worker.py"
SOCKET = "/run/rush-gvisor/seccheck.sock"
LEASE_S = 20
DEADLINE_S = 40
RENEW_S = 5
# Runs no worker ever claims (a label nobody serves): hand-driven tests claim them themselves.
HAND_LABEL = "hand"
LOGS = support.FINAL / "recovery-access"


# -- servers and members ------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    """The server the workers in the worker container talk to: short leases and reconciliation deadline so faults resolve in seconds."""
    reason = unavailable()
    if reason:
        pytest.skip(reason)
    with pytest.MonkeyPatch.context() as env:
        env.setenv("BENCHMARK_LEASE_SECONDS", str(LEASE_S))
        env.setenv("BENCHMARK_UNCERTAIN_DEADLINE_SECONDS", str(DEADLINE_S))
        with rush_server(extra_users=("bob",)) as server:
            server.seed_plugin(pack(PROBE))
            server.seed_plugin(pack(SLOW_WRITER))
            server.advertise(HAND_LABEL, internet_access=False)
            yield server


@pytest.fixture(scope="module")
def bob(rush: RushServer) -> Member:
    """A second member of alice's workspace."""
    return join_workspace(rush, "bob", rush.workspace_id, ["acceptance-probe"])


@pytest.fixture(scope="module")
def capped() -> Iterator[RushServer]:
    """A server with small spend caps: a member may reserve 1.00 USD a day, a workspace 1.50."""
    reason = unavailable()
    if reason:
        pytest.skip(reason)
    with pytest.MonkeyPatch.context() as env:
        env.setenv("BENCHMARK_MEMBER_BUDGET_USD", "1.0")
        env.setenv("BENCHMARK_WORKSPACE_BUDGET_USD", "1.5")
        env.setenv("BENCHMARK_LEASE_SECONDS", "120")
        env.setenv("BENCHMARK_UNCERTAIN_DEADLINE_SECONDS", "3600")
        with rush_server(extra_users=("bob",)) as server:
            server.seed_plugin(pack(PROBE))
            server.advertise(HAND_LABEL, internet_access=False)
            yield server


@pytest.fixture(scope="module")
def run_dir() -> Path:
    path = support.SCRATCH / f"recovery-{uuid.uuid4().hex[:8]}"
    path.mkdir(parents=True)
    return path


@pytest.fixture(scope="module")
def logs(run_dir: Path) -> Path:
    return LOGS / run_dir.name


@pytest.fixture(scope="module")
def cli(rush: RushServer, logs: Path) -> Cli:
    return Cli(rush.base_url, rush.workspace_id, rush.token, logs, rush.user_id)


@pytest.fixture(scope="module")
def registry(run_dir: Path) -> Iterator[int]:
    with support.serve_directory(support.wheelhouse(support.FIXTURE / "requirements.txt", run_dir / "registry")) as port:
        yield port


@pytest.fixture(scope="module")
def core_source(run_dir: Path) -> Path:
    folder = run_dir / "core-source"
    support.build_source(folder)
    return folder


# -- CLI helpers --------------------------------------------------------------------------------------------------------


# The plugin each published benchmark is of, which step 2 names with the benchmark.
PLUGINS: dict[str, str] = {}


def publish(
    cli: Cli, run_dir: Path, suite: str, *, plugin: str = "acceptance-probe", token: str = "alpha", wait: float = 1.0, endpoint: str = "mock", limits: dict[str, Any] | None = None
) -> None:
    """Step 1: a one-case benchmark of ``plugin``'s probe task whose case carries ``token`` (the recovery harness reads its behavior
    from it); the plugin's task declares the tools. Only a worker advertising ``endpoint`` serves its runs, under ``limits``."""
    cases = {
        "_": "step2_single_run.Cases",
        "plugin": plugin,
        "task": "probe",
        "context": "A synthetic task: answer with the digest of the token.",
        "answer": [{"token": token, "wait_seconds": wait}],
        "refuse": [],
    }
    path = run_dir / f"cases-{suite}.json"
    path.write_text(json.dumps(cases))
    cli.step("1", "publish_benchmark", run_dir / f"step1-{suite}", *support.publish_args(name=suite, cases=path, endpoint=endpoint, limits=limits))
    PLUGINS[suite] = plugin


def submit(
    cli: Cli, run_dir: Path, name: str, source: Path, suite: str, key: str, *, follow: bool, check: bool = True, overrides: tuple[str, ...] = ()
) -> Any:
    """Step 2: submit ``source`` to benchmark ``suite`` under idempotency key ``key``; the run's report (None when the step failed)."""
    home = run_dir / f"step2-{name}"
    done = cli.step(
        "2", "submit_run", home, *support.submit_args(suite, plugin=PLUGINS[suite], key=key, source=source, follow=follow, follow_timeout=900), *overrides, check=check,
    )
    return load_layout(home, step2_submit_run.RunLayout).run if done.returncode == 0 else None


def act(cli: Cli, run_dir: Path, name: str, action: str, *overrides: str) -> Any:
    home = run_dir / f"act-{name}"
    cli.step("2", "submit_run", home, f"action={action}", "follow=false", *overrides)
    return load_layout(home, step2_submit_run.RunLayout).run


def trace(cli: Cli, run_dir: Path, name: str, attempt: str, *overrides: str) -> Any:
    home = run_dir / f"trace-{name}"
    cli.step("3", "trace", home, f"attempt_id={attempt}", *overrides)
    return load_layout(home, step3_trace.TraceLayout).trace


def start_worker(name: str, rush: RushServer, cli: Cli, run_dir: Path, *, upstream: str, index: int, entry: tuple[str, ...] = ("-m", "nanoagent.uploaded.worker")) -> Worker:
    """The real worker in the worker container with a short renewal interval."""
    if reason := support.container_unavailable():
        pytest.skip(reason)
    config = run_dir / f"{name}.yaml"
    worker = Worker(name, config, cli.logs / f"{name}-worker.log", credential=worker_credential(cli.base_url, cli.token), entry=entry)
    text = support.worker_yaml(
        base_url=host_url(rush),
        upstream=upstream.replace("127.0.0.1", support.HOST),
        index=f"http://{support.HOST}:{index}/simple",
        socket=SOCKET,
        scratch=f"{worker.home}/scratch",
    )
    assert "renew_interval_s: 15" in text
    config.write_text(text.replace("renew_interval_s: 15", f"renew_interval_s: {RENEW_S}"))
    worker.start()
    return worker


def attempt_of(run: Any) -> str:
    return run.attempts[0].attempt_id


def kinds(events: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [event for event in events if event["kind"] == kind]


def seal_of(rush: RushServer, attempt: str) -> tuple[str, str | None, bool, int | None]:
    row = db(rush, f"select state, execution_status, sealed, final_cursor from benchmark_attempt where attempt_id = '{attempt}'")
    state, status, sealed, final = row.split("|")
    return state, status or None, sealed == "t", int(final) if final else None


def wait_for_kind(cli: Cli, run_dir: Path, attempt: str, kind: str, name: str, *, timeout: float = 600, count: int = 1) -> Any:
    """Poll the saved trace (through the CLI) until it holds ``count`` events of ``kind``."""

    def check() -> Any:
        current = trace(cli, run_dir, name, attempt)
        assert not current.sealed or len(kinds(current.events, kind)) >= count, f"the attempt sealed without {count} {kind}"
        return current if len(kinds(current.events, kind)) >= count else None

    return wait_until(check, f"{count} {kind} in the trace of {attempt}", timeout, interval=1.0)


# -- duplicate submit (CLI) ---------------------------------------------------------------------------------------------


def test_a_retried_submit_with_the_same_idempotency_key_returns_the_same_run(rush: RushServer, cli: Cli, run_dir: Path) -> None:
    publish(cli, run_dir, "dup-suite", endpoint=HAND_LABEL)
    first = submit(cli, run_dir, "dup-first", RECOVERY_HARNESS, "dup-suite", "dup-key", follow=False)
    assert first.replayed is False and first.status == "queued"
    # The CLI retried after a lost answer: same key, same request (the first run's preview).
    second = submit(cli, run_dir, "dup-second", RECOVERY_HARNESS, "dup-suite", "dup-key", follow=False, overrides=(f"preview_id={first.preview_id}",))
    assert second.replayed is True and second.run_id == first.run_id and second.preview_id == first.preview_id
    assert [attempt.attempt_id for attempt in second.attempts] == [attempt.attempt_id for attempt in first.attempts]
    assert db(rush, "select count(*) from benchmark_run where idempotency_key = 'dup-key'") == "1"
    assert db(rush, f"select count(*) from benchmark_attempt where run_id = '{first.run_id}'") == "1"
    # The same key with another request is refused, and queues nothing.
    other = submit(cli, run_dir, "dup-conflict", RECOVERY_HARNESS, "dup-suite", "dup-key", follow=False, check=False, overrides=(f"preview_id={first.preview_id}", "policy=coding"))
    assert other is None
    assert "idempotency_conflict" in logs_text(cli, "step2-dup-conflict")
    assert db(rush, "select count(*) from benchmark_run where idempotency_key = 'dup-key'") == "1"


def logs_text(cli: Cli, name: str) -> str:
    return (cli.logs / f"{name}.log").read_text()


# -- spend cap races (hand-driven worker on the capped server) -----------------------------------------------------------


def race(api: WorkerApi, attempt: str, fence: int, calls: list[str], reserve: float) -> list[httpx.Response]:
    """Admit every call in ``calls`` at the same moment."""
    gate = threading.Barrier(len(calls))

    def go(call_id: str) -> httpx.Response:
        gate.wait()
        return api.admit(attempt, fence, call_id, reserve)

    with concurrent.futures.ThreadPoolExecutor(len(calls)) as pool:
        return list(pool.map(go, calls))


def committed(rush: RushServer, kind: str, scope_id: str) -> float:
    return float(db(rush, f"select coalesce(sum(committed_usd), 0) from benchmark_budget where scope_kind = '{kind}' and scope_id = '{scope_id}'"))


def reservations(rush: RushServer, attempt: str) -> list[str]:
    return db(rush, f"select call_id from benchmark_admission where attempt_id = '{attempt}' order by call_id").split()


def test_concurrent_admissions_never_exceed_the_attempt_member_or_workspace_cap(capped: RushServer, run_dir: Path, logs: Path) -> None:
    owner = alice(capped)
    bob = join_workspace(capped, "bob", capped.workspace_id, ["acceptance-probe"])
    owner_cli, bob_cli = Cli(capped.base_url, capped.workspace_id, owner.token, logs, owner.user_id), Cli(capped.base_url, capped.workspace_id, bob.token, logs, bob.user_id)
    # Each member's attempts are claimed, and then admitted against, only with that member's own worker credential.
    api, bob_api = WorkerApi(capped.base_url, capped.worker_token), WorkerApi(capped.base_url, worker_credential(capped.base_url, bob.token))
    capped.advertise(HAND_LABEL, internet_access=False, credential=bob_api.token)

    def queue(cli: Cli, name: str, cost: float, api: WorkerApi) -> tuple[str, int]:
        # The attempt's cap is its benchmark's: one benchmark per cost.
        publish(owner_cli, run_dir, f"cap-{name}", endpoint=HAND_LABEL, limits={"max_cost_usd": cost})
        submit(cli, run_dir, f"cap-{name}", RECOVERY_HARNESS, f"cap-{name}", f"cap-{name}", follow=False)
        job = api.claim(HAND_LABEL)
        assert job is not None and job["kind"] == "attempt"
        return job["attempt_id"], job["fence"]

    # Two callers racing for one call id: exactly one reservation, the other is a duplicate.
    attempt, fence = queue(bob_cli, "bob-attempt", 0.6, bob_api)
    twins = race(bob_api, attempt, fence, ["same-call"] * 6, 0.01)
    assert sorted(response.status_code for response in twins) == [201] + [409] * 5 and {r.json()["code"] for r in twins if r.status_code == 409} == {"duplicate_call"}
    assert reservations(capped, attempt) == ["same-call"]
    assert bob_api.settle(attempt, "same-call", "settled", 0.0).status_code == 200

    # The attempt's own cap: 0.60 holds two 0.25 reservations and no third.
    answers = race(bob_api, attempt, fence, [f"a-{n}" for n in range(8)], 0.25)
    assert sorted(response.status_code for response in answers) == [201, 201] + [402] * 6
    assert {r.json()["scope"] for r in answers if r.status_code == 402} == {"attempt"}
    assert len(reservations(capped, attempt)) == 3 and committed(capped, "member", bob.user_id) == pytest.approx(0.5)

    # The member's cap: 1.00 holds four 0.25 reservations.
    owner_attempt, owner_fence = queue(owner_cli, "alice-attempt", 1.5, api)
    answers = race(api, owner_attempt, owner_fence, [f"m-{n}" for n in range(8)], 0.25)
    assert sorted(response.status_code for response in answers) == [201] * 4 + [402] * 4
    assert {r.json()["scope"] for r in answers if r.status_code == 402} == {"member"}
    assert committed(capped, "member", owner.user_id) == pytest.approx(1.0)
    # Four calls made, none with a known cost: the settled total is unknown (null), never zero; what is held is still shown.
    totals = accounting(owner, owner_attempt)["totals"]
    assert totals["calls"] == 4 and totals["settled_usd"] is None and totals["reserved_usd"] == pytest.approx(1.0)

    # The workspace's cap: 1.50 is reserved (1.0 by alice, 0.5 by bob), so bob, with member room left, is refused by the workspace.
    second_attempt, second_fence = queue(bob_cli, "bob-second", 1.5, bob_api)
    answers = race(bob_api, second_attempt, second_fence, [f"w-{n}" for n in range(4)], 0.25)
    assert [response.status_code for response in answers] == [402] * 4 and {r.json()["scope"] for r in answers} == {"workspace"}
    assert reservations(capped, second_attempt) == []
    assert committed(capped, "workspace", capped.workspace_id) == pytest.approx(1.5)
    assert committed(capped, "member", bob.user_id) == pytest.approx(0.5)
    # Every reservation is one row; the books equal the rows.
    rows = float(db(capped, "select coalesce(sum(case when status = 'settled' then cost_usd else reserve_usd end), 0) from benchmark_admission"))
    assert rows == pytest.approx(1.5)


# -- a worker paused past its lease: reconnect, interruption, stale admission --------------------------------------------


@dataclass
class Lease:
    run: Any
    attempt: str
    first: list[dict[str, Any]]
    again: list[dict[str, Any]]
    last: list[dict[str, Any]]
    sealed: dict[str, Any] | None
    high_water: int
    interrupted: Any
    after_resume: Any
    stale: dict[str, httpx.Response]
    claim_after: dict[str, Any] | None
    rerun: Any
    calls_served: int
    leftovers: list[str]
    worker_log: str


@pytest.fixture(scope="module")
def lease(rush: RushServer, cli: Cli, run_dir: Path, core_source: Path, registry: int) -> Iterator[Lease]:
    """The core engine on a case whose tool runs 12 s; its worker is paused past the lease and resumed."""
    publish(cli, run_dir, "lease-suite")
    owner = alice(rush)
    api = WorkerApi(rush.base_url, rush.worker_token)
    with MockProvider() as provider:
        handle = provider.register(load_scenario(support.SCENARIOS / "core-engine-long-wait.yaml"), harness="nanoagent", model=support.MODEL, refs={"reference": REFERENCE})
        worker = start_worker("lease", rush, cli, run_dir, upstream=handle.base_url, index=registry)
        try:
            run = submit(cli, run_dir, "lease", core_source, "lease-suite", "lease-key", follow=False)
            attempt = attempt_of(run)
            wait_for_kind(cli, run_dir, attempt, "tool.invoked", "lease-wait")
            # A viewer reads the first events live, loses its connection, and comes back from its last cursor.
            first, _ = read_stream(owner, attempt, 0, stop_after=3)
            high_water = trace(cli, run_dir, "lease-high", attempt).high_water_cursor
            again, _ = read_stream(owner, attempt, first[-1]["cursor"], until_cursor=high_water)
            signal_worker(worker, "STOP")
            time.sleep(LEASE_S + 6)
            # The lease expired while the worker was frozen: a claim by anyone expires it, and nothing is claimable for the attempt.
            claim = api.claim("mock")
            last, sealed = read_stream(owner, attempt, again[-1]["cursor"], timeout=60)
            interrupted = trace(cli, run_dir, "lease-interrupted", attempt)
            signal_worker(worker, "CONT")
            wait_until(lambda: not attempt_containers(attempt), "the resumed worker to tear its sandbox down", 120, interval=2)
            time.sleep(RENEW_S + 2)
            stale = api.stale_calls(attempt, 1)
            after_resume = trace(cli, run_dir, "lease-after-resume", attempt)
            calls_served = len(handle.ledger.calls)
        finally:
            worker.stop()
            remove_attempt_leftovers(attempt if "attempt" in locals() else "none")
        # A rerun needs a new attempt, and leaves the interrupted one as it was.
        rerun = act(cli, run_dir, "lease-rerun", "rerun", f"run_id={run.run_id}", f"case_id={run.attempts[0].case_id}")
        act(cli, run_dir, "lease-cancel", "cancel", f"run_id={run.run_id}")
    yield Lease(
        run, attempt, first, again, last, sealed, high_water, interrupted, after_resume, stale, claim, rerun, calls_served, attempt_containers(attempt), worker.text()
    )


def test_a_trace_stream_reconnects_from_its_last_cursor_without_loss_or_duplicates(lease: Lease, cli: Cli, run_dir: Path) -> None:
    streamed = [*lease.first, *lease.again, *lease.last]
    cursors = [event["cursor"] for event in streamed]
    assert cursors == list(range(1, lease.high_water + 1)), cursors
    assert lease.first and lease.again and lease.first[-1]["cursor"] < lease.again[-1]["cursor"] == lease.high_water
    assert lease.sealed == {"final_cursor": lease.high_water}
    # What was streamed in pieces is exactly what the CLI reads back afterwards.
    saved = trace(cli, run_dir, "lease-saved", lease.attempt)
    assert saved.events == streamed
    resumed = trace(cli, run_dir, "lease-resumed", lease.attempt, f"after={lease.first[-1]['cursor']}")
    assert resumed.events == streamed[len(lease.first) :]


def test_an_expired_lease_interrupts_the_attempt_and_keeps_its_committed_evidence(lease: Lease, rush: RushServer) -> None:
    assert lease.claim_after is None  # the interrupted attempt is not leased again
    done = lease.interrupted
    assert done.sealed and done.final_cursor == lease.high_water == done.high_water_cursor
    assert done.attempt["execution"]["status"] == "interrupted" and done.attempt["verdict"] is None
    assert {"case.launched", "model_call.response", "tool.invoked"} <= {event["kind"] for event in done.events}
    assert not kinds(done.events, "tool.completed") and not kinds(done.events, "result.read")
    # Resuming the worker adds nothing: it learns the lease is gone, tears its sandbox down and finalizes nothing.
    assert lease.after_resume.events == done.events and lease.after_resume.final_cursor == done.final_cursor
    assert seal_of(rush, lease.attempt) == ("final", "interrupted", True, lease.high_water)
    assert not lease.leftovers, lease.leftovers
    assert lease.calls_served >= 1


def test_a_rerun_needs_a_new_attempt_and_leaves_the_interrupted_one_untouched(lease: Lease, rush: RushServer) -> None:
    [queued] = lease.rerun.queued_attempts
    assert queued != lease.attempt
    attempts = {attempt.attempt_id: attempt for attempt in lease.rerun.attempts}
    assert attempts[lease.attempt].execution_status == "interrupted" and attempts[lease.attempt].attempt_no == 1
    assert attempts[queued].attempt_no == 2
    assert seal_of(rush, lease.attempt) == ("final", "interrupted", True, lease.high_water)


def test_no_stale_admission_after_the_lease_changed(lease: Lease) -> None:
    """The old fence is refused on every fenced worker route (admissions, ingestion, payloads, spans, finalize, renewal, downloads)."""
    for route, response in lease.stale.items():
        assert response.status_code == 409 and response.json()["code"] == "lease_lost", (route, response.status_code, response.text)


# -- a worker killed after upstream acceptance and before the response was recorded ---------------------------------------


@dataclass
class Crash:
    attempt: str
    upstream_calls: int
    calls_at_kill: int
    admitted: list[dict[str, Any]]
    swept: Any
    trace: Any
    member_committed_before: float
    member_committed_after: float
    reissue_claim: dict[str, Any] | None
    reserve: float


@pytest.fixture(scope="module")
def crash(rush: RushServer, cli: Cli, run_dir: Path, registry: int) -> Iterator[Crash]:
    publish(cli, run_dir, "crash-suite", token="slow")
    api = WorkerApi(rush.base_url, rush.worker_token)
    owner = alice(rush)
    with MockProvider() as provider:
        handle = provider.register(load_scenario(support.SCENARIOS / "recovery-slow.yaml"), harness="nanoagent", model=support.MODEL)
        worker = start_worker("crash", rush, cli, run_dir, upstream=handle.base_url, index=registry)
        attempt = ""
        try:
            attempt = attempt_of(submit(cli, run_dir, "crash", RECOVERY_HARNESS, "crash-suite", "crash-key", follow=False))
            # Both requests reached the upstream; the second is unanswered (40 s) and nothing about it is recorded yet.
            wait_until(lambda: len(handle.ledger.calls) >= 2, "the upstream to accept the second request", 600, interval=0.5)
            wait_for_kind(cli, run_dir, attempt, "model_call.admitted", "crash-admitted", count=2)
            at_kill = trace(cli, run_dir, "crash-at-kill", attempt)
            accepted = len(handle.ledger.calls)
            signal_worker(worker, "KILL")
            worker.process.wait(timeout=60)  # type: ignore[union-attr]
            remove_attempt_leftovers(attempt)
            before = committed_of(rush, owner)
            # Lease expiry: a claim expires it. The unanswered call's reservation is still held, never settled by anyone.
            time.sleep(LEASE_S + 3)
            assert api.claim("mock") is None
            held = trace(cli, run_dir, "crash-held", attempt)
            assert seal_of(rush, attempt)[:3] == ("final", "interrupted", True)
            mid = accounting(owner, attempt)
            # The reconciliation deadline passes (it counts from admission): the next claim settles it at the reserved bound.
            time.sleep(DEADLINE_S + 3)
            reissue = api.claim("mock")
            swept = accounting(owner, attempt)
            after = committed_of(rush, owner)
        finally:
            worker.stop()
            remove_attempt_leftovers(attempt)
        reserve = float(second_bound(at_kill))
        yield Crash(attempt, len(handle.ledger.calls), accepted, kinds(at_kill.events, "model_call.admitted"), (mid, swept), held, before, after, reissue, reserve)


def second_bound(at_kill: Any) -> str:
    return kinds(at_kill.events, "model_call.admitted")[1]["data"]["bound_usd"]


def accounting(member: Member, attempt: str) -> dict[str, Any]:
    response = member.get(f"/attempts/{attempt}/accounting")
    assert response.status_code == 200, response.text
    return response.json()


def committed_of(rush: RushServer, member: Member) -> float:
    return committed(rush, "member", member.user_id)


def test_a_call_lost_after_upstream_acceptance_stays_reserved_and_is_never_reissued(crash: Crash) -> None:
    first, second = crash.admitted
    during, _ = crash.swept
    held = {call["call_id"]: call for call in during["calls"]}
    unanswered = held[second["data"]["call_id"]]
    assert unanswered["admission"]["status"] in ("reserved", "uncertain") and unanswered["admission"]["cost_usd"] is None
    assert unanswered["admission"]["reserve_usd"] == pytest.approx(crash.reserve)
    # The response was never recorded, and the worker never retried it: one admission, one upstream request, evidence ends there.
    assert not [event for event in kinds(crash.trace.events, "model_call.response") if event["data"]["call_id"] == second["data"]["call_id"]]
    assert [event["data"]["call_id"] for event in kinds(crash.trace.events, "model_call.admitted")] == [first["data"]["call_id"], second["data"]["call_id"]]
    assert crash.upstream_calls == crash.calls_at_kill == 2
    assert crash.reissue_claim is None  # the interrupted attempt is not leased again, so nothing reissues the call
    assert crash.trace.attempt["execution"]["status"] == "interrupted" and crash.trace.sealed


def test_an_uncertain_call_settles_at_its_reserved_bound_after_the_deadline(crash: Crash, rush: RushServer) -> None:
    during, after = crash.swept
    second = crash.admitted[1]["data"]["call_id"]
    held = next(call for call in during["calls"] if call["call_id"] == second)
    settled = next(call for call in after["calls"] if call["call_id"] == second)
    assert held["admission"]["status"] != "settled"
    assert settled["admission"]["status"] == "settled" and settled["admission"]["cost_usd"] == pytest.approx(crash.reserve)
    assert settled["admission"]["provenance"]["settled_by"] == "deadline_sweep"
    # The spend was held against the member's cap the whole time and is not dropped at settlement.
    assert crash.member_committed_before >= crash.reserve - 1e-9
    assert crash.member_committed_after >= crash.reserve - 1e-9
    assert after["totals"]["calls"] == 2 and after["totals"]["reserved_usd"] == 0
    assert db(rush, f"select count(*) from benchmark_admission where attempt_id = '{crash.attempt}'") == "2"


# -- cancel with a stream, a workspace-writing tool and a command in flight ----------------------------------------------


@dataclass
class Canceled:
    attempt: str
    before: Any
    final: Any
    reopened: Any
    ledger_before: int
    ledger_after: int
    containers: list[str]
    stale: dict[str, httpx.Response]
    accounting: dict[str, Any]
    worker_log: str
    run: Any


@pytest.fixture(scope="module")
def canceled(rush: RushServer, cli: Cli, run_dir: Path, registry: int) -> Iterator[Canceled]:
    publish(cli, run_dir, "cancel-suite", plugin="slow-writer", token="hold")
    api = WorkerApi(rush.base_url, rush.worker_token)
    with MockProvider() as provider:
        handle = provider.register(load_scenario(support.SCENARIOS / "recovery-hold.yaml"), harness="nanoagent", model=support.MODEL)
        worker = start_worker("cancel", rush, cli, run_dir, upstream=handle.base_url, index=registry)
        attempt = ""
        try:
            run = submit(cli, run_dir, "cancel", RECOVERY_HARNESS, "cancel-suite", "cancel-key", follow=False)
            attempt = attempt_of(run)
            wait_until(lambda: len(handle.ledger.calls) >= 2, "the model stream to start", 600)
            before = wait_for_kind(cli, run_dir, attempt, "tool.invoked", "cancel-before")
            before = wait_for_kind(cli, run_dir, attempt, "model_call.admitted", "cancel-before", count=2)
            ledger_before = len(handle.ledger.calls)
            act(cli, run_dir, "cancel", "cancel", f"run_id={run.run_id}")
            # Sealed and finalized: the seal lands with the last events, a moment before finalize records the execution.
            final = wait_until(
                lambda: (lambda t: t if t.sealed and t.attempt["execution"] is not None else None)(trace(cli, run_dir, "cancel-final", attempt)),
                "the canceled attempt to seal and finalize", 180, interval=1.0,
            )
            time.sleep(3)
            stale = api.stale_calls(attempt, 1)
            reopened = trace(cli, run_dir, "cancel-reopened", attempt)
            counted = len(handle.ledger.calls)
            containers = attempt_containers(attempt)
            owner_accounting = accounting(alice(rush), attempt)
        finally:
            worker.stop()
            remove_attempt_leftovers(attempt)
    yield Canceled(attempt, before, final, reopened, ledger_before, counted, containers, stale, owner_accounting, worker.text(), run)


def test_cancel_revokes_admission_aborts_the_stream_and_drains_the_tool(canceled: Canceled) -> None:
    final = canceled.final
    assert final.attempt["execution"]["status"] == "canceled" and final.attempt["verdict"] is None
    # The stream in flight was aborted by the revocation, and its reservation was kept or settled, never dropped.
    responses = {event["data"]["call_id"]: event["data"] for event in kinds(final.events, "model_call.response")}
    streams = [data for data in responses.values() if data["terminal"] != "completed"]
    assert len(streams) == 1 and streams[0]["terminal"] in ("revoked", "client_disconnected", "interrupted"), responses
    assert streams[0]["settlement"]["action"] in ("uncertain", "settled")
    # The workspace-writing tool was stopped, not left running: it completed as a revoked call (or never completed in time).
    [invoked] = kinds(final.events, "tool.invoked")
    completed = [event for event in kinds(final.events, "tool.completed") if event["data"]["call_id"] == invoked["data"]["call_id"]]
    assert invoked["data"]["writes"] is True
    assert all(event["data"]["ok"] is False and event["data"]["error"]["code"] == "revoked" for event in completed), completed
    # No model request after the cancel, and no sandbox left behind.
    assert canceled.ledger_after == canceled.ledger_before == 2
    assert canceled.containers == []


def test_nothing_is_committed_after_the_cancel_seal(canceled: Canceled) -> None:
    final = canceled.final
    assert final.sealed and final.final_cursor == final.high_water_cursor == len(final.events)
    assert [event["cursor"] for event in final.events] == list(range(1, len(final.events) + 1))
    assert canceled.reopened.events == final.events and canceled.reopened.final_cursor == final.final_cursor
    # No event follows the revocation point that is a model call, a tool call or a command.
    kinds_after_quiesce = [event["kind"] for event in final.events[[event["kind"] for event in final.events].index("case.quiesced") + 1 :]] if "case.quiesced" in [e["kind"] for e in final.events] else []
    assert not [kind for kind in kinds_after_quiesce if kind.startswith(("model_call.", "tool.", "exec."))], kinds_after_quiesce
    for route, response in canceled.stale.items():
        assert response.status_code == 409, (route, response.status_code, response.text)
    assert canceled.stale["events"].json()["code"] == "sealed" and canceled.stale["admit"].json()["code"] == "sealed"


def test_the_canceled_attempts_spend_is_preserved(canceled: Canceled) -> None:
    calls = canceled.accounting["calls"]
    assert len(calls) == 2 and canceled.accounting["totals"]["calls"] == 2
    assert all(call["admission"]["status"] in ("settled", "uncertain", "reserved") for call in calls)
    assert canceled.accounting["totals"]["reserved_usd"] + (canceled.accounting["totals"]["settled_usd"] or 0) > 0


# -- the harness exits with work in flight: nothing writes after the snapshot -------------------------------------------


@dataclass
class Drained:
    run: Any
    trace: Any
    worker_log: str
    ledger: int


@pytest.fixture(scope="module")
def drained(rush: RushServer, cli: Cli, run_dir: Path, registry: int) -> Iterator[Drained]:
    publish(cli, run_dir, "drain-suite", plugin="slow-writer", token="drain", wait=3)
    with MockProvider() as provider:
        handle = provider.register(load_scenario(support.SCENARIOS / "recovery-hold.yaml"), harness="nanoagent", model=support.MODEL)
        worker = start_worker("drain", rush, cli, run_dir, upstream=handle.base_url, index=registry, entry=(str(RECOVERY_WORKER),))
        try:
            run = submit(cli, run_dir, "drain", RECOVERY_HARNESS, "drain-suite", "drain-key", follow=True)
            done = trace(cli, run_dir, "drain", attempt_of(run))
        finally:
            worker.stop()
        yield Drained(run, done, worker.text(), len(handle.ledger.calls))


def test_no_workspace_write_follows_the_snapshot_and_no_event_follows_the_seal(drained: Drained) -> None:
    assert "SNAPSHOT_CHECK stable=True" in drained.worker_log, drained.worker_log[-3000:]
    written = int(drained.worker_log.split("progress_bytes=")[1].split()[0])
    assert written > 0, "the tool had not written before the snapshot, so nothing was in flight"
    done = drained.trace
    names = [event["kind"] for event in done.events]
    assert names.index("case.quiesced") < names.index("snapshot.taken")
    # The tool and the stream were stopped before the snapshot, and the harness's own exit is what ended the case.
    [completed] = kinds(done.events, "tool.completed")
    assert completed["data"]["ok"] is False and completed["data"]["error"]["code"] == "revoked"
    assert [event["data"]["terminal"] for event in kinds(done.events, "model_call.response")].count("completed") == 1
    assert done.sealed and done.final_cursor == len(done.events) and drained.run.attempts[0].execution_status == "refused"
    assert drained.ledger == 2


# -- concurrent model requests against a tight attempt budget (real gateway) ---------------------------------------------


@dataclass
class Raced:
    trace: Any
    upstream: int
    accounting: dict[str, Any]
    cap: float


RACE_CAP = 0.012


@pytest.fixture(scope="module")
def raced(rush: RushServer, cli: Cli, run_dir: Path, registry: int) -> Iterator[Raced]:
    publish(cli, run_dir, "race-suite", token="race:12", limits={"max_output_tokens_per_call": 1000, "max_cost_usd": RACE_CAP})
    with MockProvider() as provider:
        handle = provider.register(load_scenario(support.SCENARIOS / "recovery-race.yaml"), harness="nanoagent", model=support.MODEL)
        worker = start_worker("race", rush, cli, run_dir, upstream=handle.base_url, index=registry)
        try:
            run = submit(cli, run_dir, "race", RECOVERY_HARNESS, "race-suite", "race-key", follow=True)
            attempt = attempt_of(run)
            done = trace(cli, run_dir, "race", attempt)
            upstream = len(handle.ledger.calls)
        finally:
            worker.stop()
        yield Raced(done, upstream, accounting(alice(rush), attempt), RACE_CAP)


def test_concurrent_model_requests_reserve_once_each_and_never_exceed_the_cap(raced: Raced) -> None:
    admitted = kinds(raced.trace.events, "model_call.admitted")
    rejected = [event for event in kinds(raced.trace.events, "model_call.rejected") if event["data"]["code"] == "budget_exhausted"]
    bounds = {event["data"]["bound_usd"] for event in admitted}
    assert len(bounds) == 1
    bound = float(bounds.pop())
    # Exactly the requests the cap holds were admitted; the other physical requests were refused before dispatch.
    assert len(admitted) == math.floor(raced.cap / bound) >= 2
    assert len(admitted) + len(rejected) == 13
    assert all(event["data"]["http_status"] == 402 for event in rejected)
    # One reservation per admitted request (unique call ids), one upstream request each, never more than the cap.
    ids = [event["data"]["call_id"] for event in admitted]
    assert len(set(ids)) == len(ids)
    assert sorted(call["call_id"] for call in raced.accounting["calls"]) == sorted(ids)
    assert raced.upstream == len(admitted)
    held = raced.accounting["totals"]["reserved_usd"] + (raced.accounting["totals"]["settled_usd"] or 0)
    assert held <= raced.cap + 1e-9 and held == pytest.approx(len(admitted) * bound)


# -- access -------------------------------------------------------------------------------------------------------------


def leaves(value: Any) -> Iterator[str]:
    if isinstance(value, dict):
        for item in value.values():
            yield from leaves(item)
    elif isinstance(value, list):
        for item in value:
            yield from leaves(item)
    elif isinstance(value, str):
        yield value


def records_of(owner: Member, run_id: str, attempt: str) -> tuple[dict[str, bytes], list[str]]:
    """Every record the owner can read of the attempt, as bytes by name, and the payload digests among them."""
    paths = {
        "run": f"/runs/{run_id}",
        "attempt": f"/attempts/{attempt}",
        "events": f"/attempts/{attempt}/events",
        "spans": f"/attempts/{attempt}/spans",
        "accounting": f"/attempts/{attempt}/accounting",
    }
    found: dict[str, bytes] = {}
    for name, path in paths.items():
        response = owner.get(path)
        assert response.status_code == 200, (name, response.text)
        found[name] = response.content
    digests = sorted({d for event in json.loads(found["events"])["events"] for d in event["payload_sha256s"]})
    assert digests
    for digest in digests:
        response = owner.get(f"/attempts/{attempt}/payloads/{digest}")
        assert response.status_code == 200
        assert hashlib.sha256(response.content).hexdigest() == digest
        found[f"payload-{digest}"] = response.content
    return found, digests


def test_other_members_and_workspaces_reach_none_of_a_runs_records(rush: RushServer, bob: Member, lease: Lease, canceled: Canceled) -> None:
    owner = alice(rush)
    other_workspace = new_workspace(rush, owner, "elsewhere")
    strangers = {
        "another member of the workspace": bob,
        "the owner in another workspace": owner.elsewhere(other_workspace),
        "another member in no shared workspace": bob.elsewhere(other_workspace),
    }
    for run, attempt in ((lease.run, lease.attempt), (canceled.run, canceled.attempt)):
        own, digests = records_of(owner, run.run_id, attempt)
        sample = {run.run_id, attempt, *digests}
        # Record content to look for in what a stranger is told: event ids, call ids, the prompt and payload bodies.
        events = json.loads(own["events"])["events"]
        secrets = {attempt, events[0]["event_id"], json.loads(own["attempt"])["attempt"]["prompt"]["user"][:40], *(str(event["data"].get("call_id")) for event in events if event["data"].get("call_id"))}
        secrets |= {own[f"payload-{digests[0]}"][:30].decode(errors="ignore")}
        paths = [
            f"/runs/{run.run_id}",
            f"/attempts/{attempt}",
            f"/attempts/{attempt}/events",
            f"/attempts/{attempt}/events?after=0&limit=1",
            f"/attempts/{attempt}/stream",
            f"/attempts/{attempt}/spans",
            f"/attempts/{attempt}/spans?q=a",
            f"/attempts/{attempt}/accounting",
            *[f"/attempts/{attempt}/payloads/{digest}" for digest in digests],
        ]
        for label, stranger in strangers.items():
            for path in paths:
                response = stranger.get(path)
                assert response.status_code == 404, (label, path, response.status_code)
                text = response.text
                assert not any(secret and secret in text for secret in secrets | sample), (label, path, text)
            listed = stranger.get("/runs")
            assert listed.status_code in (200, 404)
            if listed.status_code == 200:
                assert run.run_id not in listed.text and listed.json()["runs"] == []
            for path in (f"/runs/{run.run_id}/cancel", f"/runs/{run.run_id}/cases/{run.attempts[0].case_id}/rerun"):
                assert stranger.post(path, {}).status_code == 404, (label, path)
        # The records themselves hold no private reference or verifier detail.
        for name, data in own.items():
            assert REFERENCE.encode() not in data and b"private" not in data.lower().replace(b"private reference", b""), name
        assert db(rush, f"select count(*) from benchmark_attempt where attempt_id = '{attempt}' and sealed") == "1"
    # The stranger's own listing is empty and the owner's holds the runs.
    assert bob.get("/runs").json()["runs"] == []
    assert {entry["run_id"] for entry in owner.get("/runs").json()["runs"]} >= {lease.run.run_id, canceled.run.run_id}


def test_the_cli_of_another_member_cannot_read_the_trace(rush: RushServer, bob: Member, lease: Lease, run_dir: Path, logs: Path) -> None:
    bob_cli = Cli(rush.base_url, rush.workspace_id, bob.token, logs, bob.user_id)
    done = bob_cli.step("3", "trace", run_dir / "trace-bob", f"attempt_id={lease.attempt}", check=False)
    assert done.returncode != 0
    assert "404" in done.stdout + done.stderr or "unknown_attempt" in done.stdout + done.stderr
    assert not (run_dir / "trace-bob" / "trace.json").exists()
