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

API = "/api/v1"
# Event errors that mean the same event arrived with conflicting content.
CONFLICTS = {"conflicting_duplicate"}
RUN_ACTIONS = ("prompt", "start", "title", "end")  # a `rush <command>` run's requests (`/runs/<action>`)


class AttemptServices:
    """One service instance per attempt. ``app`` serves `/api/v1/{chat/completions,responses,messages}`, `/tools`, `/exec`, `/events`,
    and, given ``install_cli``, `/cli`: {"name"} installs a terminal CLI (nanoagent.uploaded.clis), answered with ``install_cli``'s
    events, one JSON line each; and, given ``rush_run``, `/runs/<action>` (RUN_ACTIONS): a JSON object for one of a Terminal session's
    `rush <command>` runs (the shell's rush.py), handed to ``rush_run`` with its action and answered with what it returns; and, given
    ``start_tools``, `/tools/start`: the plugin's tools started for a Terminal session's `nanoagent`, answered with ``start_tools``'s
    {token, system, tools}, the token the one the broker then serves them to."""

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
        install_cli: Callable[[str], AsyncIterator[Mapping[str, Any]]] | None = None,
        rush_run: Callable[[str, Mapping[str, Any]], Awaitable[Mapping[str, Any]]] | None = None,
        start_tools: Callable[[], Awaitable[Mapping[str, Any]]] | None = None,
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
        self._install_cli = install_cli
        if install_cli is not None:
            routes.append(Route("/cli", self._cli, methods=["POST"]))
        self._rush_run = rush_run
        if rush_run is not None:
            routes.append(Route("/runs/{action}", self._run, methods=["POST"]))
        self._start_tools = start_tools
        if start_tools is not None:
            routes.append(Route("/tools/start", self._tools_start, methods=["POST"]))
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

    async def _cli(self, request: Request) -> Response:
        assert self._install_cli is not None
        try:
            self.attempt.require_auth(request)
            self.attempt.require_active()
            try:
                body = decode_json_object(await request.body())
            except ContractError as error:
                raise ServiceError(400, error.code, error.message) from error
            name = body.get("name")
            if not isinstance(name, str):
                raise ServiceError(400, "invalid_request", "a CLI install takes a name")
        except ServiceError as error:
            return error_response(error)
        events = self._install_cli(name)
        return StreamingResponse((json.dumps(dict(event)) + "\n" async for event in events), media_type="application/x-ndjson")

    async def _run(self, request: Request) -> Response:
        assert self._rush_run is not None
        try:
            self.attempt.require_auth(request)
            self.attempt.require_active()
            action = request.path_params["action"]
            if action not in RUN_ACTIONS:
                raise ServiceError(404, "not_found", f"a run's requests are {', '.join(RUN_ACTIONS)}")
            try:
                body = decode_json_object(await request.body())
            except ContractError as error:
                raise ServiceError(400, error.code, error.message) from error
            try:
                answer = await self._rush_run(action, body)
            except RushError as error:
                raise ServiceError(error.status, error.code, error.message) from error
        except ServiceError as error:
            return error_response(error)
        return JSONResponse(dict(answer))

    async def _tools_start(self, request: Request) -> Response:
        assert self._start_tools is not None
        try:
            self.attempt.require_auth(request)
            self.attempt.require_active()
            try:
                started = await self._start_tools()
            except RushError as error:
                raise ServiceError(error.status, error.code, error.message) from error
        except ServiceError as error:
            return error_response(error)
        return JSONResponse(dict(started))

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
