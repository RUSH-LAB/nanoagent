"""ASGI routes for the NanoAgent server integration API."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import secrets
import shutil
import sys
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from nanoagent.core.agent import ChatModel
from nanoagent.core.agent import Agent
from nanoagent.extensions import get_hooks
from nanoagent.plugin import PluginManifest, call_tool_async, load_listing
from nanoagent.plugin.manifest import TOOL_ARTIFACTS, load_manifest
from nanoagent.plugin.package import (
    PACKAGE_MAX_BYTES,
    SOURCE_MAX_BYTES,
    PackageError,
    catalog_entry,
    inspect_package,
    pack,
    pack_source,
)
from nanoagent.plugin.tasks import TaskOutcome, run_task
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


# How a host serves a plugin's front end: its own files only, and no network of its own, so the
# page reaches NanoAgent only through the host's `nanoagent.ui/v1` bridge. Who may frame the page
# is the host's to decide (its site and its API may be different origins), so there is no
# frame-ancestors here.
UI_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; form-action 'none'; "
    "base-uri 'none'"
)


def _staged_from(workspace: Path) -> Callable[[Path], None]:
    """How a web task stages its inputs: they are already the caller's workspace files, so the
    workspace needs nothing and the reference tool's scratch folder gets a copy of it."""

    def stage(folder: Path) -> None:
        if folder != workspace:
            shutil.copytree(workspace, folder, dirs_exist_ok=True)

    return stage


def _task_metrics(outcome: TaskOutcome, duration_s: float, model: str) -> dict[str, Any]:
    """What a finished task cost and how long it took; a tool task calls no model."""
    profile = outcome.agent.profile if outcome.agent is not None else None
    return {
        "model": model if profile is not None else None,
        "cost": profile.cost if profile is not None else 0.0,
        "usage": dict(profile.usage) if profile is not None else {},
        "ttft_s": profile.ttft_s if profile is not None else None,
        "generation_s": profile.generation_s if profile is not None else 0.0,
        "duration_s": duration_s,
    }


def _ui_version(manifest: PluginManifest) -> str:
    """A digest of the plugin's ``ui/``: its files' URLs carry it, so a browser may keep them forever."""
    ui = manifest.root / "ui"
    digest = hashlib.sha256()
    for path in sorted(ui.rglob("*")):
        if path.is_file() and not TOOL_ARTIFACTS & set(path.relative_to(ui).parts):
            digest.update(path.relative_to(ui).as_posix().encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()[:16]


def _ui_file(manifest: PluginManifest, path: str) -> Path | None:
    """The file ``path`` names in the plugin's ``ui/``, or None for anything outside it."""
    ui = (manifest.root / "ui").resolve()
    target = (ui / (path or "index.html")).resolve()
    if not target.is_relative_to(ui) or not target.is_file() or TOOL_ARTIFACTS & set(target.relative_to(ui).parts):
        return None
    return target


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
        from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
        from starlette.routing import Route
    except ImportError as error:  # pragma: no cover - depends on installation extras
        raise RuntimeError('NanoAgent web support requires `pip install "nanoagent[web]"`') from error

    run_host = host or RunHost(cfg)
    # Ready plugins run; in-development ones are only listed, as under maintenance.
    plugins: dict[str, PluginManifest] = {}
    ui_versions: dict[str, str] = {}
    in_development: dict[str, str] = {}
    listed: list[dict[str, Any]] = []
    for path in cfg.plugins:
        entry = load_listing(path)
        if entry.id in plugins or entry.id in in_development:
            raise ValueError(f"duplicate plugin id {entry.id!r} in {path!r}")
        if isinstance(entry, PluginManifest):
            plugins[entry.id] = entry
            ui_versions[entry.id] = _ui_version(entry)
            listed.append({**catalog_entry(entry), "uiVersion": ui_versions[entry.id]})
        else:
            in_development[entry.id] = entry.name
            listed.append(entry.public())
    plugin_catalog = {"plugins": listed}
    # Packages offered for download, packed once; they are never run here.
    packages: dict[str, tuple[dict[str, Any], bytes]] = {}
    for path in cfg.packages:
        manifest = load_manifest(path)
        if manifest.id in packages:
            raise ValueError(f"duplicate package id {manifest.id!r} in {path!r}")
        data = pack(manifest.root)
        packages[manifest.id] = (
            {**catalog_entry(manifest), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)},
            data,
        )
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
        if request.path_params["plugin_id"] in in_development:
            name = in_development[request.path_params["plugin_id"]]
            return JSONResponse({"error": f"{name} is under maintenance"}, status_code=409)
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

    def in_workspace(action: Callable[[], Any]) -> Any:
        """Run a workspace operation: its JSON result, or its failure's matching status."""
        try:
            result = action()
            return result if isinstance(result, FileResponse) else JSONResponse(result)
        except ValueError as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        except FileNotFoundError:
            return JSONResponse({"error": "not found"}, status_code=404)
        except FileExistsError as error:
            return JSONResponse({"error": f"{error.args[0]} already exists"}, status_code=409)

    async def list_files(request: Request) -> JSONResponse:
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        workspace_id = request.path_params["workspace_id"]
        return in_workspace(lambda: workspaces.files(workspace_id))

    async def workspace_file(request: Request) -> Any:
        """GET sends a file's bytes; PUT saves the body as the file (``?create=1`` refuses to
        replace one); DELETE removes it (COMPAT(mochi-workspace-edits))."""
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        workspace_id, path = request.path_params["workspace_id"], request.path_params["path"]
        if request.method == "GET":
            return in_workspace(lambda: FileResponse(workspaces.file(workspace_id, path)))
        if request.method == "DELETE":
            return in_workspace(lambda: workspaces.delete_file(workspace_id, path))
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > cfg.max_file_bytes:
            return JSONResponse({"error": "file is too large"}, status_code=413)
        body = await request.body()
        if len(body) > cfg.max_file_bytes:
            return JSONResponse({"error": "file is too large"}, status_code=413)
        create = request.query_params.get("create") == "1"
        return in_workspace(lambda: workspaces.write(workspace_id, path, body, create=create))

    # COMPAT(mochi-workspace-edits): Mochi on production deletes files, makes and deletes folders,
    # and moves entries in a workspace. Remove these routes once the Mochi that only saves files
    # and removes whole workspaces is released.
    async def workspace_folder(request: Request) -> JSONResponse:
        """POST makes the folder (and its parents); DELETE removes it and everything in it."""
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        workspace_id, path = request.path_params["workspace_id"], request.path_params["path"]
        if request.method == "POST":
            return in_workspace(lambda: workspaces.make_folder(workspace_id, path))
        return in_workspace(lambda: workspaces.delete_folder(workspace_id, path))

    async def move_entry(request: Request) -> JSONResponse:
        """Rename or move a file or folder: the body is ``{"from": path, "to": path}``."""
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        payload, rejected = await read_json(request)
        if rejected is not None:
            return rejected
        if (
            not isinstance(payload, dict)
            or set(payload) != {"from", "to"}
            or not all(isinstance(payload[key], str) for key in ("from", "to"))
        ):
            return JSONResponse({"error": 'body must be {"from": path, "to": path}'}, status_code=400)
        workspace_id = request.path_params["workspace_id"]
        return in_workspace(lambda: workspaces.move(workspace_id, payload["from"], payload["to"]))

    async def delete_workspace(request: Request) -> JSONResponse:
        """Remove the workspace and everything in it, once its run is over."""
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        workspace_id = request.path_params["workspace_id"]
        return in_workspace(lambda: workspaces.remove(workspace_id))

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
        if request.path_params["plugin_id"] in in_development:
            name = in_development[request.path_params["plugin_id"]]
            return JSONResponse({"error": f"{name} is under maintenance"}, status_code=409)
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

    async def list_packages(request: Request) -> JSONResponse:
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return JSONResponse({"packages": [entry for entry, _ in packages.values()]})

    async def download_package(request: Request) -> Any:
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        package = packages.get(request.path_params["package_id"])
        if package is None:
            return JSONResponse({"error": "package not found"}, status_code=404)
        entry, data = package
        return Response(
            data,
            media_type="application/gzip",
            headers={"Content-Disposition": f'attachment; filename="{entry["id"]}-{entry["version"]}.tar.gz"'},
        )

    async def inspect_upload(request: Request) -> JSONResponse:
        """Check an uploaded package without running it: its catalog entry, or every reason it is refused."""
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > PACKAGE_MAX_BYTES:
            return JSONResponse({"error": "package is too large"}, status_code=413)
        body = await request.body()
        if len(body) > PACKAGE_MAX_BYTES:
            return JSONResponse({"error": "package is too large"}, status_code=413)
        try:
            async with plugin_slots:
                entry = await asyncio.to_thread(inspect_package, body)
        except PackageError as error:
            return JSONResponse(
                {"error": f"the package is refused: {'; '.join(error.violations)}", "violations": error.violations},
                status_code=422,
            )
        return JSONResponse({"package": entry})

    async def package_source(request: Request) -> JSONResponse:
        """Pack the plugin at ``?path=`` in a source archive and check it, running none of it."""
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > SOURCE_MAX_BYTES:
            return JSONResponse({"error": "source archive is too large"}, status_code=413)
        body = await request.body()
        if len(body) > SOURCE_MAX_BYTES:
            return JSONResponse({"error": "source archive is too large"}, status_code=413)
        try:
            async with plugin_slots:
                entry, data = await asyncio.to_thread(pack_source, body, request.query_params.get("path", ""))
        except PackageError as error:
            return JSONResponse(
                {"error": f"the plugin is refused: {'; '.join(error.violations)}", "violations": error.violations},
                status_code=422,
            )
        return JSONResponse({"package": entry, "data": base64.b64encode(data).decode("ascii")})

    async def plugin_ui(request: Request) -> Any:
        """A file of a ready plugin's front end at its current version, under the policy that confines it to the bridge."""
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        plugin_id = request.path_params["plugin_id"]
        manifest = plugins.get(plugin_id)
        if manifest is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        headers = {"Content-Security-Policy": UI_POLICY, "X-Content-Type-Options": "nosniff"}
        version, _, path = request.path_params["path"].partition("/")
        if version == ui_versions[plugin_id]:
            headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            # COMPAT(mochi-unversioned-ui): Mochi on production asks for ui/{path} without the
            # version. Remove once the Mochi that sends it is released.
            path = request.path_params["path"]
        target = _ui_file(manifest, path)
        if target is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return FileResponse(target, media_type=media_type, headers=headers)

    task_runs: dict[str, asyncio.Task[Any]] = {}

    async def start_task_run(request: Request) -> JSONResponse | StreamingResponse:
        """Run one plugin task the verified way in a caller's workspace, streaming `task.*` events."""
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if request.path_params["plugin_id"] in in_development:
            name = in_development[request.path_params["plugin_id"]]
            return JSONResponse({"error": f"{name} is under maintenance"}, status_code=409)
        manifest = plugins.get(request.path_params["plugin_id"])
        if manifest is None:
            return JSONResponse({"error": "plugin not found"}, status_code=404)
        try:
            task = manifest.task(request.path_params["task_id"])
            folder = workspaces.folder(request.path_params["workspace_id"], create=True)
        except KeyError as error:
            return JSONResponse({"error": error.args[0]}, status_code=404)
        except ValueError as error:
            return JSONResponse({"error": str(error)}, status_code=400)
        payload, rejected = await read_json(request)
        if rejected is not None:
            return rejected
        if not isinstance(payload, dict) or set(payload) != {"arguments"} or not isinstance(payload["arguments"], dict):
            return JSONResponse({"error": 'request body must be {"arguments": {...}}'}, status_code=400)

        run_id = f"task_{uuid.uuid4().hex}"
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

        def emit(kind: str, data: dict[str, Any]) -> None:
            queue.put_nowait({"type": kind, "runId": run_id, **data})

        def make_agent(system_prompt: str) -> Agent:
            return Agent(
                model_for_plugins(),
                [],
                system_prompt=system_prompt,
                max_steps=cfg.agent.max_steps,
                cost_limit=cfg.agent.cost_limit,
                token_limit=cfg.agent.token_limit,
                context_window=cfg.agent.context_window,
                hooks=get_hooks(cfg.agent.hooks),
            )

        async def work() -> None:
            # Only a task that finished has metrics; one that failed or was stopped reports none.
            done: dict[str, Any] = {}
            started = time.perf_counter()
            try:
                async with plugin_slots:
                    outcome = await run_task(
                        manifest,
                        task,
                        payload["arguments"],
                        folder,
                        make_agent=make_agent,
                        timeout=cfg.request_timeout,
                        on_event=emit,
                        stage=_staged_from(folder),
                    )
                done["metrics"] = _task_metrics(outcome, time.perf_counter() - started, cfg.model.model)
            except asyncio.CancelledError:
                emit("task.error", {"message": "cancelled"})
            except Exception as error:  # noqa: BLE001 - the stream reports every failure
                emit("task.error", {"message": f"{type(error).__name__}: {error}"})
            finally:
                task_runs.pop(run_id, None)
                emit("task.done", done)

        task_runs[run_id] = asyncio.create_task(work())

        async def stream() -> AsyncIterator[bytes]:
            try:
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=cfg.heartbeat_seconds)
                    except TimeoutError:
                        yield b": heartbeat\n\n"
                        continue
                    yield _sse(event)
                    if event["type"] == "task.done":
                        return
            finally:
                # A caller that hangs up stops its task.
                if run_id in task_runs:
                    task_runs[run_id].cancel()

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-NanoAgent-API-Version": "v1",
                "X-NanoAgent-Run-Id": run_id,
            },
        )

    async def cancel_run(request: Request) -> JSONResponse:
        if not authorized(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        run_id = request.path_params["run_id"]
        if run_id in task_runs:
            task_runs[run_id].cancel()
        elif not run_host.cancel(run_id):
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
            Route("/v1/packages", list_packages, methods=["GET"]),
            Route("/v1/packages/inspect", inspect_upload, methods=["POST"]),
            Route("/v1/packages/source", package_source, methods=["POST"]),
            Route("/v1/packages/{package_id}", download_package, methods=["GET"]),
            Route("/v1/plugins/{plugin_id}/ui/{path:path}", plugin_ui, methods=["GET"]),
            Route(
                "/v1/workspaces/{workspace_id}/plugins/{plugin_id}/tasks/{task_id}/runs",
                start_task_run,
                methods=["POST"],
            ),
            Route(
                "/v1/workspaces/{workspace_id}/plugins/{plugin_id}/runs",
                start_plugin_run,
                methods=["POST"],
            ),
            Route("/v1/workspaces/{workspace_id}/files", list_files, methods=["GET"]),
            Route(
                "/v1/workspaces/{workspace_id}/files/{path:path}",
                workspace_file,
                methods=["GET", "PUT", "DELETE"],
            ),
            Route(
                "/v1/workspaces/{workspace_id}/folders/{path:path}",
                workspace_folder,
                methods=["POST", "DELETE"],
            ),
            Route("/v1/workspaces/{workspace_id}/move", move_entry, methods=["POST"]),
            Route("/v1/workspaces/{workspace_id}", delete_workspace, methods=["DELETE"]),
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
