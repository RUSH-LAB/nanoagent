"""The attempt-scoped OpenRouter gateway: one admission and recording path for all three dialects.

Per generation request: authenticate, apply the pinned policy, reserve spend, forward once (never retried here), relay the
response as it arrives, then settle or mark the reservation uncertain. Every outcome is recorded as gateway evidence.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from functools import partial
from typing import Any, Protocol

import anyio
import httpx
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import Receive, Scope, Send

from nanoagent.uploaded.attempt import CALL_HEADER, Attempt, ServiceError, error_response, from_contract, new_call_id
from nanoagent.uploaded.chats import prompt_of
from nanoagent.uploaded.contract import ContractError, decode_json_object
from nanoagent.uploaded.dialects import AssembledResponse, MalformedCaptureError, SseDecoder, SseFrame, ToolProposal, assemble_body, assemble_stream
from nanoagent.uploaded.endpoint import EndpointProfile
from nanoagent.uploaded.evidence import json_bytes
from nanoagent.uploaded.policy import PolicyViolation, apply_policy
from nanoagent.uploaded.usage import NOT_DISPATCHED, MalformedUsageError, NormalizedUsage, usage_for

SUFFIXES = {"chat_completions": "/chat/completions", "responses": "/responses", "anthropic_messages": "/messages"}
DENIED = {"lease_lost": 403, "budget_exhausted": 402, "revoked": 403}
# Response headers kept as evidence and relayed to the harness.
ALLOWED_RESPONSE_HEADERS = ("content-type", "x-generation-id", "x-request-id", "retry-after")
# Request headers forwarded upstream besides the gateway's own credential.
FORWARDED_REQUEST_HEADERS = ("anthropic-version",)
# Request headers kept as evidence; credentials are never among them.
RECORDED_REQUEST_HEADERS = ("content-type", "accept", "anthropic-version", "user-agent")
MAX_RESPONSE_BYTES = 64 << 20
ABORTED, END = object(), object()
# Frames that can finish a tool proposal: only after one of these is the partial stream worth re-assembling.
_CHAT_FINISH = re.compile(r'"finish_reason"\s*:\s*"')
_COMPLETION_MARKERS = {
    "chat_completions": None,
    "responses": ('"response.function_call_arguments.done"', '"response.output_item.done"'),
    "anthropic_messages": ('"content_block_stop"',),
}


def _may_complete(dialect: str, frame: SseFrame) -> bool:
    data = frame.data or ""
    markers = _COMPLETION_MARKERS[dialect]
    return bool(_CHAT_FINISH.search(data)) if markers is None else any(marker in data for marker in markers)


class AdmissionDenied(Exception):
    """Admission refused the call; `code` is one of `lease_lost`, `budget_exhausted`, `revoked`."""

    def __init__(self, code: str) -> None:
        if code not in DENIED:
            raise ValueError(f"unknown admission denial {code!r}")
        super().__init__(code)
        self.code = code


class PolicyRefused(ServiceError):
    """A request the policy refused; ``model`` is the model it asked for, kept on its rejection record."""

    def __init__(self, violation: PolicyViolation, model: Any) -> None:
        super().__init__(400, violation.code, violation.message)
        self.model = model


class Admission(Protocol):
    async def reserve(self, call_id: str, bound_usd: Decimal) -> None:
        """Reserve the call's spend bound under the current lease, or raise [AdmissionDenied]."""

    async def settle(self, call_id: str, cost_usd: Decimal | None, provenance: str) -> None:
        """Record the call's accounting; ``None`` means the response completed but its cost is not known yet."""

    async def mark_uncertain(self, call_id: str) -> None:
        """The call may have reached upstream with an unknown outcome: keep its reservation."""


class UpstreamError(Exception):
    """The upstream exchange failed; ``maybe_reached`` is False only when the request provably never left."""

    def __init__(self, message: str, *, maybe_reached: bool) -> None:
        super().__init__(message)
        self.maybe_reached = maybe_reached


@dataclass(frozen=True)
class UpstreamRequest:
    url: str
    headers: Mapping[str, str]
    body: bytes


class UpstreamResponse(Protocol):
    status: int
    headers: Mapping[str, str]  # lower-case names

    def chunks(self) -> AsyncIterator[bytes]:
        """The body as it arrives; raises [UpstreamError] if the connection fails midway."""

    async def aclose(self) -> None: ...


class UpstreamTransport(Protocol):
    async def send(self, request: UpstreamRequest) -> UpstreamResponse:
        """Send one POST. Raises [UpstreamError] before a response exists."""


class _HttpxResponse:
    def __init__(self, response: httpx.Response) -> None:
        self._response = response
        self.status = response.status_code
        self.headers = {name.lower(): value for name, value in response.headers.items()}

    async def chunks(self) -> AsyncIterator[bytes]:
        try:
            async for chunk in self._response.aiter_bytes():
                yield chunk
        except httpx.HTTPError as error:
            raise UpstreamError(f"{type(error).__name__}: {error}", maybe_reached=True) from error

    async def aclose(self) -> None:
        await self._response.aclose()


class HttpxTransport:
    """The default transport. Connect-phase failures are the only ones that prove the request never reached upstream."""

    NEVER_SENT = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout, httpx.UnsupportedProtocol, httpx.InvalidURL)

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=600, write=60, pool=10), follow_redirects=False)

    async def send(self, request: UpstreamRequest) -> UpstreamResponse:
        built = self._client.build_request("POST", request.url, headers=dict(request.headers), content=request.body)
        try:
            return _HttpxResponse(await self._client.send(built, stream=True))
        except self.NEVER_SENT as error:
            raise UpstreamError(f"{type(error).__name__}: {error}", maybe_reached=False) from error
        except httpx.HTTPError as error:
            raise UpstreamError(f"{type(error).__name__}: {error}", maybe_reached=True) from error

    async def aclose(self) -> None:
        await self._client.aclose()


class ProposalRegistry:
    """`(model_call_id, tool_call_id) -> ToolProposal` for the tool broker.

    A streamed proposal is registered as soon as its arguments are complete, before the stream ends; the rest are
    registered when the response ends.
    """

    def __init__(self) -> None:
        self._proposals: dict[str, dict[str, ToolProposal]] = {}
        self._open: dict[str, anyio.Event] = {}

    def open(self, call_id: str) -> None:
        self._open[call_id] = anyio.Event()

    def register(self, call_id: str, proposal: ToolProposal) -> None:
        if proposal.call_id is not None:
            self._proposals.setdefault(call_id, {}).setdefault(proposal.call_id, proposal)

    def close(self, call_id: str, proposals: Sequence[ToolProposal]) -> None:
        self._proposals.setdefault(call_id, {})
        for proposal in proposals:
            self.register(call_id, proposal)
        event = self._open.pop(call_id, None)
        if event is not None:
            event.set()

    async def lookup(self, call_id: str, tool_call_id: str, wait_s: float) -> ToolProposal | None:
        """The proposal, waiting up to ``wait_s`` for a response that is still streaming; None when unknown."""
        found = self._proposals.get(call_id, {}).get(tool_call_id)
        event = self._open.get(call_id)
        if found is None and event is not None:
            with anyio.move_on_after(wait_s):
                await event.wait()
            found = self._proposals.get(call_id, {}).get(tool_call_id)
        return found


def jsonable(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return jsonable(dataclasses.asdict(value))
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mapping):
        return {key: jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    return value


@dataclass
class _Call:
    call_id: str
    dialect: str
    span_id: str | None
    stream: bool
    bound_usd: Decimal
    submitted_sha: str
    effective_sha: str
    request_headers: dict[str, str]
    upstream: UpstreamRequest
    scope: anyio.CancelScope | None = None
    abort_reason: str | None = None

    def abort(self, reason: str) -> None:
        if self.abort_reason is None:
            self.abort_reason = reason
        if self.scope is not None:
            self.scope.cancel()


@dataclass
class _State:
    """What the relay observed; [Gateway.conclude] turns it into evidence and a settlement exactly once."""

    terminal: str | None = None
    http_status: int | None = None
    headers: dict[str, str] = field(default_factory=dict)
    dispatched_ns: int | None = None
    headers_ns: int | None = None
    first_byte_ns: int | None = None
    completed_ns: int | None = None
    maybe_reached: bool = True
    error: str | None = None
    frames: list[SseFrame] = field(default_factory=list)
    frame_ns: list[int] = field(default_factory=list)  # when each frame's bytes were available from upstream
    frame_delivered_ns: list[int | None] = field(default_factory=list)  # when the relay had handed them to the harness's connection
    delivered_ns: int | None = None  # when the last byte of the response was handed over
    published: bool = False
    raw: bytearray = field(default_factory=bytearray)
    parse_error: str | None = None
    assembled: AssembledResponse | None = None
    usage: NormalizedUsage | None = None
    usage_error: str | None = None
    registrations: list[dict[str, Any]] = field(default_factory=list)  # when each proposal became callable


class Gateway:
    def __init__(
        self, attempt: Attempt, endpoint: EndpointProfile, admission: Admission, transport: UpstreamTransport, registry: ProposalRegistry | None = None
    ) -> None:
        self.attempt = attempt
        self.endpoint = endpoint
        self.admission = admission
        self.transport = transport
        self.registry = registry or ProposalRegistry()
        self._admitted = 0
        self._prompt_satisfied = False
        self._inflight: dict[str, _Call] = {}

    @property
    def recorder(self):
        return self.attempt.recorder

    # ---- admission ------------------------------------------------------------------------------------------------

    async def handle(self, request: Request, dialect: str) -> Response:
        call_id = new_call_id()
        anthropic = dialect == "anthropic_messages"
        submitted_sha: str | None = None
        span_id: str | None = None
        run: str | None = None
        try:
            self.attempt.require_auth(request)
            if dialect not in self.attempt.policy.dialects:
                raise ServiceError(404, "dialect_not_enabled", f"{SUFFIXES[dialect]} is not among this attempt's dialects {list(self.attempt.policy.dialects)}")
            span_id = self.attempt.span_id(request)
            run = self.attempt.rush_run(request)
            self.attempt.require_active()
            raw = await self.attempt.read_body(request)
            submitted_sha = await self.recorder.payload(raw)
            call = await self._admit(request, dialect, raw, call_id, span_id, run, submitted_sha)
        except ServiceError as error:
            await self._reject(call_id, dialect, request, error, span_id, submitted_sha, run)
            return error_response(error, call_id, anthropic=anthropic)
        return _Relay(self, call)

    async def _admit(self, request: Request, dialect: str, raw: bytes, call_id: str, span_id: str | None, run: str | None, submitted_sha: str) -> _Call:
        policy = self.attempt.policy
        try:
            body = decode_json_object(raw, policy.max_request_bytes)
        except ContractError as error:
            raise from_contract(error) from error
        try:
            effective, cap = apply_policy(dialect, body, policy, first_prompt_required=policy.prompt_bound and not self._prompt_satisfied)
        except PolicyViolation as violation:
            raise PolicyRefused(violation, body.get("model")) from violation
        if self._admitted >= policy.max_model_calls:
            raise ServiceError(403, "model_call_limit", f"the attempt admits at most {policy.max_model_calls} model calls")
        effective_bytes = json_bytes(effective)
        # The request's byte length bounds its input tokens (a token is at least one byte).
        bound = Decimal(len(effective_bytes)) * policy.input_price_bound + Decimal(cap) * policy.output_price_bound
        try:
            await self.admission.reserve(call_id, bound)
        except AdmissionDenied as denied:
            raise ServiceError(DENIED[denied.code], denied.code, f"admission denied the call: {denied.code}") from denied
        self._admitted += 1
        headers = {"content-type": "application/json", "accept": request.headers.get("accept", "*/*"), "accept-encoding": "identity"}
        headers["authorization"] = f"Bearer {self.endpoint.api_key}"
        headers.update({name: request.headers[name] for name in FORWARDED_REQUEST_HEADERS if name in request.headers})
        upstream = UpstreamRequest(self.endpoint.url_for(SUFFIXES[dialect]), headers, effective_bytes)
        recorded = {name: request.headers[name] for name in RECORDED_REQUEST_HEADERS if name in request.headers}
        call = _Call(
            call_id, dialect, span_id, bool(body.get("stream")), bound, submitted_sha, await self.recorder.payload(effective_bytes), recorded, upstream
        )
        try:
            self.attempt.require_active()  # after the last await: a revocation that began meanwhile has already swept `_inflight`
        except ServiceError:
            await self.admission.settle(call_id, Decimal(0), "not_dispatched")
            raise
        self.registry.open(call_id)
        self._inflight[call_id] = call
        await self.recorder.record(
            "gateway",
            "model_call.admitted",
            {
                "call_id": call_id,
                "dialect": dialect,
                "span_id": span_id,
                "run": run,
                "model": policy.model,
                "stream": call.stream,
                "ordinal": self._admitted,
                "bound_usd": str(bound),
                "output_cap": cap,
                "request_headers": recorded,
                "prompt": prompt_of(dialect, body),
                "submitted_request_sha256": submitted_sha,
                "effective_request_sha256": call.effective_sha,
            },
            [submitted_sha, call.effective_sha],
        )
        return call

    async def _reject(
        self, call_id: str, dialect: str | None, request: Request, error: ServiceError, span_id: str | None, submitted_sha: str | None, run: str | None = None
    ) -> None:
        await self.recorder.record(
            "gateway",
            "model_call.rejected",
            {
                "call_id": call_id,
                "dialect": dialect,
                "method": request.method,
                "path": request.url.path,
                "code": error.code,
                "message": error.message,
                "http_status": error.status,
                "requested_model": error.model if isinstance(error, PolicyRefused) else None,
                "span_id": span_id,
                "run": run,
                "admitted": False,
                "submitted_request_sha256": submitted_sha,
            },
            [submitted_sha] if submitted_sha else [],
        )

    async def unsupported(self, request: Request) -> Response:
        """A route outside the allowlist, such as SDK discovery or count endpoints: 404, recorded."""
        call_id = new_call_id()
        error = ServiceError(404, "unsupported_route", f"{request.method} {request.url.path} is not an allowlisted gateway route")
        await self._reject(call_id, None, request, error, None, None)
        return error_response(error, call_id)

    # ---- revocation -----------------------------------------------------------------------------------------------

    def abort_all(self) -> None:
        for call in list(self._inflight.values()):
            call.abort("revoked")

    async def wait_inflight(self, timeout: float) -> None:
        """Wait until every admitted model call has concluded; raises `TimeoutError` when one has not within ``timeout`` seconds."""
        with anyio.fail_after(timeout):
            while self._inflight:
                await anyio.sleep(0.01)

    # ---- conclusion -----------------------------------------------------------------------------------------------

    def publish(self, call: _Call, state: _State) -> None:
        """Make the call's outcome visible to the rest of the attempt: its tool proposals become callable and the first-prompt
        requirement is met. No I/O, so the relay does it before the last byte reaches the harness."""
        if state.published:
            return
        state.published = True
        terminal = state.terminal or "internal_error"
        assembled = state.assembled
        if assembled is not None and state.usage is None:
            try:
                state.usage = usage_for(call.dialect, assembled)
            except MalformedUsageError as error:
                state.usage_error = str(error)
        if not state.maybe_reached:
            state.usage = NOT_DISPATCHED
        proposals = assembled.tool_proposals if assembled is not None and terminal == "completed" else ()
        registered = {entry["tool_call_id"] for entry in state.registrations}
        for proposal in proposals:
            if proposal.call_id not in registered:
                state.registrations.append({"tool_call_id": proposal.call_id, "frame_index": proposal.completed_frame, "registered_ns": state.completed_ns, "early": False})
        self.registry.close(call.call_id, proposals)
        if terminal == "completed" and state.http_status is not None and 200 <= state.http_status < 300:
            self._prompt_satisfied = True

    async def conclude(self, call: _Call, state: _State) -> None:
        """Settle or mark the reservation and record the response evidence. Runs after the response was handed to the harness."""
        try:
            await self._conclude(call, state)
        finally:
            # Concluded only once its evidence is queued, so a revocation's flush includes it.
            self._inflight.pop(call.call_id, None)

    async def _conclude(self, call: _Call, state: _State) -> None:
        self.publish(call, state)
        terminal = state.terminal or "internal_error"
        assembled = state.assembled
        proposals = assembled.tool_proposals if assembled is not None and terminal == "completed" else ()
        # The response is journaled before the settlement round trip, which can be slow, so a paid call is never lost from it.
        settlement, commit = self._settlement(call, state, terminal)
        payloads = [call.submitted_sha, call.effective_sha]
        data: dict[str, Any] = {
            "call_id": call.call_id,
            "dialect": call.dialect,
            "span_id": call.span_id,
            "terminal": terminal,
            "http_status": state.http_status,
            "response_headers": state.headers,
            "dispatched_ns": state.dispatched_ns,
            "headers_ns": state.headers_ns,
            "first_byte_ns": state.first_byte_ns,
            "completed_ns": state.completed_ns,
            "delivered_ns": state.delivered_ns,
            "maybe_reached_upstream": state.maybe_reached,
            "error": state.error,
            "settlement": settlement,
            "usage": jsonable(state.usage),
            "usage_error": state.usage_error,
            "proposals": [jsonable(proposal) for proposal in proposals],
            "registrations": state.registrations,
        }
        if assembled is not None:
            data.update(
                response_id=assembled.response_id,
                generation_id=assembled.generation_id or state.headers.get("x-generation-id"),
                requested_model=assembled.requested_model,
                resolved_model=assembled.resolved_model,
                provider=assembled.provider,
                finish_reason=assembled.finish_reason,
                assembled_status=assembled.status,
                assembled_error=assembled.error,
            )
        else:
            data["generation_id"] = state.headers.get("x-generation-id")
        if state.raw:
            raw_sha = await self.recorder.payload(bytes(state.raw))
            payloads.append(raw_sha)
            if state.frames:
                offsets, position = [], 0
                for frame, available, delivered in zip(state.frames, state.frame_ns, state.frame_delivered_ns, strict=True):
                    offsets.append(
                        {"index": frame.index, "offset": position, "bytes": frame.byte_length, "available_ns": available, "delivered_ns": delivered, "event": frame.event}
                    )
                    position += frame.byte_length
                index_sha = await self.recorder.json_payload(offsets)
                payloads.append(index_sha)
                data.update(frame_count=len(state.frames), stream_payload_sha256=raw_sha, frames_payload_sha256=index_sha, stream_parse_error=state.parse_error)
            else:
                data["response_payload_sha256"] = raw_sha
        await self.recorder.record("gateway", "model_call.response", data, payloads)
        try:
            await commit()
        except Exception as error:
            # The response event above says what was meant to happen; this says it did not.
            await self.recorder.record("gateway", "model_call.settlement_failed", {"call_id": call.call_id, "settlement": settlement, "error": type(error).__name__})
            raise

    def _settlement(self, call: _Call, state: _State, terminal: str) -> tuple[dict[str, Any], Callable[[], Awaitable[None]]]:
        """What to do with the reservation, as the record of it and the admission call that carries it out."""
        usage, status = state.usage, state.http_status
        cost = usage.cost_usd if usage is not None else None
        if not state.maybe_reached:
            return {"action": "settled", "cost_usd": "0", "provenance": "not_dispatched"}, partial(self.admission.settle, call.call_id, Decimal(0), "not_dispatched")
        if terminal == "http_error" and status is not None and status < 500:
            provenance = f"http_{status}"
            return {"action": "settled", "cost_usd": "0", "provenance": provenance}, partial(self.admission.settle, call.call_id, Decimal(0), provenance)
        if terminal in ("completed", "failed", "incomplete", "error") and usage is not None and (cost is not None or terminal == "completed"):
            record = {"action": "settled", "cost_usd": None if cost is None else str(cost), "provenance": usage.provenance}
            return record, partial(self.admission.settle, call.call_id, cost, usage.provenance)
        return {"action": "uncertain", "cost_usd": None, "provenance": terminal}, partial(self.admission.mark_uncertain, call.call_id)


class _Relay:
    """The ASGI response of one admitted call: dispatches, relays as bytes arrive, watches for the client leaving."""

    def __init__(self, gateway: Gateway, call: _Call) -> None:
        self.gateway = gateway
        self.call = call
        self.state = _State()
        self._started = False
        self._concluded = False

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async with anyio.create_task_group() as group:
            group.start_soon(self._watch, receive)
            try:
                await self._run(send)
            finally:
                await self._conclude()
                group.cancel_scope.cancel()

    async def _watch(self, receive: Receive) -> None:
        while True:
            if (await receive())["type"] == "http.disconnect":
                self.call.abort("client_disconnected")
                return

    async def _conclude(self) -> None:
        if not self._concluded:
            self._concluded = True
            # Shielded: concluding runs from `finally` blocks, including when the handler itself was cancelled.
            with anyio.CancelScope(shield=True):
                await self.gateway.conclude(self.call, self.state)

    def _clock(self) -> int:
        return self.gateway.attempt.clock_ns()

    def _aborted_terminal(self) -> str:
        return self.call.abort_reason or "interrupted"

    async def _read(self, chunks: AsyncIterator[bytes]) -> object:
        """The next chunk, `END`, or `ABORTED` when revocation or the client's departure cancelled the wait."""
        with anyio.CancelScope() as scope:
            self.call.scope = scope
            if self.call.abort_reason:
                scope.cancel()
            try:
                return await anext(chunks)
            except StopAsyncIteration:
                return END
        return ABORTED

    async def _send(self, send: Send, message: dict[str, Any]) -> None:
        if self.call.abort_reason == "client_disconnected":
            return
        try:
            await send(message)
        except OSError:
            self.call.abort("client_disconnected")

    def _headers(self, upstream_headers: Mapping[str, str], extra: Mapping[str, str] | None = None) -> list[tuple[bytes, bytes]]:
        kept = {name: upstream_headers[name] for name in ALLOWED_RESPONSE_HEADERS if name in upstream_headers}
        kept.update(extra or {})
        kept[CALL_HEADER.lower()] = self.call.call_id
        return [(name.encode(), value.encode()) for name, value in kept.items()]

    async def _reply_error(self, send: Send, error: ServiceError) -> None:
        if self._started:
            return
        self._started = True
        response = error_response(error, self.call.call_id, anthropic=self.call.dialect == "anthropic_messages")
        await self._send(send, {"type": "http.response.start", "status": response.status_code, "headers": response.raw_headers})
        await self._send(send, {"type": "http.response.body", "body": response.body})

    async def _run(self, send: Send) -> None:
        state, call, gateway = self.state, self.call, self.gateway
        recorder = gateway.recorder
        state.dispatched_ns = self._clock()
        await recorder.record(
            "gateway",
            "model_call.dispatched",
            {
                "call_id": call.call_id,
                "span_id": call.span_id,
                "endpoint": {"label": gateway.endpoint.label, "mode": gateway.endpoint.mode, "destination": gateway.endpoint.destination},
                "url": call.upstream.url,
                "effective_request_sha256": call.effective_sha,
            },
            [call.effective_sha],
        )
        upstream: UpstreamResponse | None = None
        try:
            upstream = await self._open()
            if upstream is None:
                state.terminal = self._aborted_terminal()
                if call.abort_reason == "revoked":
                    await self._reply_error(send, ServiceError(403, "revoked", "the attempt's service admission was revoked"))
                return
            state.http_status, state.headers, state.headers_ns = upstream.status, {n: upstream.headers[n] for n in ALLOWED_RESPONSE_HEADERS if n in upstream.headers}, self._clock()
            if upstream.status == 200 and call.stream and upstream.headers.get("content-type", "").startswith("text/event-stream"):
                await self._relay_stream(upstream, send)
            else:
                await self._relay_body(upstream, send)
        except UpstreamError as error:
            state.terminal, state.error, state.maybe_reached = "transport_error", str(error), error.maybe_reached
            state.completed_ns = self._clock()
            self.gateway.publish(call, state)
            if self._started:
                await self._send(send, {"type": "http.response.body", "body": b""})
            else:
                await self._reply_error(send, ServiceError(502, "upstream_unreachable" if not error.maybe_reached else "upstream_failed", str(error)))
            state.delivered_ns = self._clock()
            await self._conclude()
        finally:
            if upstream is not None:
                with anyio.CancelScope(shield=True):
                    await upstream.aclose()

    async def _open(self) -> UpstreamResponse | None:
        if self.call.abort_reason:
            self.state.maybe_reached = False  # revoked before the request was sent: nothing reached upstream, so nothing is owed
            return None
        with anyio.CancelScope() as scope:
            self.call.scope = scope
            return await self.gateway.transport.send(self.call.upstream)
        return None

    async def _relay_stream(self, upstream: UpstreamResponse, send: Send) -> None:
        state, call = self.state, self.call
        self._started = True
        await self._send(send, {"type": "http.response.start", "status": 200, "headers": self._headers(upstream.headers)})
        decoder, chunks = SseDecoder(), upstream.chunks()
        while True:
            chunk = await self._read(chunks)
            if chunk is ABORTED or call.abort_reason:
                state.completed_ns = self._clock()
                assembled = assemble_stream(call.dialect, state.frames, upstream.headers, self.gateway.attempt.policy.model) if state.parse_error is None else None
                if assembled is not None and assembled.terminal_frame is not None:
                    # Its terminal event had arrived, so the response is whole: Codex hangs up on response.completed, before
                    # the stream's end.
                    state.assembled, state.terminal = assembled, assembled.status
                else:
                    state.terminal = self._aborted_terminal()
                self.gateway.publish(call, state)
                # End the stream; one cut before its terminal event the harness treats as cut.
                await self._send(send, {"type": "http.response.body", "body": b""})
                state.delivered_ns = self._clock()
                await self._conclude()
                return
            if chunk is END:
                break
            assert isinstance(chunk, bytes)
            now = self._clock()
            new_frames = 0
            state.first_byte_ns = state.first_byte_ns or now
            state.raw += chunk
            if state.parse_error is None:
                try:
                    new = decoder.feed(chunk)
                except MalformedCaptureError as error:
                    state.parse_error = str(error)
                else:
                    state.frames += new
                    state.frame_ns += [now] * len(new)
                    state.frame_delivered_ns += [None] * len(new)
                    # Registered before the chunk reaches the harness, so a tool it launches on this frame finds its proposal.
                    await self._register_early(new, upstream.headers, now)
                    new_frames = len(new)
            # Forwarded as it arrived; nothing is journaled on this path.
            await self._send(send, {"type": "http.response.body", "body": chunk, "more_body": True})
            if new_frames:
                delivered = self._clock()
                state.frame_delivered_ns[-new_frames:] = [delivered] * new_frames
        state.completed_ns = self._clock()
        if state.parse_error is not None:
            state.terminal, state.error = "malformed_response", state.parse_error
        else:
            state.assembled = assemble_stream(call.dialect, state.frames, upstream.headers, self.gateway.attempt.policy.model)
            state.terminal = "interrupted" if decoder.pending else state.assembled.status
        # Published before the stream is closed so a harness acting on the response finds its proposals registered; the
        # evidence is journaled after, off the harness's path.
        self.gateway.publish(call, state)
        await self._send(send, {"type": "http.response.body", "body": b""})
        state.delivered_ns = self._clock()
        await self._conclude()

    async def _register_early(self, new: Sequence[SseFrame], headers: Mapping[str, str], now: int) -> None:
        state, call = self.state, self.call
        if not any(_may_complete(call.dialect, frame) for frame in new):
            return
        try:
            partial = assemble_stream(call.dialect, state.frames, headers, self.gateway.attempt.policy.model)
        except MalformedCaptureError:
            return  # the final assembly reports it
        for proposal in partial.tool_proposals:
            if proposal.call_id is not None and proposal.completed_frame is not None and not any(r["tool_call_id"] == proposal.call_id for r in state.registrations):
                self.gateway.registry.register(call.call_id, proposal)
                state.registrations.append({"tool_call_id": proposal.call_id, "frame_index": proposal.completed_frame, "registered_ns": now, "early": True})

    async def _relay_body(self, upstream: UpstreamResponse, send: Send) -> None:
        state, call = self.state, self.call
        chunks, body = upstream.chunks(), bytearray()
        while True:
            chunk = await self._read(chunks)
            if chunk is ABORTED or call.abort_reason:
                state.terminal = self._aborted_terminal()
                state.completed_ns = self._clock()
                self.gateway.publish(call, state)
                if call.abort_reason == "revoked":
                    await self._reply_error(send, ServiceError(403, "revoked", "the attempt's service admission was revoked"))
                    state.delivered_ns = self._clock()
                return
            if chunk is END:
                break
            assert isinstance(chunk, bytes)
            state.first_byte_ns = state.first_byte_ns or self._clock()
            body += chunk
            if len(body) > MAX_RESPONSE_BYTES:
                state.terminal, state.error, state.completed_ns = "malformed_response", f"response exceeds {MAX_RESPONSE_BYTES} bytes", self._clock()
                self.gateway.publish(call, state)
                await self._reply_error(send, ServiceError(502, "response_too_large", state.error))
                state.delivered_ns = self._clock()
                return
        state.completed_ns = self._clock()
        state.raw = body
        status = upstream.status
        if not 200 <= status < 300:
            state.terminal = "http_error"
        else:
            try:
                state.assembled = assemble_body(call.dialect, decode_json_object(bytes(body), MAX_RESPONSE_BYTES), upstream.headers, self.gateway.attempt.policy.model)
                state.terminal = state.assembled.status
            except (ContractError, MalformedCaptureError, KeyError, TypeError, AttributeError) as error:
                state.terminal, state.error = "malformed_response", f"{type(error).__name__}: {error}"
        self.gateway.publish(call, state)
        self._started = True
        await self._send(send, {"type": "http.response.start", "status": status, "headers": self._headers(upstream.headers, {"content-length": str(len(body))})})
        await self._send(send, {"type": "http.response.body", "body": bytes(body)})
        state.delivered_ns = self._clock()

