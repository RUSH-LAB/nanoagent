"""Makes one attempt's services reachable from its case VM.

The services listen on a free loopback port of the worker, and that port is added to the attempt's network, so the case
VM's policy (deny by default) lets it reach exactly that port of `host.microsandbox.internal` and nothing else of the
host. The attempt token authorizes every request.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import anyio
import uvicorn
from starlette.types import ASGIApp

from nanoagent.uploaded.sandbox import GUEST_HOST, AttemptNetwork


class RelayHandle(Protocol):
    base_url: str  # `http://host.microsandbox.internal:<port>`

    async def aclose(self) -> None: ...


class ServiceRelay(Protocol):
    async def start(self, attempt_id: str, network: AttemptNetwork, app: ASGIApp, workdir: Path) -> RelayHandle:
        """Serve ``app`` and expose it on ``network``."""


class _Server(uvicorn.Server):
    def capture_signals(self):  # the worker owns signal handling
        return contextlib.nullcontext()


@dataclass
class _Handle:
    base_url: str
    _server: uvicorn.Server
    _task: object

    async def aclose(self) -> None:
        with anyio.CancelScope(shield=True):
            self._server.should_exit = True
            with anyio.move_on_after(15):
                await self._task  # type: ignore[misc]


class HostRelay:
    def __init__(self, *, ready_timeout_s: float = 20.0) -> None:
        self._ready_timeout_s = ready_timeout_s

    async def start(self, attempt_id: str, network: AttemptNetwork, app: ASGIApp, workdir: Path) -> RelayHandle:
        server = _Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
        task = asyncio.ensure_future(server.serve())
        with anyio.fail_after(self._ready_timeout_s):
            while not server.started:
                if task.done():
                    task.result()
                await anyio.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]
        network.ports.append(port)
        return _Handle(f"http://{GUEST_HOST}:{port}", server, task)
