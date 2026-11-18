"""Background accounting: for each physical call with an OpenRouter `gen-…` ID, look the generation up (it 404s for
about 20 s after completion, so retry with bounded backoff), store it as a new accounting version, and settle a
reservation that was kept because the response's cost was unknown. Never runs for historical reads."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import anyio
import httpx

from nanoagent.uploaded.endpoint import EndpointProfile
from nanoagent.uploaded.rush_worker import RushError, RushUnavailable, RushWorkerClient

LOG = logging.getLogger(__name__)
GENERATION_PREFIX = "gen-"
DEFAULT_DELAYS_S = (2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 60.0, 60.0)


@dataclass(frozen=True)
class PendingCall:
    call_id: str
    generation_id: str
    settled: bool  # False: the reservation is still held and a known cost settles it


class GenerationLookup(Protocol):
    async def lookup(self, generation_id: str) -> Mapping[str, Any] | None:
        """The generation record, or None while it is not yet available (404)."""


class HttpxGenerationLookup:
    def __init__(self, endpoint: EndpointProfile, client: httpx.AsyncClient | None = None) -> None:
        self._endpoint = endpoint
        self._client = client or httpx.AsyncClient(timeout=30, follow_redirects=False)

    async def lookup(self, generation_id: str) -> Mapping[str, Any] | None:
        response = await self._client.get(
            self._endpoint.url_for("/generation"), params={"id": generation_id}, headers={"Authorization": f"Bearer {self._endpoint.api_key}"}
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()["data"]

    async def aclose(self) -> None:
        await self._client.aclose()


def pending_calls(records: Sequence[Mapping[str, Any]]) -> list[PendingCall]:
    """The calls whose committed `model_call.response` carries a generation ID."""
    # The response says what settlement was meant; `model_call.settlement_failed` says it never reached RUSH.
    failed = {record["data"]["call_id"] for record in records if record["kind"] == "model_call.settlement_failed"}
    calls = []
    for record in records:
        data = record["data"]
        if record["kind"] == "model_call.response" and str(data.get("generation_id") or "").startswith(GENERATION_PREFIX):
            settlement = data.get("settlement") or {}
            # A "settled" response without a cost was kept uncertain by admission: only a known cost settles a reservation.
            settled = settlement.get("action") == "settled" and settlement.get("cost_usd") is not None and data["call_id"] not in failed
            calls.append(PendingCall(data["call_id"], data["generation_id"], settled))
    return calls


async def _generation(lookup: GenerationLookup, generation_id: str, delays_s: Sequence[float], sleep: Callable[[float], Awaitable[None]]) -> Mapping[str, Any] | None:
    for delay in (0.0, *delays_s):
        if delay:
            await sleep(delay)
        try:
            data = await lookup.lookup(generation_id)
        except (httpx.HTTPError, KeyError, ValueError) as error:
            LOG.warning("generation lookup of %s failed: %r", generation_id, error)
            continue
        if data is not None:
            return data
    return None


async def reconcile(
    client: RushWorkerClient,
    attempt_id: str,
    calls: Sequence[PendingCall],
    lookup: GenerationLookup,
    *,
    delays_s: Sequence[float] = DEFAULT_DELAYS_S,
    sleep: Callable[[float], Awaitable[None]] = anyio.sleep,
) -> int:
    """Reconcile every call; returns how many were recorded. A call whose generation never appears stays as it was."""
    recorded = 0
    for call in calls:
        data = await _generation(lookup, call.generation_id, delays_s, sleep)
        if data is None:
            LOG.warning("generation %s of call %s was not available; its accounting stays provisional", call.generation_id, call.call_id)
            continue
        cost = data.get("total_cost")
        record = {"generation_id": call.generation_id, "provenance": "openrouter_generation", "cost_usd": cost, "generation": dict(data)}
        try:
            await client.accounting(attempt_id, call.call_id, 1, record)
            if not call.settled and isinstance(cost, (int, float)):
                await client.settle(attempt_id, call.call_id, "settled", float(cost), {"source": "generation_lookup", "generation_id": call.generation_id})
        except (RushError, RushUnavailable) as error:
            LOG.warning("accounting of call %s was refused: %r", call.call_id, error)
            continue
        recorded += 1
    return recorded
