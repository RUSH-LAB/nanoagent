"""Assembles one attempt's services (gateway, tool broker, command service, event intake) into an ASGI app."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

import anyio
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from nanoagent.uploaded.attempt import CALL_HEADER, Attempt, AttemptPolicy, ServiceError, error_response, from_contract, new_call_id
from nanoagent.uploaded.broker import ToolBroker, ToolRunner
from nanoagent.uploaded.contract import ContractError, decode_json_object
from nanoagent.uploaded.endpoint import EndpointProfile
from nanoagent.uploaded.events import EventError, HarnessEventLog
from nanoagent.uploaded.evidence import Journal, Recorder
from nanoagent.uploaded.execservice import CommandRunner, ExecService
from nanoagent.uploaded.gateway import SUFFIXES, Admission, Gateway, HttpxTransport, ProposalRegistry, UpstreamTransport

API = "/api/v1"


class AttemptServices:
    """One service instance per attempt. ``app`` serves `/api/v1/{chat/completions,responses,messages}`, `/tools`, `/exec`, `/events`."""

    def __init__(
        self,
        *,
        policy: AttemptPolicy,
        endpoint: EndpointProfile,
        admission: Admission,
        journal: Journal,
        tool_runner: ToolRunner,
        command_runner: CommandRunner,
        workspace: Path,
        transport: UpstreamTransport | None = None,
        clock_ns: Callable[[], int] = time.monotonic_ns,
        lease_lapsed: Callable[[], bool] = lambda: False,
        proposal_wait_s: float = 30.0,
    ) -> None:
        recorder = Recorder(journal, clock_ns, [policy.token, endpoint.api_key])
        self.attempt = Attempt(policy, recorder, workspace, clock_ns, lease_lapsed)
        self.registry = ProposalRegistry()
        self._owned_transport = transport is None
        self.transport = transport or HttpxTransport()
        self.gateway = Gateway(self.attempt, endpoint, admission, self.transport, self.registry)
        self.broker = ToolBroker(self.attempt, tool_runner, self.registry, proposal_wait_s=proposal_wait_s)
        self.exec = ExecService(self.attempt, command_runner)
        self.events = HarnessEventLog()
        self._received: set[tuple[str, int]] = set()
        routes = [Route(API + suffix, self._generation(dialect), methods=["POST"]) for dialect, suffix in SUFFIXES.items()]
        routes += [
            Route("/tools", self.broker.handle, methods=["POST"]),
            Route("/exec", self.exec.handle, methods=["POST"]),
            Route("/events", self._event, methods=["POST"]),
            Route("/{path:path}", self.gateway.unsupported, methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
        ]
        self.app = Starlette(routes=routes, lifespan=self._lifespan)

    @asynccontextmanager
    async def _lifespan(self, app: Starlette) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await self.aclose()

    async def aclose(self) -> None:
        try:
            await self.attempt.recorder.aclose()
        finally:
            if self._owned_transport:
                await self.transport.aclose()  # type: ignore[attr-defined]

    async def flush(self) -> None:
        """Wait until all evidence recorded so far is in the journal; raises if a background write failed."""
        await self.attempt.recorder.flush()

    def _generation(self, dialect: str) -> Callable[[Request], object]:
        async def handle(request: Request) -> Response:
            return await self.gateway.handle(request, dialect)

        return handle

    async def revoke(self, drain_timeout: float = 10.0) -> None:
        """Reject new calls, abort in-flight model calls and tool/exec work, wait (bounded) for that work to drain, then
        for the evidence it recorded to reach the journal."""
        self.attempt.revoked = True
        self.gateway.abort_all()
        self.attempt.cancel_tracked()
        await self.attempt.drain(drain_timeout)
        await self.gateway.wait_inflight(drain_timeout)
        with anyio.fail_after(drain_timeout):
            await self.flush()

    async def _event(self, request: Request) -> Response:
        received_ns = self.attempt.clock_ns()  # before anything is journaled: the event's time is when it arrived
        recorder, call_id, span_id = self.attempt.recorder, new_call_id(), None
        try:
            self.attempt.require_auth(request)
            span_id = self.attempt.span_id(request)
            self.attempt.require_active()
            raw = await self.attempt.read_body(request)
            try:
                event = decode_json_object(raw, self.attempt.policy.max_request_bytes)
                receipt = self.events.accept(event)
            except EventError as error:
                # conflicting_duplicate means the same event arrived with conflicting content.
                raise ServiceError(409 if error.code == "conflicting_duplicate" else 422, error.code, error.message) from error
            except ContractError as error:
                raise from_contract(error) from error
        except ServiceError as error:
            await recorder.record("harness", "harness.rejected", {"call_id": call_id, "code": error.code, "message": error.message, "http_status": error.status, "span_id": span_id})
            return error_response(error, call_id)
        key = (receipt.emitter_id, receipt.sequence)
        if key not in self._received:
            self._received.add(key)
            sha = await recorder.payload(raw)
            await recorder.record(
                "harness",
                "harness.event",
                {"origin": "harness", "received_ns": received_ns, "span_id": span_id, "event_sha256": sha, "event": event["event"], "receipt": asdict(receipt)},
                [sha],
            )
        return JSONResponse(asdict(receipt), headers={CALL_HEADER: call_id})
