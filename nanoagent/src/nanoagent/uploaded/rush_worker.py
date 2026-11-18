"""The worker's client of the RUSH benchmark worker API (docs/contracts/rush-benchmark-api.md, "Worker API"), and the
adapters that let the attempt-scoped services use it.

* [RushWorkerClient] has one method per worker endpoint. Every server error is a [RushError] subclass chosen by its
  `code`; a connection that stays down is [RushUnavailable]. Idempotent calls are retried with backoff; an admission is
  never reissued blindly (a `duplicate_call` that answers our own retry means the first attempt landed).
* [Lease] is the shared state of one leased attempt: the first `lease_lost` or `canceled` answer anywhere marks it.
* [RushAdmission] implements the gateway's `Admission` and [RushJournal] its `Journal` over the client. The journal
  uploads a payload when it is stored, so it exists before any event that references it, and group-commits events in
  order (identical retries are safe: the server answers a known `event_id` with the same cursor). After the lease is
  lost or the stream is sealed it commits nothing more: the server would reject it.
"""

from __future__ import annotations

import base64
import hashlib
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import anyio
import httpx

from nanoagent.uploaded.evidence import MAX_PAYLOAD_BYTES, EvidenceEvent, json_bytes, sha256_hex
from nanoagent.uploaded.gateway import AdmissionDenied
from nanoagent.uploaded.records import WORKER, Fact, make_record

FENCE_HEADER = "X-Rush-Fence"
REDACTION_HEADER = "X-Rush-Redaction"
MAX_EVENTS_PER_BATCH = 500
RETRYABLE_STATUS = frozenset({502, 503, 504})
# RUSH refuses an event whose data is over 256 KiB and an attempt's 100,001st event with a 413, which would fault the attempt
# unscored, so both are kept below by construction: the journal stubs the former and drops the latter.
MAX_EVENT_DATA_BYTES = 200 * 1024
# Records the harness can multiply (its events, commands, tools, processes, refused calls) are dropped past EVENT_BUDGET. The
# worker's and the gateway's records of admitted calls always get through: at most ~4 per call under RUSH's 10,000-call bound
# (MAX_MODEL_CALLS), so 40,000, which with the budget and the worker's few records stays under RUSH's 100,000.
EVENT_BUDGET = 55_000
KEPT_SOURCES = frozenset({WORKER, "gateway"})
DROPPABLE_KINDS = frozenset({"model_call.rejected", "journal.backpressure"})
STUB_KEYS = (16, 8, 4)  # entries a stub keeps per nesting level; deeper levels are dropped
STUB_STRING = 64  # characters a stub keeps of a string


class RushError(Exception):
    """The server refused a request; `code` is its stable error code."""

    def __init__(self, status: int, code: str, message: str, body: Mapping[str, Any] | None = None) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.body = dict(body or {})


class LeaseLost(RushError):
    """The fence is stale, the lease expired or the attempt was interrupted."""


class Canceled(RushError):
    """The run was canceled."""


class Sealed(RushError):
    """The attempt was already finalized."""


class ConflictingDuplicate(RushError):
    """The same identity was submitted with different content."""


class BudgetExhausted(RushError):
    @property
    def scope(self) -> str | None:
        return self.body.get("scope")


class DuplicateCall(RushError):
    pass


class UnknownCall(RushError):
    pass


class AlreadySettled(RushError):
    pass


class CursorMismatch(RushError):
    @property
    def high_water_cursor(self) -> int | None:
        return self.body.get("high_water_cursor")


class RushUnavailable(Exception):
    """The server could not be reached, or kept answering 5xx, through every retry."""


_BY_CODE: dict[str, type[RushError]] = {
    "lease_lost": LeaseLost,
    "canceled": Canceled,
    "sealed": Sealed,
    "conflicting_duplicate": ConflictingDuplicate,
    "budget_exhausted": BudgetExhausted,
    "duplicate_call": DuplicateCall,
    "unknown_call": UnknownCall,
    "already_settled": AlreadySettled,
    "cursor_mismatch": CursorMismatch,
}


def rush_error(response: httpx.Response) -> RushError:
    try:
        body = response.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    code = str(body.get("code") or f"http_{response.status_code}")
    message = str(body.get("error") or response.text[:200])
    return _BY_CODE.get(code, RushError)(response.status_code, code, message, body)


@dataclass(frozen=True)
class AttemptJob:
    """One claimed attempt. ``run`` holds model, dialects, source_sha256, ``policy`` and the effective ``limits``; ``task``
    is ``{id, kind, description, instructions, plugin_name, tools}``; ``case`` is ``{case_id, kind, arguments, context,
    input_schema, output_schema, content_digest}``; ``prompt`` is ``{system, user, sha256}``; ``plugin`` is
    ``{id, name, version, sha256}``. (The claim's ``case_set`` and ``renderer_version`` are the server's bookkeeping.)"""

    attempt_id: str
    attempt_no: int
    fence: int
    run: Mapping[str, Any]
    task: Mapping[str, Any]
    case: Mapping[str, Any]
    prompt: Mapping[str, Any]
    plugin: Mapping[str, Any]
    private_reference: Any
    lease_seconds: float  # how long the claim, and each renewal, keeps the lease


def parse_job(body: Mapping[str, Any]) -> AttemptJob:
    try:
        if body["kind"] == "attempt":
            return AttemptJob(
                body["attempt_id"], body["attempt_no"], body["fence"], body["run"], body["task"], body["case"], body["prompt"],
                body["plugin"], body.get("private_reference"), float(body["lease_seconds"]),
            )
    except KeyError as error:
        raise RushError(200, "invalid_job", f"the claimed job lacks {error.args[0]!r}", body) from error
    raise RushError(200, "invalid_job", f"unknown job kind {body.get('kind')!r}", body)


class RushWorkerClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        client: httpx.AsyncClient | None = None,
        retries: int = 5,
        backoff_s: float = 0.5,
        sleep: Callable[[float], Awaitable[None]] = anyio.sleep,
    ) -> None:
        self._owned = client is None
        self._http = client or httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=httpx.Timeout(60, connect=10))
        self._headers = {"Authorization": f"Bearer {token}"}
        self._retries = retries
        self._backoff_s = backoff_s
        self._sleep = sleep

    async def aclose(self) -> None:
        if self._owned:
            await self._http.aclose()

    async def _send(self, method: str, path: str, *, retry: bool = True, **kwargs: Any) -> httpx.Response:
        """One request, retried over transport failures and 5xx when ``retry``; any other non-2xx raises its [RushError]."""
        attempts = self._retries + 1 if retry else 1
        last: BaseException | None = None
        headers = {**self._headers, **kwargs.pop("headers", {})}
        for attempt in range(attempts):
            if attempt:
                await self._sleep(self._backoff_s * 2 ** (attempt - 1))
            try:
                response = await self._http.request(method, f"/api/benchmark-worker{path}", headers=headers, **kwargs)
            except httpx.TransportError as error:
                last = error
                continue
            if response.status_code in RETRYABLE_STATUS:
                last = rush_error(response)
                continue
            if response.is_success:
                return response
            raise rush_error(response)
        raise RushUnavailable(f"{method} {path} failed after {attempts} attempts: {last!r}") from last

    async def _json(self, method: str, path: str, body: Mapping[str, Any] | None = None, *, retry: bool = True) -> Any:
        kwargs: dict[str, Any] = {}
        if body is not None:
            kwargs = {"content": json_bytes(body), "headers": {"Content-Type": "application/json"}}
        response = await self._send(method, path, retry=retry, **kwargs)
        return response.json() if response.content else None

    # -- leases ------------------------------------------------------------------------------------------------

    async def claim(self, worker_id: str, label: str, mode: str, capabilities: Mapping[str, Any]) -> AttemptJob | None:
        """Claim an attempt; ``capabilities`` is the worker's maximum for each numeric limit and its ``internet_access`` support,
        which the server stores for the endpoint label and matches the run's limits against."""
        body = {"worker_id": worker_id, "endpoint_profile": {"label": label, "mode": mode}, "capabilities": dict(capabilities)}
        response = await self._send("POST", "/claim", content=json_bytes(body), headers={"Content-Type": "application/json"})
        return None if response.status_code == 204 else parse_job(response.json())

    async def renew(self, attempt_id: str, fence: int) -> float:
        """Renew the lease; returns how many seconds it now lasts, counted from this request."""
        return float((await self._json("POST", f"/attempts/{attempt_id}/renew", {"fence": fence}))["lease_seconds"])

    # -- bytes -------------------------------------------------------------------------------------------------

    async def _download(self, path: str, fence: int) -> bytes:
        response = await self._send("GET", path, headers={FENCE_HEADER: str(fence)})
        declared = response.headers.get("X-Rush-Sha256")
        if declared is not None and declared != hashlib.sha256(response.content).hexdigest():
            raise RushError(response.status_code, "digest_mismatch", f"{path} did not hash to the digest the server declared")
        return response.content

    async def source(self, attempt_id: str, fence: int) -> bytes:
        return await self._download(f"/attempts/{attempt_id}/source", fence)

    async def package(self, attempt_id: str, fence: int) -> bytes:
        return await self._download(f"/attempts/{attempt_id}/package", fence)

    # -- admissions --------------------------------------------------------------------------------------------

    async def admit(self, attempt_id: str, fence: int, call_id: str, reserve_usd: float) -> None:
        """Reserve one physical call. The request is retried over a dropped connection; if a retry answers
        `duplicate_call` our own first try had landed, so the reservation exists."""
        body = {"fence": fence, "call_id": call_id, "reserve_usd": reserve_usd}
        attempts = self._retries + 1
        retried = False
        last: BaseException | None = None
        for attempt in range(attempts):
            if attempt:
                await self._sleep(self._backoff_s * 2 ** (attempt - 1))
            try:
                await self._json("POST", f"/attempts/{attempt_id}/admissions", body, retry=False)
                return
            except DuplicateCall:
                if retried:
                    return
                raise
            except (RushUnavailable, RushError) as error:
                if isinstance(error, RushError) and error.status not in RETRYABLE_STATUS:
                    raise
                retried, last = True, error
        raise RushUnavailable(f"admission of {call_id} failed after {attempts} attempts: {last!r}") from last

    async def settle(self, attempt_id: str, call_id: str, outcome: str, cost_usd: float | None, provenance: Mapping[str, Any]) -> None:
        body: dict[str, Any] = {"fence": 0, "outcome": outcome, "provenance": dict(provenance)}
        if outcome == "settled":
            body["cost_usd"] = cost_usd
        await self._json("POST", f"/attempts/{attempt_id}/admissions/{call_id}/settle", body)

    # -- evidence ----------------------------------------------------------------------------------------------

    async def append_events(self, attempt_id: str, fence: int, events: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
        wire = [{**event, "occurred_ns": str(event["occurred_ns"])} if "occurred_ns" in event else dict(event) for event in events]
        return await self._json("POST", f"/attempts/{attempt_id}/events", {"fence": fence, "events": wire})

    async def put_payload(self, attempt_id: str, fence: int, sha256: str, data: bytes, redaction: str, content_type: str = "application/octet-stream") -> None:
        await self._send(
            "PUT", f"/attempts/{attempt_id}/payloads/{sha256}", content=data,
            headers={FENCE_HEADER: str(fence), REDACTION_HEADER: redaction, "Content-Type": content_type},
        )

    async def terminal(self, attempt_id: str, fence: int, offset: int, data: bytes) -> None:
        """Appends ``data``, the harness's terminal output from byte ``offset``, to what RUSH shows of it (a retried
        offset is kept once)."""
        await self._json("POST", f"/attempts/{attempt_id}/terminal", {"fence": fence, "offset": offset, "data": base64.b64encode(data).decode("ascii")})

    async def terminal_input(self, attempt_id: str, fence: int, after: int) -> list[Mapping[str, Any]]:
        """What the member sent the harness's terminal after input ``after``: ``[{seq, data, rows, cols}]`` (``data`` base64 keystrokes,
        or null for a resize to ``rows`` by ``cols``). RUSH holds the request open a while for some to come, and answers [] if none did."""
        response = await self._send("GET", f"/attempts/{attempt_id}/terminal-input", params={"after": after}, headers={FENCE_HEADER: str(fence)})
        return response.json()["inputs"]

    async def save_harness(self, attempt_id: str, fence: int, data: bytes) -> Mapping[str, Any]:
        """Saves the harness ZIP ``data`` that the attempt's session made (`rush save`) as its member's: RUSH's
        ``{source_sha256, size, harness: {name, version, dialects}}``. Saving the same ZIP again changes nothing."""
        response = await self._send("POST", f"/attempts/{attempt_id}/harness", content=data, headers={FENCE_HEADER: str(fence), "Content-Type": "application/zip"})
        return response.json()

    async def spans(self, attempt_id: str, body: Mapping[str, Any]) -> None:
        await self._json("POST", f"/attempts/{attempt_id}/spans", body)

    async def finalize(self, attempt_id: str, body: Mapping[str, Any]) -> Mapping[str, Any]:
        return await self._json("POST", f"/attempts/{attempt_id}/finalize", body)

    async def accounting(self, attempt_id: str, call_id: str, version: int, record: Mapping[str, Any]) -> None:
        await self._json("POST", f"/attempts/{attempt_id}/accounting", {"call_id": call_id, "version": version, "record": dict(record)})


class Lease:
    """The shared state of one leased attempt. ``fail`` is idempotent: the first reason stays.

    The lease is also fenced locally. Each successful claim or renewal extends the time it is known to be valid until, counted
    from when the request was sent on the injected monotonic clock. Once that passes without a renewal ``lapsed`` fails the
    lease as `lease_lost`, so the attempt's services refuse new work between renewals, as the server already does. A lease built
    without ``lease_s`` has no known expiry and is only ever failed by an answer from the server.

    With ``wall_clock_ns`` the expiry is also kept on the wall clock. A computer that sleeps stops the monotonic clock (or the
    VM that Docker runs in), so the lease looks alive on waking although the server expired it: the wall clock sees the sleep.
    """

    def __init__(
        self, attempt_id: str, fence: int, *, lease_s: float | None = None, clock_ns: Callable[[], int] = time.monotonic_ns,
        wall_clock_ns: Callable[[], int] | None = None,
    ) -> None:
        self.attempt_id = attempt_id
        self.fence = fence
        self.reason: str | None = None  # `lease_lost`, `canceled` or `sealed`
        self.revoked = anyio.Event()
        self._clock_ns = clock_ns
        self._wall_clock_ns = wall_clock_ns
        self.valid_until_ns: int | None = None if lease_s is None else clock_ns() + round(lease_s * 1e9)
        self.valid_until_wall_ns: int | None = None if lease_s is None or wall_clock_ns is None else wall_clock_ns() + round(lease_s * 1e9)

    @property
    def active(self) -> bool:
        return self.reason is None

    def extend(self, lease_s: float, requested_ns: int) -> None:
        """A renewal sent at ``requested_ns`` succeeded: the lease is valid for ``lease_s`` from then."""
        until = requested_ns + round(lease_s * 1e9)
        self.valid_until_ns = until if self.valid_until_ns is None else max(self.valid_until_ns, until)
        if self._wall_clock_ns is not None:
            wall_until = self._wall_clock_ns() - (self._clock_ns() - requested_ns) + round(lease_s * 1e9)  # the request's wall time, plus the lease
            self.valid_until_wall_ns = wall_until if self.valid_until_wall_ns is None else max(self.valid_until_wall_ns, wall_until)

    def lapsed(self) -> bool:
        """Whether the lease can no longer be used: failed already, or its known expiry passed without a renewal (which fails it)."""
        if self.reason is None and self.valid_until_ns is not None and self._clock_ns() >= self.valid_until_ns:
            self.fail(LeaseLost(409, "lease_lost", "the lease expired without a successful renewal"))
        elif self.reason is None and self.valid_until_wall_ns is not None and self._wall_clock_ns() >= self.valid_until_wall_ns:  # type: ignore[misc]
            self.fail(LeaseLost(409, "lease_lost", "the lease expired on the wall clock: the computer slept"))
        return self.reason is not None

    def fail(self, error: RushError) -> None:
        if self.reason is None:
            self.reason = "sealed" if isinstance(error, Sealed) else error.code
            self.revoked.set()


class RushAdmission:
    """The gateway's `Admission` over the worker API: reserve under the fence, settle without it."""

    def __init__(self, client: RushWorkerClient, lease: Lease) -> None:
        self._client = client
        self._lease = lease
        self.denials: list[tuple[str, str | None]] = []  # (code, scope) of each refusal

    async def reserve(self, call_id: str, bound_usd: Decimal) -> None:
        if self._lease.lapsed():
            raise AdmissionDenied("lease_lost" if self._lease.reason != "canceled" else "revoked")
        try:
            await self._client.admit(self._lease.attempt_id, self._lease.fence, call_id, float(bound_usd))
        except LeaseLost as error:
            self._lease.fail(error)
            raise AdmissionDenied("lease_lost") from error
        except Canceled as error:
            self._lease.fail(error)
            raise AdmissionDenied("revoked") from error
        except BudgetExhausted as error:
            self.denials.append((error.code, error.scope))
            raise AdmissionDenied("budget_exhausted") from error

    async def settle(self, call_id: str, cost_usd: Decimal | None, provenance: str) -> None:
        if cost_usd is None:
            # The response finished but its cost is not known: keep the reservation until the generation lookup settles it.
            await self._client.settle(self._lease.attempt_id, call_id, "uncertain", None, {"source": provenance, "cost": "unknown"})
        else:
            await self._client.settle(self._lease.attempt_id, call_id, "settled", float(cost_usd), {"source": provenance})

    async def mark_uncertain(self, call_id: str) -> None:
        await self._client.settle(self._lease.attempt_id, call_id, "uncertain", None, {"source": "outcome_unknown"})


def wire_event(event: EvidenceEvent) -> dict[str, Any]:
    return {
        "event_id": event.event_id,
        "source": event.source,
        "kind": event.kind,
        "sequence": event.sequence,
        "occurred_ns": event.monotonic_ns,
        "data": dict(event.data),
        "payload_sha256s": list(event.payload_sha256s),
    }


def _shrink(value: Any, depth: int) -> Any:
    """``value`` cut to a bounded size: long strings clipped, only the first few entries of each level kept, deeper levels None."""
    if isinstance(value, str):
        return value[:STUB_STRING]
    if isinstance(value, Mapping):
        return None if depth >= len(STUB_KEYS) else {str(key)[:STUB_STRING]: _shrink(item, depth + 1) for key, item in list(value.items())[: STUB_KEYS[depth]]}
    if isinstance(value, (list, tuple)):
        return None if depth >= len(STUB_KEYS) else [_shrink(item, depth + 1) for item in value[: STUB_KEYS[depth]]]
    return value


@dataclass
class RushJournal:
    """The gateway's `Journal` over the worker API, and the local mirror of what was committed.

    ``records`` and ``payloads`` are the committed events and payload bytes, for projection once the case ends.
    """

    client: RushWorkerClient
    lease: Lease
    records: list[dict[str, Any]] = field(default_factory=list)
    payloads: dict[str, bytes] = field(default_factory=dict)
    redactions: dict[str, str] = field(default_factory=dict)  # payload digest -> none, redacted or truncated
    high_water: int = 0
    dropped: int = 0  # events not sent because the lease was lost or the stream sealed
    over_budget: int = 0  # non-worker events not sent because the attempt is at its event budget
    accepted: int = 0  # events taken for sending, which count against the budget
    closed: bool = False
    _queue: list[dict[str, Any]] = field(default_factory=list)
    _sent: set[str] = field(default_factory=set)
    _uploaded: set[str] = field(default_factory=set)
    _lock: anyio.Lock = field(default_factory=anyio.Lock)

    async def append(self, event: EvidenceEvent) -> None:
        await self.append_record(wire_event(event))

    async def append_records(self, records: Sequence[Mapping[str, Any]]) -> None:
        for record in records:
            await self.append_record(record)

    async def append_record(self, record: Mapping[str, Any]) -> None:
        """Commit ``record`` in order. Concurrent callers share batches: whoever holds the lock sends what is queued."""
        if self.closed:
            self.dropped += 1
            return
        droppable = record["source"] not in KEPT_SOURCES or record["kind"] in DROPPABLE_KINDS
        if droppable and self.accepted >= EVENT_BUDGET:
            self.over_budget += 1  # reported in the coverage
            return
        self.accepted += 1
        record = await self._within_data_limit(record)
        self._queue.append(dict(record))
        async with self._lock:
            while record["event_id"] not in self._sent:
                batch, self._queue = self._queue[:MAX_EVENTS_PER_BATCH], self._queue[MAX_EVENTS_PER_BATCH:]
                if not await self._commit(batch):
                    self.dropped += len(batch)
                    self._sent.update(item["event_id"] for item in batch)

    async def _within_data_limit(self, record: Mapping[str, Any]) -> Mapping[str, Any]:
        """``record``, or when its data is over the event limit a stub of it: the data whole is a payload, the event keeps its short fields."""
        data = json_bytes(record["data"])
        if len(data) <= MAX_EVENT_DATA_BYTES:
            return record
        sha = await self.put_payload(data[:MAX_PAYLOAD_BYTES], "clean" if len(data) <= MAX_PAYLOAD_BYTES else "truncated")
        marks = {"data_truncated": True, "data_payload_sha256": sha}
        # Reconciliation must work even when the full data payload is truncated or unavailable.
        if record["kind"] == "model_call.response":
            marks.update({key: record["data"][key] for key in ("call_id", "generation_id", "settlement") if key in record["data"]})
        stub = {**_shrink(record["data"], 0), **marks}
        if len(json_bytes(stub)) > MAX_EVENT_DATA_BYTES:  # a multi-byte or heavily escaped string can outgrow the character caps
            stub = marks
        if len(json_bytes(stub)) > MAX_EVENT_DATA_BYTES:
            raise ValueError("model response accounting identifiers exceed the event data limit")
        return {**record, "data": stub, "payload_sha256s": [*record["payload_sha256s"], sha]}

    async def _commit(self, batch: list[dict[str, Any]]) -> bool:
        if self.closed:
            return False
        try:
            receipt = await self.client.append_events(self.lease.attempt_id, self.lease.fence, batch)
        except (LeaseLost, Canceled, Sealed) as error:
            self.lease.fail(error)
            self.closed = True
            return False
        self.high_water = max(self.high_water, int(receipt["high_water_cursor"]))
        self.records.extend(batch)
        self._sent.update(item["event_id"] for item in batch)
        return True

    async def put_payload(self, data: bytes, redaction: str) -> str:
        sha = sha256_hex(data)
        self.payloads[sha] = data
        self.redactions[sha] = "none" if redaction == "clean" else redaction
        if self.closed or sha in self._uploaded:
            return sha
        try:
            await self.client.put_payload(self.lease.attempt_id, self.lease.fence, sha, data, "none" if redaction == "clean" else redaction)
        except (LeaseLost, Canceled, Sealed) as error:
            self.lease.fail(error)
            self.closed = True
            return sha
        self._uploaded.add(sha)
        return sha

    def close(self) -> None:
        """Stop committing: the attempt is sealed or its lease is gone."""
        self.closed = True


class Emitter:
    """Numbers and commits the worker's and the process collector's records, stamped by the injected monotonic clock."""

    def __init__(self, journal: RushJournal, clock_ns: Callable[[], int]) -> None:
        self._journal = journal
        self._clock_ns = clock_ns
        self._sequences: dict[str, int] = {}

    def records(self, facts: Sequence[Fact], *, occurred_ns: Sequence[int] | None = None, payloads: Sequence[str] = ()) -> list[dict[str, Any]]:
        out = []
        for index, fact in enumerate(facts):
            self._sequences[fact.source] = sequence = self._sequences.get(fact.source, 0) + 1
            when = self._clock_ns() if occurred_ns is None else occurred_ns[index]
            out.append(make_record(fact, event_id=f"{fact.source}-{sequence:06d}", sequence=sequence, occurred_ns=when, payload_sha256s=payloads))
        return out

    async def emit(self, fact: Fact, *, occurred_ns: int | None = None, payloads: Sequence[str] = ()) -> None:
        await self._journal.append_records(self.records([fact], occurred_ns=None if occurred_ns is None else [occurred_ns], payloads=payloads))

    async def emit_many(self, facts: Sequence[Fact], occurred_ns: Sequence[int]) -> None:
        await self._journal.append_records(self.records(facts, occurred_ns=occurred_ns))
