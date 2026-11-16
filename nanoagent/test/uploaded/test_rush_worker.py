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
from slimconfig import load_config

DEPLOY = Path(__file__).resolve().parents[2] / "deploy" / "gvisor"


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
    assert await client_for(handler).claim("w", "mock", "mock", capabilities) is None
    assert json.loads(seen[0].content) == {"worker_id": "w", "endpoint_profile": {"label": "mock", "mode": "mock"}, "capabilities": capabilities}
    assert seen[0].headers["authorization"] == "Bearer tok"


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
    settings = runner_config(config, {"RUSH_BENCHMARK_MOCK_API_KEY": "k", "OPENROUTER_API_KEY": "k"})
    assert settings.endpoint.mode in ("mock", "openrouter") and settings.prices and settings.reference_tokens_per_second == 100


def test_worker_config_without_the_credential_fails_at_startup(tmp_path: Path) -> None:
    from nanoagent.uploaded.endpoint import EndpointConfigError
    from nanoagent.uploaded.worker import WorkerConfig, runner_config

    config = load_config(WorkerConfig, [str(DEPLOY / "worker.openrouter.yaml"), f"scratch={tmp_path}"])
    with pytest.raises(EndpointConfigError, match="credential_missing"):
        runner_config(config, {})
