"""Assembles one attempt's services (gateway, tool broker, command service, event intake) into an ASGI app."""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any

import anyio
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from nanoagent.uploaded.attempt import CALL_HEADER, Attempt, AttemptPolicy, ServiceError, error_response, from_contract, new_call_id
from nanoagent.uploaded.broker import ToolBroker, ToolRunner
from nanoagent.uploaded.contract import ContractError, decode_json_object
from nanoagent.uploaded.endpoint import EndpointProfile
from nanoagent.uploaded.events import EventError, HarnessEventLog
from nanoagent.uploaded.evidence import Journal, Recorder
from nanoagent.uploaded.execservice import CommandRunner, ExecService
from nanoagent.uploaded.gateway import SUFFIXES, Admission, Gateway, HttpxTransport, ProposalRegistry, UpstreamTransport
from nanoagent.uploaded.rush_worker import RushError
from nanoagent.uploaded.source import SourceLimits, inspect_zip

API = "/api/v1"
# Event errors that mean the same event arrived with conflicting content.
CONFLICTS = {"conflicting_duplicate"}
# What a harness saved from the attempt may weigh: what RUSH takes of a source upload (BENCHMARK_SOURCE_MAX_BYTES's default).
MAX_HARNESS_BYTES = 50 << 20


class AttemptServices:
    """One service instance per attempt. ``app`` serves `/api/v1/{chat/completions,responses,messages}`, `/tools`, `/exec`, `/events`,
    and, given ``save_harness``, `/harness`: a harness ZIP the attempt saves as its member's (`rush save` in the RUSH terminal),
    checked as a source is and handed to ``save_harness``, whose answer (RUSH's) it returns; and, given ``install_cli``, `/cli`:
    {"name", "expect"} installs a terminal CLI (nanoagent.uploaded.clis), answered with ``install_cli``'s events, one JSON line each."""

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
        proposal_wait_s: float = 30.0,
        save_harness: Callable[[bytes], Awaitable[Mapping[str, Any]]] | None = None,
        install_cli: Callable[[str, str | None], AsyncIterator[Mapping[str, Any]]] | None = None,
    ) -> None:
        recorder = Recorder(journal, clock_ns, [policy.token, endpoint.api_key])
        self.attempt = Attempt(policy, recorder, workspace, clock_ns)
        self.registry = ProposalRegistry()
        self._owned_transport = transport is None
        self.transport = transport or HttpxTransport()
        self.gateway = Gateway(self.attempt, endpoint, admission, self.transport, self.registry)
        self.broker = ToolBroker(self.attempt, tool_runner, self.registry, proposal_wait_s=proposal_wait_s)
        self.exec = ExecService(self.attempt, command_runner)
        self.events = HarnessEventLog()
        self._received: set[tuple[str, int]] = set()
        routes = [Route(API + suffix, self._generation(dialect), methods=["POST"]) for dialect, suffix in SUFFIXES.items()]
        self._save_harness = save_harness
        if save_harness is not None:
            routes.append(Route("/harness", self._harness, methods=["POST"]))
        self._install_cli = install_cli
        if install_cli is not None:
            routes.append(Route("/cli", self._cli, methods=["POST"]))
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

    async def _harness(self, request: Request) -> Response:
        assert self._save_harness is not None
        try:
            self.attempt.require_auth(request)
            self.attempt.require_active()
            data = bytearray()
            async for chunk in request.stream():
                data += chunk
                if len(data) > MAX_HARNESS_BYTES:
                    raise ServiceError(413, "source_too_large", f"a saved harness is at most {MAX_HARNESS_BYTES} bytes")
            try:
                inspect_zip(bytes(data), SourceLimits())  # what its build would refuse is refused now, with the same reason
            except ContractError as error:
                raise ServiceError(422, error.code, error.message) from error
            try:
                saved = await self._save_harness(bytes(data))
            except RushError as error:
                raise ServiceError(error.status, error.code, error.message) from error
        except ServiceError as error:
            return error_response(error)
        return JSONResponse(dict(saved))

    async def _cli(self, request: Request) -> Response:
        assert self._install_cli is not None
        try:
            self.attempt.require_auth(request)
            self.attempt.require_active()
            try:
                body = decode_json_object(await request.body())
            except ContractError as error:
                raise ServiceError(400, error.code, error.message) from error
            name, expect = body.get("name"), body.get("expect")
            if not isinstance(name, str) or not (expect is None or isinstance(expect, str)):
                raise ServiceError(400, "invalid_request", "a CLI install takes a name and, from a saved harness, the install it expects")
        except ServiceError as error:
            return error_response(error)
        events = self._install_cli(name, expect)
        return StreamingResponse((json.dumps(dict(event)) + "\n" async for event in events), media_type="application/x-ndjson")

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
                raise ServiceError(409 if error.code in CONFLICTS else 422, error.code, error.message) from error
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
