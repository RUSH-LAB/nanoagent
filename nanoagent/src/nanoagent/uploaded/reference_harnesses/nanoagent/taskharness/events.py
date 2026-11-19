"""The harness's spans and the request headers that tie gateway and broker calls to them."""

from __future__ import annotations

import asyncio
import contextvars
import itertools
import time
from typing import Any

import httpx

PROTOCOL = "rush.harness.v1"
SPAN_HEADER = "x-rush-span-id"
CALL_HEADER = "X-Rush-Call-Id"
EMITTER = "nanoagent"
# The span a request made in this context belongs to: model calls and broker calls read it for SPAN_HEADER.
CURRENT_SPAN: contextvars.ContextVar[str | None] = contextvars.ContextVar("current_span", default=None)


class Spans:
    """Posts span events to the attempt's events URL, one per request, numbered consecutively from 1."""

    def __init__(self, url: str, token: str, client: httpx.AsyncClient) -> None:
        self._url = url
        self._headers = {"Authorization": f"Bearer {token}"}
        self._client = client
        self._ids = itertools.count(1)
        self._sequence = itertools.count(1)
        self._lock = asyncio.Lock()  # a sequence number is taken and posted together, so arrival order is sequence order
        self._first: int | None = None

    async def _post(self, event: dict[str, Any]) -> None:
        async with self._lock:
            now = time.monotonic_ns()
            self._first = self._first if self._first is not None else now
            body = {"protocol": PROTOCOL, "emitter_id": EMITTER, "sequence": next(self._sequence), "elapsed_us": (now - self._first) // 1000, **event}
            response = await self._client.post(self._url, json=body, headers=self._headers)
        if response.status_code >= 300:
            raise RuntimeError(f"events answered {response.status_code}: {response.text}")

    async def start(self, kind: str, name: str, *, parent: str | None = None) -> str:
        span = f"s{next(self._ids)}"
        await self._post({"event": "span.start", "span_id": span, "kind": kind, "name": name, **({"parent_span_id": parent} if parent else {})})
        return span

    async def end(self, span: str, status: str = "ok") -> None:
        await self._post({"event": "span.end", "span_id": span, "status": status})
