"""ASGI routes for the NanoAgent server integration API."""

from __future__ import annotations

import json
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from nanoagent.web.config import WebConfig
from nanoagent.web.runtime import RunHost, ValidationError, validate_run_request


def _sse(event: dict[str, Any]) -> bytes:
    return (
        f"event: {event['type']}\n"
        f"data: {json.dumps(event, separators=(',', ':'), default=str)}\n\n"
    ).encode()


def create_app(cfg: WebConfig, *, host: RunHost | None = None) -> Any:
    """Build the Starlette application, importing the optional dependency only when used."""
    try:
        from starlette.applications import Starlette
        from starlette.requests import Request
        from starlette.responses import JSONResponse, StreamingResponse
        from starlette.routing import Route
    except ImportError as error:  # pragma: no cover - depends on installation extras
        raise RuntimeError('NanoAgent web support requires `pip install "nanoagent[web]"`') from error

    run_host = host or RunHost(cfg)

    def authorized(request: Request) -> bool:
        if cfg.api_token is None:
            return True
        return secrets.compare_digest(
            request.headers.get("authorization", ""), f"Bearer {cfg.api_token}"
        )

    async def health(_request: Request) -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "service": "nanoagent",
                "apiVersion": "v1",
                "activeRuns": run_host.active_count,
                "maxConcurrency": cfg.max_concurrency,
                "harness": run_host.runner_name,
                "capabilities": run_host.capabilities,
            }
        )

    async def profiles(request: Request) -> JSONResponse:
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return JSONResponse(run_host.profiles)

    async def start_run(request: Request) -> JSONResponse | StreamingResponse:
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > cfg.max_request_bytes:
            return JSONResponse({"error": "request body is too large"}, status_code=413)
        body = await request.body()
        if len(body) > cfg.max_request_bytes:
            return JSONResponse({"error": "request body is too large"}, status_code=413)
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return JSONResponse({"error": "request body must be valid JSON"}, status_code=400)
        try:
            active = await run_host.start(validate_run_request(payload))
        except ValidationError as error:
            return JSONResponse({"error": str(error)}, status_code=400)

        async def stream() -> AsyncIterator[bytes]:
            async for event in active.events():
                yield b": heartbeat\n\n" if event is None else _sse(event)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-NanoAgent-API-Version": "v1",
                "X-NanoAgent-Run-Id": active.id,
            },
        )

    async def cancel_run(request: Request) -> JSONResponse:
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        run_id = request.path_params["run_id"]
        if not run_host.cancel(run_id):
            return JSONResponse({"error": "run not found"}, status_code=404)
        return JSONResponse({"id": run_id, "cancelled": True}, status_code=202)

    @asynccontextmanager
    async def lifespan(_app: Any) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await run_host.aclose()

    return Starlette(
        routes=[
            Route("/health", health, methods=["GET"]),
            Route("/v1/profiles", profiles, methods=["GET"]),
            Route("/v1/runs", start_run, methods=["POST"]),
            Route("/v1/runs/{run_id}", cancel_run, methods=["DELETE"]),
        ],
        lifespan=lifespan,
    )
