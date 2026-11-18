"""The lease's local fence: once its known expiry passes without a successful renewal, the gateway, the tool broker, the
command service and the event intake refuse new work, with the server's fencing still in place behind them. Every test
drives an injected monotonic clock."""

from __future__ import annotations

from pathlib import Path

import pytest
import runner_fakes as fx
import service_fakes as sf
from nanoagent.uploaded.gateway import AdmissionDenied
from nanoagent.uploaded.rush_worker import Lease, LeaseLost, RushAdmission

NS = 1_000_000_000


class Clock:
    def __init__(self) -> None:
        self.now = 1_000 * NS

    def __call__(self) -> int:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += round(seconds * NS)


def test_a_lease_is_usable_until_its_known_expiry_and_then_lost() -> None:
    clock = Clock()
    lease = Lease("a", 1, lease_s=60, clock_ns=clock)
    assert not lease.lapsed()
    clock.advance(59.9)
    assert not lease.lapsed() and lease.active
    clock.advance(0.2)
    assert lease.lapsed() and lease.reason == "lease_lost" and lease.revoked.is_set()


def test_a_renewal_extends_the_lease_from_when_it_was_requested() -> None:
    clock = Clock()
    lease = Lease("a", 1, lease_s=60, clock_ns=clock)
    clock.advance(50)
    requested = clock()
    clock.advance(5)  # the renewal took five seconds to answer: the server counted from the request
    lease.extend(60, requested)
    clock.advance(54)
    assert not lease.lapsed()
    clock.advance(2)
    assert lease.lapsed()


def test_a_lost_lease_is_not_revived_by_a_late_renewal() -> None:
    clock = Clock()
    lease = Lease("a", 1, lease_s=60, clock_ns=clock)
    clock.advance(61)
    assert lease.lapsed()
    lease.extend(60, clock())
    assert lease.lapsed() and lease.reason == "lease_lost"


def test_an_earlier_renewal_never_shortens_the_lease() -> None:
    clock = Clock()
    lease = Lease("a", 1, lease_s=60, clock_ns=clock)
    clock.advance(30)
    lease.extend(60, clock())
    lease.extend(10, clock())
    clock.advance(59)
    assert not lease.lapsed()


def test_a_lease_without_a_known_expiry_is_only_failed_by_the_server() -> None:
    lease = Lease("a", 1)
    assert not lease.lapsed()
    lease.fail(LeaseLost(409, "lease_lost", "gone"))
    assert lease.lapsed()


async def test_admission_is_refused_once_the_lease_lapsed_without_asking_the_server() -> None:
    clock = Clock()
    lease = Lease("a", 1, lease_s=60, clock_ns=clock)
    rush = fx.FakeRush()
    admission = RushAdmission(rush, lease)  # type: ignore[arg-type]
    await admission.reserve("call-1", sf.Decimal("0.01"))
    clock.advance(61)
    with pytest.raises(AdmissionDenied) as denied:
        await admission.reserve("call-2", sf.Decimal("0.01"))
    assert denied.value.code == "lease_lost" and list(rush.admissions) == ["call-1"]


ENDPOINTS = ("model", "tools", "exec", "events")


async def hit(client, endpoint: str):
    match endpoint:
        case "model":
            return await client.post(sf.PATHS["chat_completions"], json=sf.chat_request())
        case "tools":
            return await client.post("/tools", json={"name": "read", "arguments": {"n": 1}})
        case "exec":
            return await client.post("/exec", json={"argv": ["true"], "cwd": ".", "timeout_ms": 1000})
        case "events":
            event = {"protocol": "rush.harness.v1", "event": "span.start", "emitter_id": "e1", "sequence": 1, "span_id": "root", "kind": "agent", "name": "root"}
            return await client.post("/events", json=event)
    raise AssertionError(endpoint)


@pytest.mark.parametrize("endpoint", ENDPOINTS)
async def test_every_service_accepts_work_while_the_lease_is_valid(tmp_path: Path, endpoint: str) -> None:
    clock = Clock()
    lease = Lease("a", 1, lease_s=60, clock_ns=clock)
    rig = sf.make_rig(tmp_path, sf.ScriptedTransport(sf.chat_ok()), lease_lapsed=lease.lapsed)
    clock.advance(59)
    async with rig.client() as client:
        response = await hit(client, endpoint)
    assert response.status_code != 403, response.text


@pytest.mark.parametrize("endpoint", ENDPOINTS)
async def test_every_service_refuses_new_work_once_the_lease_lapsed(tmp_path: Path, endpoint: str) -> None:
    clock = Clock()
    lease = Lease("a", 1, lease_s=60, clock_ns=clock)
    rig = sf.make_rig(tmp_path, sf.ScriptedTransport(sf.chat_ok()), lease_lapsed=lease.lapsed)
    clock.advance(61)
    async with rig.client() as client:
        response = await hit(client, endpoint)
    assert response.status_code == 403 and response.json()["error"]["code"] == "lease_lost", response.text
    assert rig.commands.calls == [] and rig.tools.calls == [] and rig.transport.requests == []
    assert lease.reason == "lease_lost", "the fence also fails the lease, so the runner tears the attempt down"


async def test_a_renewed_lease_keeps_every_service_open(tmp_path: Path) -> None:
    clock = Clock()
    lease = Lease("a", 1, lease_s=60, clock_ns=clock)
    rig = sf.make_rig(tmp_path, sf.ScriptedTransport(sf.chat_ok()), lease_lapsed=lease.lapsed)
    clock.advance(50)
    lease.extend(60, clock())
    clock.advance(50)  # 100 s after the claim: past the first expiry, inside the renewed one
    async with rig.client() as client:
        assert (await hit(client, "exec")).status_code == 200
