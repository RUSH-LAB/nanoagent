"""Background generation reconciliation: bounded retries over a lookup that 404s at first, new accounting versions, and
settlement of reservations that were kept because the response's cost was unknown."""

from __future__ import annotations

from typing import Any

import httpx
import runner_fakes as fx
from nanoagent.uploaded.reconcile import PendingCall, reconcile

DATA = {"id": "gen-1", "total_cost": 0.0123, "native_tokens_prompt": 410, "native_tokens_completion": 61}


class Lookup:
    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.asked: list[str] = []

    async def lookup(self, generation_id: str) -> Any:
        self.asked.append(generation_id)
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


async def run(calls: list[PendingCall], lookup: Lookup, rush: fx.FakeRush, delays: tuple[float, ...] = (1, 2, 4)) -> tuple[int, list[float]]:
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)

    recorded = await reconcile(rush, "a", calls, lookup, delays_s=delays, sleep=sleep)  # type: ignore[arg-type]
    return recorded, slept


async def test_a_generation_that_404s_is_retried_then_recorded_as_version_one_and_settles_an_uncertain_call() -> None:
    rush, lookup = fx.FakeRush(), Lookup(None, None, DATA)
    recorded, slept = await run([PendingCall("c1", "gen-1", settled=False)], lookup, rush)
    assert recorded == 1 and slept == [1, 2] and len(lookup.asked) == 3
    [(call, version, record)] = rush.accounting_calls
    assert (call, version, record["provenance"], record["cost_usd"]) == ("c1", 1, "openrouter_generation", 0.0123)
    assert rush.settles == [("c1", "settled", 0.0123, {"source": "generation_lookup", "generation_id": "gen-1"})]


async def test_an_already_settled_call_gets_accounting_without_a_second_settlement() -> None:
    rush = fx.FakeRush()
    assert (await run([PendingCall("c1", "gen-1", settled=True)], Lookup(DATA), rush))[0] == 1
    assert len(rush.accounting_calls) == 1 and rush.settles == []


async def test_a_generation_that_never_appears_is_given_up_after_bounded_retries_and_stays_provisional() -> None:
    rush, lookup = fx.FakeRush(), Lookup(None)
    recorded, slept = await run([PendingCall("c1", "gen-1", settled=False)], lookup, rush, delays=(1, 2, 4))
    assert recorded == 0 and slept == [1, 2, 4] and len(lookup.asked) == 4
    assert rush.accounting_calls == [] and rush.settles == []


async def test_lookup_errors_count_as_attempts_and_do_not_stop_the_other_calls() -> None:
    rush = fx.FakeRush()
    lookup = Lookup(httpx.ConnectError("down"), DATA)
    recorded, _ = await run([PendingCall("c1", "gen-1", settled=True), PendingCall("c2", "gen-2", settled=True)], lookup, rush)
    assert recorded == 2 and [call for call, _, _ in rush.accounting_calls] == ["c1", "c2"]


def test_a_response_settled_without_a_cost_is_still_a_reservation_the_lookup_settles() -> None:
    from nanoagent.uploaded.reconcile import pending_calls

    def response(settlement: dict[str, Any]) -> dict[str, Any]:
        return {"kind": "model_call.response", "data": {"call_id": "c", "generation_id": "gen-1", "settlement": settlement}}

    assert pending_calls([response({"action": "settled", "cost_usd": None})])[0].settled is False
    assert pending_calls([response({"action": "uncertain", "cost_usd": None})])[0].settled is False
    assert pending_calls([response({"action": "settled", "cost_usd": "0.01"})])[0].settled is True


def test_a_response_whose_settlement_failed_is_still_a_reservation_the_lookup_settles() -> None:
    from nanoagent.uploaded.reconcile import pending_calls

    settlement = {"action": "settled", "cost_usd": "0.01"}
    records = [
        {"kind": "model_call.response", "data": {"call_id": "c", "generation_id": "gen-1", "settlement": settlement}},
        {"kind": "model_call.settlement_failed", "data": {"call_id": "c", "settlement": settlement, "error": "RushUnavailable"}},
    ]
    assert pending_calls(records)[0].settled is False
