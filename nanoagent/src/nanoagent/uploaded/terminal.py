"""The harness's terminal, between it and the member at a page: what its process writes to the PTY it runs under goes to RUSH
as it comes, and what the member types (or a new size of their terminal) comes back from RUSH to the PTY.

The case's sandbox hands each chunk of output to :meth:`Terminal.write` from its own thread; :meth:`Terminal.pump` sends what
has come every :data:`SEND_S` until it is cancelled, and :meth:`Terminal.flush` sends the rest. What passes ``limit_bytes`` is
not sent: a last line says so instead. :meth:`Terminal.feed` reads the member's input and types it at the case.
"""

from __future__ import annotations

import base64
import threading
from typing import Any

import anyio

from nanoagent.uploaded.rush_worker import Canceled, Lease, LeaseLost, RushWorkerClient, Sealed

SEND_S = 0.05
MAX_SEND_BYTES = 256 * 1024  # one request's bytes at most
# What one attempt's terminal sends at most, with room for the note that it was cut: RUSH keeps 4 MiB of it.
LIMIT_BYTES = 4 * 1024 * 1024 - 4096


class Terminal:
    def __init__(self, worker: RushWorkerClient, attempt_id: str, fence: int, limit_bytes: int = LIMIT_BYTES) -> None:
        self._worker = worker
        self._attempt_id = attempt_id
        self._fence = fence
        self._limit = limit_bytes
        self._lock = threading.Lock()
        self._pending = bytearray()
        self._taken = 0  # bytes accepted into _pending, at most the limit
        self._cut = False
        self._sent = 0
        self._sending = anyio.Lock()

    def write(self, data: bytes) -> None:
        with self._lock:
            room = self._limit - self._taken
            if len(data) > room and not self._cut:
                self._cut = True
                note = f"\r\n\x1b[0m[RUSH: the terminal's output passed its {self._limit} byte bound; the rest is not shown]\r\n".encode()
                self._pending += data[: max(room, 0)] + note
                self._taken = self._limit
            elif not self._cut:
                self._pending += data
                self._taken += len(data)

    async def flush(self) -> None:
        async with self._sending:
            while True:
                with self._lock:
                    chunk = bytes(self._pending[:MAX_SEND_BYTES])
                if not chunk:
                    return
                await self._worker.terminal(self._attempt_id, self._fence, self._sent, chunk)
                with self._lock:
                    del self._pending[: len(chunk)]
                self._sent += len(chunk)

    async def pump(self) -> None:
        while True:
            await anyio.sleep(SEND_S)
            await self.flush()

    async def feed(self, case: Any, lease: Lease) -> None:
        """Types what the member sends at ``case``'s terminal (a `CaseHandle`), in order, until cancelled. RUSH answers this read
        as soon as the session is canceled (the member opened another) or its lease lost, which fails ``lease`` at once, so the
        case is killed in well under a second rather than at the next renewal."""
        after = 0
        while True:
            try:
                inputs = await self._worker.terminal_input(self._attempt_id, self._fence, after)
            except (Canceled, LeaseLost, Sealed) as error:
                lease.fail(error)
                return
            for item in inputs:
                data = None if item["data"] is None else base64.b64decode(item["data"])
                await anyio.to_thread.run_sync(case.terminal_input, data, item["rows"], item["cols"])
                after = item["seq"]
