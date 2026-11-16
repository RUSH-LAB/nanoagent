"""Evidence the attempt-scoped services record: the event shape, the journal they write to and the redacting recorder.

The journal is the seam to durable storage (the RUSH server in the worker, an in-memory fake in tests). Its methods are
async so a remote write never blocks the service's event loop. The recorder never makes a caller wait for them: an event
is numbered and stamped when it is observed, then written by one background task in the order observed.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol


Source = Literal["gateway", "tool_broker", "exec", "harness"]
SOURCES: tuple[Source, ...] = ("gateway", "tool_broker", "exec", "harness")

CLEAN = "clean"
REDACTED = "redacted"
REPLACEMENT = b"[REDACTED]"


@dataclass(frozen=True)
class EvidenceEvent:
    """One observation. ``sequence`` counts per source from 1; ``data`` is JSON; payloads are referenced by digest."""

    event_id: str
    source: Source
    kind: str
    sequence: int
    monotonic_ns: int
    data: Mapping[str, Any]
    payload_sha256s: tuple[str, ...] = ()


class Journal(Protocol):
    async def append(self, event: EvidenceEvent) -> None:
        """Persist ``event``; identified by ``event_id``."""

    async def put_payload(self, data: bytes, redaction: str) -> str:
        """Store already-redacted bytes with their redaction status (``clean`` or ``redacted``); return their SHA-256 hex."""


def redact(data: bytes, secrets: Sequence[str]) -> tuple[bytes, str]:
    """Replace every occurrence of a credential and report whether any was found."""
    status = CLEAN
    for secret in secrets:
        needle = secret.encode("utf-8")
        if needle and needle in data:
            data = data.replace(needle, REPLACEMENT)
            status = REDACTED
    return data, status


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


MAX_QUEUED_BYTES = 64 << 20
MAX_QUEUED_ITEMS = 4096


class JournalWriteError(Exception):
    """A background journal write failed; the evidence queued behind it was not written."""


@dataclass(frozen=True)
class _Write:
    """One queued journal write: an event, or a payload that the events after it may reference."""

    size: int
    event: EvidenceEvent | None = None
    payload: bytes | None = None
    redaction: str = CLEAN
    sha256: str = ""


@dataclass
class Backpressure:
    """A time a caller had to wait because the unwritten queue was full (the journal is slower than the evidence)."""

    source: str
    started_ns: int
    blocked_ns: int
    queued_items: int
    queued_bytes: int


class Recorder:
    """Numbers events per source, stamps them from the injected monotonic clock and redacts payloads on the way in.

    Recording never waits for the journal. ``record`` stamps the event on entry, numbers it and queues it; ``payload``
    hashes the redacted bytes and queues their upload ahead of any event that can reference them. One task writes the
    queue in order, so the journal sees every source's events in sequence order and a payload before its events. The
    queue is bounded by item count and bytes: a caller that finds it full waits for room, and that wait is kept in
    ``backpressure`` and recorded as a `journal.backpressure` event, so it is never mistaken for upstream delay.
    ``flush`` waits until everything queued is written and raises if a write failed.
    """

    def __init__(
        self,
        journal: Journal,
        clock_ns: Callable[[], int],
        secrets: Sequence[str],
        *,
        max_queued_bytes: int = MAX_QUEUED_BYTES,
        max_queued_items: int = MAX_QUEUED_ITEMS,
    ) -> None:
        self._journal = journal
        self._clock_ns = clock_ns
        self._secrets = tuple(secrets)
        self._max_bytes = max_queued_bytes
        self._max_items = max_queued_items
        self._sequences: dict[str, int] = dict.fromkeys(SOURCES, 0)
        self._queue: deque[_Write] = deque()
        self._queued_bytes = 0
        self._pending = 0  # queued or being written
        self._queued_payloads: set[tuple[str, str]] = set()
        self._work = asyncio.Event()
        self._room: asyncio.Event | None = None
        self._drained = asyncio.Event()
        self._drained.set()
        self._writer: asyncio.Task[None] | None = None
        self._failure: BaseException | None = None
        self.backpressure: list[Backpressure] = []

    async def payload(self, data: bytes) -> str:
        cleaned, status = redact(data, self._secrets)
        sha = sha256_hex(cleaned)
        if (sha, status) not in self._queued_payloads:
            self._queued_payloads.add((sha, status))
            await self._enqueue(_Write(len(cleaned), payload=cleaned, redaction=status, sha256=sha), "gateway")
        return sha

    async def json_payload(self, value: Any) -> str:
        return await self.payload(json_bytes(value))

    async def record(self, source: Source, kind: str, data: Mapping[str, Any], payloads: Sequence[str] = ()) -> EvidenceEvent:
        occurred_ns = self._clock_ns()  # when it was observed, not when the journal got to it
        return await self._record(source, kind, data, payloads, occurred_ns)

    async def flush(self) -> None:
        """Wait until every queued write is in the journal; raises [JournalWriteError] if one failed."""
        await self._drained.wait()
        self._raise_failure()

    async def aclose(self) -> None:
        try:
            if self._writer is not None and not self._writer.done():
                await self.flush()
        finally:
            if self._writer is not None:
                self._writer.cancel()

    async def _record(
        self, source: Source, kind: str, data: Mapping[str, Any], payloads: Sequence[str], occurred_ns: int, *, bounded: bool = True
    ) -> EvidenceEvent:
        self._raise_failure()
        size = len(json_bytes(data))
        if bounded:
            await self._wait_for_room(size, source)
        # Numbering and queuing are one step (no await between) so the journal sees each source's events in sequence order.
        self._sequences[source] += 1
        sequence = self._sequences[source]
        event = EvidenceEvent(f"{source}-{sequence:06d}", source, kind, sequence, occurred_ns, dict(data), tuple(payloads))
        self._push(_Write(size, event=event))
        return event

    async def _enqueue(self, write: _Write, source: Source) -> None:
        self._raise_failure()
        await self._wait_for_room(write.size, source)
        self._push(write)

    def _full(self, size: int) -> bool:
        return self._pending > 0 and (self._pending >= self._max_items or self._queued_bytes + size > self._max_bytes)

    async def _wait_for_room(self, size: int, source: Source) -> None:
        started = None
        while self._full(size):
            started = self._clock_ns() if started is None else started
            if self._room is None:
                self._room = asyncio.Event()
            await self._room.wait()
            self._raise_failure()
        if started is not None:
            blocked = Backpressure(source, started, self._clock_ns() - started, self._pending, self._queued_bytes)
            self.backpressure.append(blocked)
            # Queued past the bound: the note about a wait must not wait itself.
            await self._record(
                "gateway",
                "journal.backpressure",
                {
                    "source": source,
                    "started_ns": blocked.started_ns,
                    "blocked_ns": blocked.blocked_ns,
                    "queued_items": blocked.queued_items,
                    "queued_bytes": blocked.queued_bytes,
                },
                (),
                started,
                bounded=False,
            )

    def _push(self, write: _Write) -> None:
        self._queue.append(write)
        self._queued_bytes += write.size
        self._pending += 1
        self._drained.clear()
        self._work.set()
        if self._writer is None or self._writer.done():
            self._writer = asyncio.get_running_loop().create_task(self._write_all())

    def _raise_failure(self) -> None:
        if self._failure is not None:
            raise JournalWriteError(f"evidence could not be written: {self._failure!r}") from self._failure

    async def _write_all(self) -> None:
        while True:
            while not self._queue:
                self._work.clear()
                await self._work.wait()
            write = self._queue.popleft()
            try:
                if write.event is not None:
                    await self._journal.append(write.event)
                else:
                    assert write.payload is not None
                    stored = await self._journal.put_payload(write.payload, write.redaction)
                    if stored != write.sha256:
                        raise JournalWriteError(f"the journal stored payload {write.sha256} as {stored}")
            except BaseException as error:
                self._failure = error
                self._queue.clear()
                self._queued_bytes = self._pending = 0
                self._drained.set()
                if self._room is not None:
                    self._room.set()
                if isinstance(error, asyncio.CancelledError):
                    raise
                return
            self._queued_bytes -= write.size
            self._pending -= 1
            if self._room is not None:
                self._room.set()
                self._room = None
            if not self._pending:
                self._drained.set()
