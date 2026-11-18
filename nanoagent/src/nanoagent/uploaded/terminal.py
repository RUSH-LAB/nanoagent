"""The harness's terminals, between it and the member at a page: what each one's process writes to its PTY goes to RUSH as it comes,
and what the member types at one (or a new size of it, or that they opened or closed it) comes back from RUSH to its PTY.

Terminal 0 is the harness's own; a free-form session's member opens more (1, 2, ...) in the same case (`CaseHandle.open_terminal`).
The case's sandbox hands each chunk of output to :meth:`Terminal.write` from its own thread; :meth:`Terminal.pump` sends what has
come every :data:`SEND_S` until it is cancelled, and :meth:`Terminal.flush` sends the rest, then that each terminal that ended did.
What passes ``limit_bytes``, all terminals together, is not sent: a last line in each says so instead. :meth:`Terminal.feed` reads
the member's input and passes it to the case.
"""

from __future__ import annotations

import base64
import threading
from functools import partial
from typing import Any

import anyio

from nanoagent.uploaded.rush_worker import Canceled, Lease, LeaseLost, RushWorkerClient, Sealed

SEND_S = 0.05
MAX_SEND_BYTES = 256 * 1024  # one request's bytes at most
# What one attempt's terminals send at most, with room for the notes that they were cut (32 at most): RUSH keeps 4 MiB of it.
LIMIT_BYTES = 4 * 1024 * 1024 - 4096


class Terminal:
    def __init__(self, worker: RushWorkerClient, attempt_id: str, fence: int, limit_bytes: int = LIMIT_BYTES) -> None:
        self._worker = worker
        self._attempt_id = attempt_id
        self._fence = fence
        self._limit = limit_bytes
        self._lock = threading.Lock()
        self._pending: dict[int, bytearray] = {}
        self._taken = 0  # bytes accepted into _pending, at most the limit
        self._cut: set[int] = set()
        self._sent: dict[int, int] = {}
        self._opened = {0}
        self._closed: set[int] = set()  # the terminals RUSH was told ended
        self._sending = anyio.Lock()

    def write(self, terminal: int, data: bytes) -> None:
        with self._lock:
            pending = self._pending.setdefault(terminal, bytearray())
            room = self._limit - self._taken
            if len(data) > room and terminal not in self._cut:
                self._cut.add(terminal)
                note = f"\r\n\x1b[0m[RUSH: the terminals' output passed its {self._limit} byte bound; the rest is not shown]\r\n".encode()
                pending += data[: max(room, 0)] + note
                self._taken = self._limit
            elif terminal not in self._cut:
                pending += data
                self._taken += len(data)

    async def flush(self, case: Any) -> None:
        """Sends what every terminal wrote, then that each terminal of ``case`` (a `CaseHandle`) that ended did, after its output."""
        async with self._sending:
            ended = case.ended_terminals()  # before the output: a terminal writes nothing after it ended
            for terminal in list(self._pending):
                while True:
                    with self._lock:
                        chunk = bytes(self._pending[terminal][:MAX_SEND_BYTES])
                    if not chunk:
                        break
                    sent = self._sent.get(terminal, 0)
                    await self._worker.terminal(self._attempt_id, self._fence, terminal, sent, chunk)
                    with self._lock:
                        del self._pending[terminal][: len(chunk)]
                    self._sent[terminal] = sent + len(chunk)
            for terminal in sorted(ended - self._closed):
                await self._worker.terminal_closed(self._attempt_id, self._fence, terminal)
                self._closed.add(terminal)

    async def pump(self, case: Any) -> None:
        while True:
            await anyio.sleep(SEND_S)
            await self.flush(case)

    async def feed(self, case: Any, lease: Lease) -> None:
        """Passes what the member sends to ``case``'s terminals (a `CaseHandle`), in order, until cancelled: a size for a terminal not
        yet open opens it. RUSH answers this read as soon as the session is canceled (the member opened another) or its lease lost,
        which fails ``lease`` at once, so the case is killed in well under a second rather than at the next renewal."""
        after = 0
        while True:
            try:
                inputs = await self._worker.terminal_input(self._attempt_id, self._fence, after)
            except (Canceled, LeaseLost, Sealed) as error:
                lease.fail(error)
                return
            for item in inputs:
                terminal = item["terminal"]
                if item["close"]:
                    await anyio.to_thread.run_sync(case.close_terminal, terminal)
                elif terminal not in self._opened:
                    self._opened.add(terminal)
                    await anyio.to_thread.run_sync(case.open_terminal, terminal, item["rows"], item["cols"], partial(self.write, terminal))
                else:
                    data = None if item["data"] is None else base64.b64decode(item["data"])
                    await anyio.to_thread.run_sync(case.terminal_input, terminal, data, item["rows"], item["cols"])
                after = item["seq"]
