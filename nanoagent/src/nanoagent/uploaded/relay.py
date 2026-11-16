"""Makes one attempt's services reachable from its case sandbox.

Attempt networks are `--internal` with no host gateway, so the guest cannot reach the worker. The services therefore
listen on a Unix socket in a private directory, and a small relay container (runc, pinned image, read-only, no
capabilities) attached only to the attempt network forwards TCP port [PORT] to that socket. The guest addresses the
relay by IP; nothing else of the host is reachable and the worker opens no TCP port.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import anyio
import uvicorn
from starlette.types import ASGIApp

from nanoagent.uploaded.dockercli import DockerRunner
from nanoagent.uploaded.sandbox import AttemptNetwork, SandboxError, _checked
from nanoagent.uploaded.toolchains import HOLDER_IMAGE

PORT = 8080
SOCKET_NAME = "services.sock"
FORWARDER = Path(__file__).with_name("relay_forward.py").read_text(encoding="utf-8")


class RelayHandle(Protocol):
    base_url: str  # `http://<relay ip>:<port>`

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
    _docker: DockerRunner
    _container: str
    _sockdir: Path

    async def aclose(self) -> None:
        with anyio.CancelScope(shield=True):
            self._docker.run(["rm", "-f", self._container])
            self._server.should_exit = True
            with anyio.move_on_after(15):
                await self._task  # type: ignore[misc]
            shutil.rmtree(self._sockdir, ignore_errors=True)


class DockerRelay:
    def __init__(self, docker: DockerRunner, *, image: str = HOLDER_IMAGE, ready_timeout_s: float = 20.0) -> None:
        self._docker = docker
        self._image = image
        self._ready_timeout_s = ready_timeout_s

    async def start(self, attempt_id: str, network: AttemptNetwork, app: ASGIApp, workdir: Path) -> RelayHandle:
        # A Unix socket path is limited to about 100 bytes, which a scratch path can exceed: use a short private directory.
        sockdir = Path(tempfile.mkdtemp(prefix="rs-"))
        sockdir.chmod(0o711)
        socket = sockdir / SOCKET_NAME
        socket.unlink(missing_ok=True)
        server = _Server(uvicorn.Config(app, uds=str(socket), log_level="warning"))
        task = asyncio.ensure_future(server.serve())
        with anyio.fail_after(self._ready_timeout_s):
            while not server.started:
                if task.done():
                    task.result()
                await anyio.sleep(0.01)
        os.chmod(socket, 0o666)  # the relay's unprivileged user connects; the attempt token authorizes
        name = f"rush-relay-{attempt_id}"
        container = ""
        try:
            args = [
                "create", f"--name={name}", "--runtime=runc", f"--network={network.name}", "--read-only", "--cap-drop=ALL",
                "--security-opt=no-new-privileges", "--user=65534:65534", "--memory=64m", "--pids-limit=64",
                "--log-opt=max-size=1m", "--mount", f"type=bind,src={sockdir},dst=/sock",
                "--entrypoint", "python", self._image, "-c", FORWARDER, f"/sock/{SOCKET_NAME}", str(PORT),
            ]
            container = _checked(self._docker.run(args), "relay_failed", "create the relay").text()
            _checked(self._docker.run(["start", container]), "relay_failed", "start the relay")
            deadline = time.monotonic() + self._ready_timeout_s
            while b"ready" not in self._docker.run(["logs", container]).stdout:
                if time.monotonic() > deadline:
                    raise SandboxError("relay_failed", "the relay did not report ready")
                await anyio.sleep(0.1)
            address = network.address_of(container)
        except BaseException:
            if container:
                self._docker.run(["rm", "-f", container])
            server.should_exit = True
            await task
            shutil.rmtree(sockdir, ignore_errors=True)
            raise
        return _Handle(f"http://{address}:{PORT}", server, task, self._docker, container, sockdir)
