"""The worker API client, its admission and journal adapters, accounting reconciliation and the worker config."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
from nanoagent.uploaded.evidence import EvidenceEvent
from nanoagent.uploaded.gateway import AdmissionDenied
from nanoagent.uploaded.reconcile import PendingCall, pending_calls, reconcile
from nanoagent.uploaded.rush_worker import (
    BudgetExhausted,
    Canceled,
    ConflictingDuplicate,
    Lease,
    LeaseLost,
    RushAdmission,
    RushJournal,
    RushUnavailable,
    RushWorkerClient,
    Sealed,
)
from nanoagent.uploaded import sandbox as sandbox_module
from nanoagent.uploaded.sandbox import reap_leftovers
from nanoagent.uploaded.worker import Machine, machine_of
from slimconfig import load_config

MACHINE = Machine(cpus=8, memory_bytes=16 << 30)
DEPLOY = Path(__file__).resolve().parents[2] / "deploy" / "worker"


async def no_sleep(_: float) -> None:
    return None


def client_for(handler: Any, **kwargs: Any) -> RushWorkerClient:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://rush.test")
    return RushWorkerClient("http://rush.test", "tok", client=http, sleep=no_sleep, **kwargs)


def error(status: int, code: str, **extra: Any) -> httpx.Response:
    return httpx.Response(status, json={"error": code, "code": code, **extra})


@pytest.mark.parametrize(("status", "code", "cls"), [(409, "lease_lost", LeaseLost), (409, "canceled", Canceled), (409, "sealed", Sealed), (409, "conflicting_duplicate", ConflictingDuplicate)])
async def test_errors_are_typed_by_server_code(status: int, code: str, cls: type) -> None:
    client = client_for(lambda request: error(status, code))
    with pytest.raises(cls):
        await client.renew("a", 1)


async def test_claim_sends_the_profile_and_maps_204_to_none() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(204)

    capabilities = {"wall_time_ms": 1000, "memory_mb": 512, "internet_access": True}
    assert await client_for(handler).claim("w", "mock", "mock", capabilities, 20) is None
    assert json.loads(seen[0].content) == {"worker_id": "w", "endpoint_profile": {"label": "mock", "mode": "mock"}, "capabilities": capabilities, "wait_s": 20}
    assert seen[0].headers["authorization"] == "Bearer tok"


async def test_a_pending_case_is_read_with_the_fence_until_pinned_and_its_failure_raised() -> None:
    from nanoagent.uploaded.rush_worker import CaseFailed

    answers = [httpx.Response(204), httpx.Response(200, json={"case": {"case_id": "c1"}}), httpx.Response(422, json={"code": "case_failed", "error": "no input"})]
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answers.pop(0)

    client = client_for(handler)
    assert await client.case("a", 3) is None
    assert await client.case("a", 3) == {"case": {"case_id": "c1"}}
    with pytest.raises(CaseFailed) as failed:
        await client.case("a", 3)
    assert failed.value.message == "no input"
    assert [(r.url.path, r.headers["x-rush-fence"]) for r in seen] == [("/api/benchmark-worker/attempts/a/case", "3")] * 3


async def test_downloads_send_the_fence_and_check_the_declared_digest() -> None:
    import hashlib

    data = b"zip"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-rush-fence"] == "4"
        return httpx.Response(200, content=data, headers={"X-Rush-Sha256": hashlib.sha256(data).hexdigest() if "source" in request.url.path else "0" * 64})

    client = client_for(handler)
    assert await client.source("a", 4) == data
    with pytest.raises(Exception, match="digest"):
        await client.package("a", 4)


async def test_idempotent_calls_retry_over_5xx_then_give_up() -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(503)

    with pytest.raises(RushUnavailable):
        await client_for(handler, retries=2).renew("a", 1)
    assert len(calls) == 3


async def test_an_admission_retry_that_finds_its_own_duplicate_succeeds() -> None:
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        if len(attempts) == 1:
            raise httpx.ConnectError("reset")
        return error(409, "duplicate_call")

    await client_for(handler).admit("a", 1, "call-1", 0.4)
    assert len(attempts) == 2


async def test_a_first_duplicate_admission_is_an_error() -> None:
    from nanoagent.uploaded.rush_worker import DuplicateCall

    with pytest.raises(DuplicateCall):
        await client_for(lambda r: error(409, "duplicate_call")).admit("a", 1, "call-1", 0.4)


async def test_admission_maps_denials_and_marks_the_lease() -> None:
    lease = Lease("a", 1)
    admission = RushAdmission(client_for(lambda r: error(402, "budget_exhausted", scope="member")), lease)
    with pytest.raises(AdmissionDenied) as denied:
        await admission.reserve("c", Decimal("0.1"))
    assert denied.value.code == "budget_exhausted" and admission.denials == [("budget_exhausted", "member")] and lease.active
    lost = RushAdmission(client_for(lambda r: error(409, "lease_lost")), lease)
    with pytest.raises(AdmissionDenied) as gone:
        await lost.reserve("c", Decimal("0.1"))
    assert gone.value.code == "lease_lost" and lease.reason == "lease_lost"
    with pytest.raises(AdmissionDenied):  # no request is made once the lease is gone
        await RushAdmission(client_for(lambda r: pytest.fail("called")), lease).reserve("c", Decimal("0.1"))
    assert BudgetExhausted(402, "budget_exhausted", "x", {"scope": "calls"}).scope == "calls"


async def test_settle_sends_unknown_cost_as_uncertain() -> None:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={})

    admission = RushAdmission(client_for(handler), Lease("a", 1))
    await admission.settle("c1", None, "usage")
    await admission.settle("c2", Decimal("0.01"), "usage")
    await admission.mark_uncertain("c3")
    assert [(b["outcome"], b.get("cost_usd")) for b in bodies] == [("uncertain", None), ("settled", 0.01), ("uncertain", None)]


async def test_journal_commits_in_order_uploads_payloads_first_and_stops_after_lease_loss() -> None:
    log: list[tuple[str, Any]] = []
    lose = False

    def handler(request: httpx.Request) -> httpx.Response:
        if lose:
            return error(409, "lease_lost")
        if request.method == "PUT":
            log.append(("payload", request.url.path.rsplit("/", 1)[1]))
            return httpx.Response(200, json={})
        events = json.loads(request.content)["events"]
        log.extend(("event", event["event_id"]) for event in events)
        return httpx.Response(200, json={"receipts": [], "high_water_cursor": len([1 for kind, _ in log if kind == "event"])})

    lease = Lease("a", 1)
    journal = RushJournal(client_for(handler), lease)
    sha = await journal.put_payload(b"body", "clean")
    await journal.append(EvidenceEvent("gateway-000001", "gateway", "k", 1, 5, {"x": 1}, (sha,)))
    await journal.append(EvidenceEvent("gateway-000002", "gateway", "k", 2, 6, {}))
    assert log == [("payload", sha), ("event", "gateway-000001"), ("event", "gateway-000002")] and journal.high_water == 2
    lose = True
    await journal.append(EvidenceEvent("gateway-000003", "gateway", "k", 3, 7, {}))
    await journal.append(EvidenceEvent("gateway-000004", "gateway", "k", 4, 8, {}))
    assert lease.reason == "lease_lost" and journal.closed and journal.dropped == 2 and len(journal.records) == 2


async def test_reconcile_waits_for_the_generation_then_records_accounting_and_settles_the_unknown_cost() -> None:
    sent: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append((request.url.path, request.content.decode()))
        return httpx.Response(200, json={})

    class Lookup:
        def __init__(self) -> None:
            self.calls = 0

        async def lookup(self, generation_id: str) -> dict[str, Any] | None:
            self.calls += 1
            return None if self.calls < 3 else {"id": generation_id, "total_cost": 0.002}

    lookup = Lookup()
    count = await reconcile(client_for(handler), "a", [PendingCall("c1", "gen-1", False)], lookup, sleep=no_sleep)
    assert count == 1 and lookup.calls == 3
    assert sent[0][0].endswith("/accounting") and json.loads(sent[0][1])["version"] == 1
    assert sent[1][0].endswith("/admissions/c1/settle") and json.loads(sent[1][1])["cost_usd"] == 0.002

    class Never:
        async def lookup(self, generation_id: str) -> None:
            return None

    assert await reconcile(client_for(handler), "a", [PendingCall("c2", "gen-2", True)], Never(), delays_s=(0.0,), sleep=no_sleep) == 0


def test_pending_calls_keep_only_generation_ids() -> None:
    records = [
        {"kind": "model_call.response", "data": {"call_id": "a", "generation_id": "gen-1", "settlement": {"action": "settled", "cost_usd": "0.01"}}},
        {"kind": "model_call.response", "data": {"call_id": "b", "generation_id": "msg_x", "settlement": {"action": "settled"}}},
        {"kind": "model_call.response", "data": {"call_id": "c", "generation_id": "gen-3", "settlement": {"action": "uncertain"}}},
        {"kind": "other", "data": {}},
    ]
    assert pending_calls(records) == [PendingCall("a", "gen-1", True), PendingCall("c", "gen-3", False)]


@pytest.mark.parametrize("name", ["worker.mock.yaml", "worker.openrouter.yaml"])
def test_shipped_worker_configs_validate(name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from nanoagent.uploaded.worker import WorkerConfig, runner_config

    config = load_config(WorkerConfig, [str(DEPLOY / name), f"scratch={tmp_path / 'scratch'}"])
    settings = runner_config(config, {"OPENROUTER_API_KEY": "k"}, MACHINE)
    assert settings.endpoint.mode in ("mock", "openrouter") and settings.prices and settings.reference_tokens_per_second == 100


def test_the_openrouter_worker_advertises_internet_access_which_benchmarks_default_to(tmp_path: Path) -> None:
    from nanoagent.uploaded.worker import WorkerConfig, runner_config

    config = load_config(WorkerConfig, [str(DEPLOY / "worker.openrouter.yaml"), f"scratch={tmp_path}"])
    assert runner_config(config, {"OPENROUTER_API_KEY": "k"}, MACHINE).capabilities["internet_access"] is True


def test_worker_config_without_the_credential_fails_at_startup(tmp_path: Path) -> None:
    from nanoagent.uploaded.endpoint import EndpointConfigError
    from nanoagent.uploaded.worker import WorkerConfig, runner_config

    config = load_config(WorkerConfig, [str(DEPLOY / "worker.openrouter.yaml"), f"scratch={tmp_path}"])
    with pytest.raises(EndpointConfigError, match="credential_missing"):
        runner_config(config, {}, MACHINE)


def _config(tmp_path: Path, *overrides: str) -> Any:
    from nanoagent.uploaded.worker import WorkerConfig

    return load_config(WorkerConfig, [str(DEPLOY / "worker.openrouter.yaml"), f"scratch={tmp_path}", *overrides])


def test_capabilities_come_from_the_machine_and_concurrency_defaults_low(tmp_path: Path) -> None:
    from nanoagent.uploaded.worker import runner_config

    caps = runner_config(_config(tmp_path), {"OPENROUTER_API_KEY": "k"}, MACHINE).capabilities
    assert (caps["cpus"], caps["memory_mb"], caps["concurrency"]) == (8, 16384, 1)


def test_configured_maxima_only_lower_what_the_machine_has(tmp_path: Path) -> None:
    from nanoagent.uploaded.worker import runner_config

    env = {"OPENROUTER_API_KEY": "k"}
    lowered = runner_config(_config(tmp_path, "limits.max_cpus=2", "limits.max_memory_mb=4096", "limits.concurrency=3"), env, MACHINE).capabilities
    assert (lowered["cpus"], lowered["memory_mb"], lowered["concurrency"]) == (2, 4096, 3)
    raised = runner_config(_config(tmp_path, "limits.max_cpus=64", "limits.max_memory_mb=999999", "limits.concurrency=64"), env, MACHINE).capabilities
    assert (raised["cpus"], raised["memory_mb"], raised["concurrency"]) == (8, 16384, 8)
    small = runner_config(_config(tmp_path), env, Machine(cpus=2, memory_bytes=2 << 30)).capabilities
    assert small["build_memory_mb"] == 2048


def test_machine_is_this_computers_cpus_and_physical_memory() -> None:
    import os

    machine = machine_of()
    assert machine.cpus == os.cpu_count() and machine.memory_bytes == os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")


async def test_a_host_whose_plugin_sandbox_fails_stops_the_worker_before_it_claims(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from nanoagent.uploaded import worker

    refused = "the bwrap sandbox does not confine plugins on this machine: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"

    def refuse(_root: Path) -> None:
        raise RuntimeError(refused)

    monkeypatch.setattr(worker, "isolate", lambda: None)
    monkeypatch.setattr(worker.sandbox, "check", refuse)
    monkeypatch.setattr(worker, "MicrosandboxSupervisor", lambda **_: pytest.fail("a sandbox was started"))
    monkeypatch.setattr(worker, "RushWorkerClient", lambda *_: pytest.fail("RUSH was contacted"))
    with pytest.raises(RuntimeError) as raised:
        await worker.serve(_config(tmp_path), {"RUSH_WORKER_TOKEN": "t", "OPENROUTER_API_KEY": "k"})
    assert str(raised.value) == refused


async def test_reaping_removes_only_sandboxes_whose_names_start_with_rush_dash(monkeypatch: pytest.MonkeyPatch) -> None:
    killed: list[str] = []
    removed: list[str] = []

    class Handle:
        def __init__(self, name: str) -> None:
            self.name = name

        async def kill(self) -> None:
            killed.append(self.name)

    class Page:
        sandboxes = [Handle("rush-case-1"), Handle("not-rush-case"), Handle("myrush-x"), Handle("rush-tool-a")]

    class FakeSandbox:
        @staticmethod
        async def list() -> Page:
            return Page()

        @staticmethod
        async def remove(name: str) -> None:
            removed.append(name)

    monkeypatch.setattr(sandbox_module, "Sandbox", FakeSandbox)
    assert await reap_leftovers() == ["rush-case-1", "rush-tool-a"]
    assert killed == removed == ["rush-case-1", "rush-tool-a"]


def test_the_worker_has_no_other_key_path(tmp_path: Path) -> None:
    from nanoagent.uploaded.endpoint import EndpointConfigError
    from nanoagent.uploaded.worker import runner_config

    with pytest.raises(EndpointConfigError, match="OPENROUTER_API_KEY"):
        runner_config(_config(tmp_path), {"RUSH_BENCHMARK_MOCK_API_KEY": "k"}, MACHINE)
    assert runner_config(_config(tmp_path), {"OPENROUTER_API_KEY": "k"}, MACHINE).endpoint.api_key == "k"


async def test_losing_rush_is_waited_out_with_one_outage_log_and_one_recovery_log(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    import anyio
    from nanoagent.uploaded import worker as worker_module
    from nanoagent.uploaded.worker import runner_config

    settings = runner_config(_config(tmp_path, "poll.idle_s=1", "poll.max_outage_s=4"), {"OPENROUTER_API_KEY": "k"}, MACHINE)
    sleeps: list[float] = []

    class Stop(Exception):
        pass

    class Rush:
        calls = 0

        async def claim(self, *_: Any) -> None:
            self.calls += 1
            if self.calls <= 5:
                raise RushUnavailable("down")
            if self.calls == 6:
                return None
            raise Stop

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    real_sleep = anyio.sleep
    worker_module.anyio.sleep = sleep  # type: ignore[assignment]
    try:
        with caplog.at_level("INFO", logger=worker_module.LOG.name), pytest.raises(BaseExceptionGroup):
            async with anyio.create_task_group() as group:
                await worker_module.poll(_config(tmp_path, "poll.idle_s=1", "poll.max_outage_s=4"), settings, Rush(), None, None, group)  # type: ignore[arg-type]
    finally:
        worker_module.anyio.sleep = real_sleep
    assert sleeps[:5] == [1, 2, 4, 4, 4]  # capped exponential
    assert [r.getMessage() for r in caplog.records if "RUSH" in r.getMessage()] == [
        "RUSH is unreachable, retrying until it returns: down", "RUSH is reachable again", f"claiming from RUSH: {settings.endpoint.label}",
    ]  # the claiming line follows the recovery once, and is not repeated by the claims after it


def test_a_lease_that_ran_out_while_the_computer_slept_is_lost_on_waking() -> None:
    mono = [0]
    wall = [0]
    lease = Lease("a", 1, lease_s=60, clock_ns=lambda: mono[0], wall_clock_ns=lambda: wall[0])
    wall[0] = 3600 * 10**9  # the monotonic clock stood still while asleep; the wall clock did not
    assert lease.lapsed() and lease.reason == "lease_lost"


def test_a_renewal_keeps_the_wall_clock_expiry_in_step() -> None:
    mono = [0]
    wall = [0]
    lease = Lease("a", 1, lease_s=60, clock_ns=lambda: mono[0], wall_clock_ns=lambda: wall[0])
    mono[0] = wall[0] = 50 * 10**9
    lease.extend(60, 50 * 10**9)
    mono[0] = wall[0] = 100 * 10**9
    assert not lease.lapsed()


async def test_claiming_from_rush_is_logged_once_at_startup_not_per_poll(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    import anyio
    from nanoagent.uploaded import worker as worker_module
    from nanoagent.uploaded.worker import runner_config

    settings = runner_config(_config(tmp_path, "poll.idle_s=1"), {"OPENROUTER_API_KEY": "k"}, MACHINE)

    class Stop(Exception):
        pass

    class Rush:
        calls = 0

        async def claim(self, *_: Any) -> None:
            self.calls += 1
            if self.calls <= 3:
                return None  # 204 each time
            raise Stop

    async def sleep(_: float) -> None:
        return None

    real_sleep = anyio.sleep
    worker_module.anyio.sleep = sleep  # type: ignore[assignment]
    try:
        with caplog.at_level("INFO", logger=worker_module.LOG.name), pytest.raises(BaseExceptionGroup):
            async with anyio.create_task_group() as group:
                await worker_module.poll(_config(tmp_path, "poll.idle_s=1"), settings, Rush(), None, None, group)  # type: ignore[arg-type]
    finally:
        worker_module.anyio.sleep = real_sleep
    assert [r.getMessage() for r in caplog.records if "RUSH" in r.getMessage()] == [f"claiming from RUSH: {settings.endpoint.label}"]


async def test_a_record_whose_data_is_over_the_event_limit_is_committed_as_a_stub_with_the_data_as_a_payload() -> None:
    from nanoagent.uploaded import records as rec
    from nanoagent.uploaded.rush_worker import MAX_EVENT_DATA_BYTES, Emitter

    sent: list[dict[str, Any]] = []
    payloads: dict[str, bytes] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT":
            payloads[request.url.path.rsplit("/", 1)[1]] = request.content
            return httpx.Response(200, json={})
        sent.extend(json.loads(request.content)["events"])
        return httpx.Response(200, json={"receipts": [], "high_water_cursor": len(sent)})

    journal = RushJournal(client_for(handler), Lease("a", 1))
    argv = ["A" * 4096] * 128  # a valid harness.yaml run.argv
    await Emitter(journal, lambda: 1).emit(rec.CaseLaunched("c1", 5, argv))
    [event] = sent
    assert len(json.dumps(event["data"])) < MAX_EVENT_DATA_BYTES and event["data"]["container_id"] == "c1" and event["data"]["data_truncated"]
    sha = event["data"]["data_payload_sha256"]
    assert sha in event["payload_sha256s"] and json.loads(payloads[sha])["argv"] == argv


async def test_events_past_the_budget_are_dropped_and_counted_but_the_worker_records_still_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    from nanoagent.uploaded import records as rec
    from nanoagent.uploaded.rush_worker import Emitter

    monkeypatch.setattr("nanoagent.uploaded.rush_worker.EVENT_BUDGET", 3)
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.extend(json.loads(request.content)["events"])
        return httpx.Response(200, json={"receipts": [], "high_water_cursor": len(sent)})

    journal = RushJournal(client_for(handler), Lease("a", 1))
    for sequence in range(1, 6):
        await journal.append(EvidenceEvent(f"harness-{sequence:06d}", "harness", "k", sequence, sequence, {}))
    # The gateway's records of an admitted (paid) call always get through; a refused call is the harness's to multiply.
    await journal.append(EvidenceEvent("gateway-000001", "gateway", "model_call.response", 6, 6, {"call_id": "c"}))
    await journal.append(EvidenceEvent("gateway-000002", "gateway", "model_call.rejected", 7, 7, {}))
    await Emitter(journal, lambda: 1).emit(rec.CaseQuiesced(9))
    assert [event["event_id"] for event in sent] == ["harness-000001", "harness-000002", "harness-000003", "gateway-000001", "worker-000001"]
    assert journal.over_budget == 3 and not journal.closed


@pytest.mark.parametrize("payload_limit", [16 << 20, 100])
async def test_a_large_response_keeps_the_identifiers_needed_to_reconcile_failed_settlement(monkeypatch: pytest.MonkeyPatch, payload_limit: int) -> None:
    import runner_fakes as fx
    monkeypatch.setattr("nanoagent.uploaded.rush_worker.MAX_PAYLOAD_BYTES", payload_limit)
    journal = RushJournal(fx.StrictRush(), Lease("a", 1))
    # Match the gateway response's field order: generation_id follows the first sixteen fields.
    data = {f"field_{i}": None for i in range(16)}
    data.update(call_id="c", generation_id="gen-1", settlement={"action": "settled", "cost_usd": "0.01"}, proposals=[{"arguments": "x" * 220_000}])
    await journal.append(EvidenceEvent("gateway-000001", "gateway", "model_call.response", 1, 1, data))
    await journal.append(EvidenceEvent("gateway-000002", "gateway", "model_call.settlement_failed", 2, 2, {"call_id": "c"}))
    assert pending_calls(journal.records) == [PendingCall("c", "gen-1", settled=False)]
    response = journal.records[0]["data"]
    assert response["data_truncated"] and response["generation_id"] == "gen-1"
    assert journal.redactions[response["data_payload_sha256"]] == ("none" if payload_limit > 100 else "truncated")


def test_pulled_image_bytes_are_logged_at_most_once_per_interval_in_the_form_rush_lab_reads(caplog: pytest.LogCaptureFixture) -> None:
    from nanoagent.uploaded.worker import pull_progress

    report = pull_progress(interval_s=3600)
    with caplog.at_level("INFO"):
        report(0, 20_000_000)
        report(5_000_000, 20_000_000)
    assert [record.getMessage() for record in caplog.records] == ["pulling images: 0 of 20000000 bytes"]  # helpinghands/src/runner/worker.mjs PULLING
