"""ASGI routes for the NanoAgent server integration API."""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from nanoagent.core.agent import ChatModel
from nanoagent.plugin import PluginManifest, call_tool_async, load_manifest
from nanoagent.runtime.config import load_config_args
from nanoagent.web.config import WebConfig
from nanoagent.web.plugin_agent import plugin_profile
from nanoagent.web.runtime import ActiveRun, RunHost, ValidationError, validate_run_request
from nanoagent.web.workspaces import Workspaces


def _sse(event: dict[str, Any]) -> bytes:
    return (
        f"event: {event['type']}\n"
        f"data: {json.dumps(event, separators=(',', ':'), default=str)}\n\n"
    ).encode()


def _plugin_entry(manifest: PluginManifest) -> dict[str, Any]:
    """The public manifest with its README and tool schemas inlined for remote viewers."""
    entry = manifest.public()
    entry["readme"] = (manifest.root / "README.md").read_text(encoding="utf-8")
    for tool, definition in zip(entry["tools"], manifest.tools, strict=True):
        tool["inputSchema"] = definition.input
        tool["outputSchema"] = definition.output
    return entry


def create_app(
    cfg: WebConfig, *, host: RunHost | None = None, plugin_model: ChatModel | None = None
) -> Any:
    """Build the Starlette application, importing the optional dependency only when used.

    ``plugin_model`` answers plugin prompts; by default the configured ``model``, built on the
    first one.
    """
    try:
        from starlette.applications import Starlette
        from starlette.requests import Request
        from starlette.responses import FileResponse, JSONResponse, StreamingResponse
        from starlette.routing import Route
    except ImportError as error:  # pragma: no cover - depends on installation extras
        raise RuntimeError('NanoAgent web support requires `pip install "nanoagent[web]"`') from error

    run_host = host or RunHost(cfg)
    plugins: dict[str, PluginManifest] = {}
    for path in cfg.plugins:
        manifest = load_manifest(path)
        if manifest.id in plugins:
            raise ValueError(f"duplicate plugin id {manifest.id!r} in {path!r}")
        plugins[manifest.id] = manifest
    plugin_catalog = {"plugins": [_plugin_entry(manifest) for manifest in plugins.values()]}
    plugin_slots = asyncio.Semaphore(cfg.max_concurrency)
    workspaces = Workspaces(cfg.workspaces)
    owned_model: Any = None

    def model_for_plugins() -> ChatModel:
        nonlocal owned_model
        if plugin_model is not None:
            return plugin_model
        if owned_model is None:
            from nanoagent.runtime.model import Model

            owned_model = Model.from_config(cfg.model)
        return owned_model

    def authorized(request: Request) -> bool:
        if cfg.api_token is None:
            return True
        return secrets.compare_digest(
            request.headers.get("authorization", ""), f"Bearer {cfg.api_token}"
        )

    async def read_json(request: Request) -> tuple[Any, JSONResponse | None]:
        """The bounded JSON body, or the response rejecting it."""
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > cfg.max_request_bytes:
            return None, JSONResponse({"error": "request body is too large"}, status_code=413)
        body = await request.body()
        if len(body) > cfg.max_request_bytes:
            return None, JSONResponse({"error": "request body is too large"}, status_code=413)
        try:
            return json.loads(body), None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, JSONResponse({"error": "request body must be valid JSON"}, status_code=400)

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
        payload, rejected = await read_json(request)
        if rejected is not None:
            return rejected
        try:
            active = await run_host.start(validate_run_request(payload))
        except ValidationError as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        return run_stream(active)

    async def start_plugin_run(request: Request) -> JSONResponse | StreamingResponse:
        """Run a prompt with an agent that operates one plugin inside a caller's workspace."""
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        manifest = plugins.get(request.path_params["plugin_id"])
        if manifest is None:
            return JSONResponse({"error": "plugin not found"}, status_code=404)
        try:
            folder = workspaces.folder(request.path_params["workspace_id"], create=True)
        except ValueError as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        payload, rejected = await read_json(request)
        if rejected is not None:
            return rejected
        try:
            profile = plugin_profile(cfg, model_for_plugins(), manifest, folder)
            active = await run_host.start(validate_run_request(payload), runner_profile=profile)
        except ValidationError as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        return run_stream(active)

    async def list_files(request: Request) -> JSONResponse:
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            return JSONResponse(workspaces.files(request.path_params["workspace_id"]))
        except ValueError as error:
            return JSONResponse({"error": str(error)}, status_code=400)

    async def workspace_file(request: Request) -> Any:
        """GET sends a workspace file's bytes; DELETE removes it."""
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            path = workspaces.file(request.path_params["workspace_id"], request.path_params["path"])
        except ValueError as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        except FileNotFoundError:
            return JSONResponse({"error": "file not found"}, status_code=404)
        if request.method == "DELETE":
            path.unlink()
            return JSONResponse({"deleted": True})
        return FileResponse(path)

    def run_stream(active: ActiveRun) -> StreamingResponse:
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

    async def list_plugins(request: Request) -> JSONResponse:
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return JSONResponse(plugin_catalog)

    async def run_plugin_task(request: Request) -> JSONResponse:
        """Run a single-tool plugin task: the body is the tool's input, the reply its output."""
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        manifest = plugins.get(request.path_params["plugin_id"])
        if manifest is None:
            return JSONResponse({"error": "plugin not found"}, status_code=404)
        try:
            task = manifest.task(request.path_params["task_id"])
        except KeyError as error:
            return JSONResponse({"error": error.args[0]}, status_code=404)
        if task.runner != "tool":
            return JSONResponse(
                {"error": f"task {task.id!r} has runner {task.runner!r}; only tool tasks run directly"},
                status_code=400,
            )
        payload, rejected = await read_json(request)
        if rejected is not None:
            return rejected
        if not isinstance(payload, dict):
            return JSONResponse(
                {"error": "request body must be a JSON object of tool arguments"}, status_code=400
            )
        # Each request writes into its own workspace, removed once the reply is built: the
        # reply carries the tool's output, not the files.
        async with plugin_slots:
            try:
                with TemporaryDirectory(prefix=f"nanoagent-{manifest.id}-") as workspace:
                    output = await call_tool_async(
                        manifest,
                        task.tools[0],
                        payload,
                        workspace=Path(workspace),
                        timeout=cfg.request_timeout,
                    )
            except ValueError as error:
                return JSONResponse({"error": str(error)}, status_code=400)
            except (RuntimeError, TimeoutError) as error:
                return JSONResponse({"error": str(error) or "plugin run timed out"}, status_code=502)
        return JSONResponse(
            {"plugin": manifest.id, "task": task.id, "tool": task.tools[0], "output": output}
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
            if owned_model is not None:
                await owned_model.aclose()

    return Starlette(
        routes=[
            Route("/health", health, methods=["GET"]),
            Route("/v1/profiles", profiles, methods=["GET"]),
            Route("/v1/runs", start_run, methods=["POST"]),
            Route("/v1/runs/{run_id}", cancel_run, methods=["DELETE"]),
            Route("/v1/plugins", list_plugins, methods=["GET"]),
            Route(
                "/v1/workspaces/{workspace_id}/plugins/{plugin_id}/runs",
                start_plugin_run,
                methods=["POST"],
            ),
            Route("/v1/workspaces/{workspace_id}/files", list_files, methods=["GET"]),
            Route(
                "/v1/workspaces/{workspace_id}/files/{path:path}",
                workspace_file,
                methods=["GET", "DELETE"],
            ),
            Route(
                "/v1/plugins/{plugin_id}/tasks/{task_id}", run_plugin_task, methods=["POST"]
            ),
        ],
        lifespan=lifespan,
    )


_USAGE = "usage: nanoagent web web_cfg=<config.yaml> [dotted.key=value ...]"


def main(argv: list[str] | None = None) -> int:
    """Run NanoAgent as an internal HTTP/SSE service."""
    argv = list(sys.argv[1:]) if argv is None else list(argv)
    if not argv or argv[0] in {"-h", "--help"}:
        print(_USAGE)
        return 0 if argv else 2
    cfg = load_config_args(WebConfig, argv)
    try:
        import uvicorn
    except ImportError as error:
        raise SystemExit('nanoagent web requires `pip install "nanoagent[web]"`') from error

    # Prompts and tool output never belong in access logs. Runtime failures still carry a run id
    # through nanoagent.web.runtime's own logger.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    uvicorn.run(create_app(cfg), host=cfg.host, port=cfg.port, access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
