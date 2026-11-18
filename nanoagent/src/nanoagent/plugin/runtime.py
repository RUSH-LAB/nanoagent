"""Running plugin tools: one plugin process per :class:`PluginSession`, every call checked.

A session checks the plugin's environment once (:func:`preflight`), starts its MCP server once and keeps it for every call,
so a plugin can hold state (a browser, a game) for the whole of one task run. Each call re-checks
the plugin rules, builds its input and output into their contract classes (see
:mod:`nanoagent.plugin.v0001.contract`) and runs the verifier on both. A tool that fails raises; the
MCP server reports it as an error result, and the call raises it again here.
:func:`call_tool` is a session of one call.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Iterator, Mapping, Sequence
from contextlib import AbstractContextManager, AsyncExitStack, nullcontext
from functools import partial
from pathlib import Path
from typing import Any, Protocol

import anyio
import anyio.to_thread
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import TextContent
from slimconfig import build_output

from nanoagent.core.tool import Tool, ToolText
from nanoagent.plugin import sandbox
from nanoagent.plugin.manifest import PluginManifest, load_manifest
from nanoagent.plugin.verifier import Verification, verify_input, verify_output

# The one folder a plugin may write to (its `filesystem: write: [workspace]` permission).
WORKSPACE_ENV = "NANOAGENT_WORKSPACE"
PREFLIGHT_TIMEOUT = 60.0
# Threads one session's checks may hold at once: each read-only call's verifier may copy the whole workspace out.
SESSION_THREADS = 2


def plugin_env(manifest: PluginManifest, workspace: Path) -> dict[str, str]:
    """What the plugin process sees: the variables its `.env` names, set from this environment."""
    return {
        **{name: os.environ[name] for name in manifest.env if name in os.environ},
        WORKSPACE_ENV: str(workspace.resolve()),
    }


def preflight(manifest: PluginManifest, env: dict[str, str]) -> None:
    """Check this environment can run the plugin: uv is installed, every variable its `.env` names is
    set, and its `uv.lock` matches its `pyproject.toml`. The lock is checked in the sandbox, with the
    environment the plugin will get."""
    if shutil.which("uv") is None:
        raise RuntimeError(f"{manifest.id}: this environment cannot run the plugin: uv is not installed")
    for name in manifest.env:
        if not env.get(name):
            raise RuntimeError(f"{manifest.id}: this environment cannot run the plugin: {name} is not set (declared in .env)")
    with sandbox.launch(["uv", "lock", "--check", "--offline", "--quiet"], root=manifest.root, env=env) as (argv, launch_env):
        completed = subprocess.run(
            argv,
            cwd=manifest.root,
            env=launch_env,
            capture_output=True,
            text=True,
            timeout=PREFLIGHT_TIMEOUT,
            check=False,
        )
    if completed.returncode:
        output = (completed.stderr or completed.stdout).strip() or f"exit {completed.returncode}"
        raise RuntimeError(f"{manifest.id}: this environment cannot run the plugin: `uv lock --check` failed (uv.lock out of date with pyproject.toml?): {output}")


def call_tool(
    manifest: PluginManifest,
    tool: str,
    arguments: dict[str, Any],
    *,
    workspace: Path,
    timeout: float = 300,
) -> dict[str, Any]:
    """Run one plugin tool; the plugin writes only inside ``workspace``, an existing folder."""
    return anyio.run(
        partial(call_tool_async, manifest, tool, arguments, workspace=workspace, timeout=timeout)
    )


async def call_tool_async(
    manifest: PluginManifest,
    tool: str,
    arguments: dict[str, Any],
    *,
    workspace: Path,
    timeout: float = 300,
) -> dict[str, Any]:
    """:func:`call_tool` for a caller already inside an event loop, such as an agent."""
    # Bad input is refused before the plugin is launched.
    _check_input(manifest, tool, arguments)
    async with PluginSession(manifest, workspace, timeout=timeout) as session:
        return await session.invoke(tool, arguments)


def _check_input(manifest: PluginManifest, tool: str, arguments: dict[str, Any]) -> None:
    try:
        build_output(arguments, manifest.tool(tool).input_type)
    except ValueError as error:
        raise ValueError(f"invalid input for {tool}: {error}") from error
    input_check = verify_input(manifest, tool, arguments)
    if not input_check.valid:
        raise ValueError(f"plugin input verification failed: {input_check.message}")


class PluginLauncher(Protocol):
    """Runs the plugin's MCP server somewhere other than :func:`sandbox.launch`, such as a container of its own.

    The plugin then sees ``workspace`` at that path inside its sandbox, which need not exist on this host.
    """

    def launch(self, manifest: PluginManifest, env: Mapping[str, str]) -> AbstractContextManager[tuple[list[str], dict[str, str]]]:
        """The command and the environment of the local process whose stdio is the plugin's, while the block runs."""
        ...

    def workspace_view(self) -> AbstractContextManager[Path]:
        """A folder on this host holding the workspace as the plugin left it, for the verifier to read."""
        ...


class PluginSession:
    """One plugin process for a run: entered once, then :meth:`call` any number of times.

    ``timeout`` bounds the launch and each call separately. ``fixtures``, a folder, is one the plugin may only read.
    ``launcher`` replaces the host sandbox: the plugin's environment is then the launcher's, so the host's ``uv lock``
    check, the host ``workspace`` folder and ``fixtures`` are not used.
    """

    def __init__(
        self,
        manifest: PluginManifest,
        workspace: Path,
        *,
        timeout: float,
        fixtures: Path | None = None,
        launcher: PluginLauncher | None = None,
    ) -> None:
        self.manifest = manifest
        self.workspace = workspace
        self.fixtures = fixtures
        self.launcher = launcher
        self.timeout = timeout
        self._stack = AsyncExitStack()
        self._threads = anyio.CapacityLimiter(SESSION_THREADS)
        self._session: ClientSession | None = None

    async def __aenter__(self) -> PluginSession:
        self._check()
        if self.launcher is not None:
            argv, launch_env = self._stack.enter_context(self.launcher.launch(self.manifest, plugin_env(self.manifest, self.workspace)))
        else:
            argv, launch_env = self._launch_in_host_sandbox()
        params = StdioServerParameters(command=argv[0], args=argv[1:], cwd=self.manifest.root, env=launch_env)
        try:
            # The connection's own scopes close with the session, so only the waits are bounded.
            read, write = await self._stack.enter_async_context(stdio_client(params))
            session = await self._stack.enter_async_context(ClientSession(read, write))
            with anyio.fail_after(self.timeout):
                await session.initialize()
                offered = {item.name: item for item in (await session.list_tools()).tools}
        except BaseException:
            await self._stack.aclose()
            raise
        for definition in self.manifest.tools:
            served = offered.get(definition.name)
            if served is None:
                problem = f"does not offer {definition.name!r}"
            elif served.inputSchema != definition.input:
                problem = f"input schema of {definition.name!r} differs from its manifest"
            elif served.outputSchema != definition.output:
                problem = f"output schema of {definition.name!r} differs from its manifest"
            else:
                continue
            await self._stack.aclose()
            raise RuntimeError(f"{self.manifest.id} MCP server {problem}")
        self._session = session
        return self

    def _launch_in_host_sandbox(self) -> tuple[list[str], dict[str, str]]:
        if not self.workspace.is_dir():
            raise ValueError(f"plugin workspace {self.workspace} is not a folder")
        if self.fixtures is not None and not self.fixtures.is_dir():
            raise ValueError(f"plugin fixtures {self.fixtures} is not a folder")
        env = plugin_env(self.manifest, self.workspace)
        preflight(self.manifest, env)
        # A sandboxed plugin's environment was built when it was installed: its runs neither sync
        # it again nor reach the package index.
        return self._stack.enter_context(
            sandbox.launch(
                self.manifest.command,
                root=self.manifest.root,
                env={**env, "UV_NO_SYNC": "1", "UV_OFFLINE": "1"} if sandbox.current() != "none" else env,
                readable=[self.fixtures] if self.fixtures is not None else [],
                writable=[self.workspace],
                hosts=self.manifest.permissions.network_hosts,
            )
        )

    async def __aexit__(self, *exc: object) -> None:
        self._session = None
        await self._stack.aclose()

    def _check(self) -> None:
        # The rules are re-checked on every call: a plugin edited since it loaded, or a manifest
        # built by hand, is refused.
        if load_manifest(self.manifest.root) != self.manifest:
            raise ValueError(f"plugin {self.manifest.id} changed since it was loaded; load it again")

    async def call(self, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Check the input, run ``tool``, and return its checked output."""
        # The verifier runs in processes of its own and blocks for their whole run: off the loop, so whatever else the loop
        # serves (the attempt gateway relaying a model's stream) is not held up behind a tool call.
        await anyio.to_thread.run_sync(_check_input, self.manifest, tool, arguments, limiter=self._threads)
        return await self.invoke(tool, arguments)

    async def invoke(self, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """:meth:`call` for input already checked by :func:`_check_input`."""
        if self._session is None:
            raise RuntimeError("plugin session is not open")
        await anyio.to_thread.run_sync(self._check, limiter=self._threads)
        manifest = self.manifest
        definition = manifest.tool(tool)
        with anyio.fail_after(self.timeout):
            result = await self._session.call_tool(tool, arguments=arguments)
        response = _response(manifest, tool, result)
        try:
            build_output(response, definition.output_type)
        except ValueError as error:
            raise RuntimeError(f"invalid output from {tool}: {error}") from error
        if _names_workspace(response, self.workspace):
            raise RuntimeError(
                f"invalid output from {tool}: it names the run's workspace folder, which is gone once the run"
                " ends; name what is in it by a path relative to it"
            )
        output_check = await anyio.to_thread.run_sync(self._verify_output, tool, arguments, response, limiter=self._threads)
        if not output_check.valid:
            raise RuntimeError(f"plugin output verification failed: {output_check.message}")
        return response

    def _verify_output(self, tool: str, arguments: dict[str, Any], response: dict[str, Any]) -> Verification:
        view = nullcontext(self.workspace) if self.launcher is None else self.launcher.workspace_view()
        with view as workspace:
            return verify_output(self.manifest, tool, arguments, response, workspace)


def _strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def _names_workspace(output: Any, workspace: Path) -> bool:
    """Whether ``output`` holds the path of ``workspace``: the run's own folder, which is no
    place its caller can find once the run ends."""
    roots = {str(workspace), str(workspace.resolve())}
    return any(root in text for text in _strings(output) for root in roots)


def _response(manifest: PluginManifest, tool: str, result: Any) -> Any:
    text = [item.text for item in result.content if isinstance(item, TextContent)]
    if result.isError:
        raise RuntimeError(f"{manifest.id} {tool} failed: {' '.join(text) or 'no message'}")
    if result.structuredContent is not None:
        return result.structuredContent
    if len(text) != 1:
        raise RuntimeError(f"{manifest.id} must return exactly one MCP text result")
    try:
        return json.loads(text[0])
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{manifest.id} returned invalid JSON in its MCP result") from error


class PluginTool(Tool):
    """A plugin tool for an agent: called through ``session`` when one is open for the run,
    otherwise through a session of its own per call.

    A response's ``images`` (a list of ``{"media_type", "data"}``, data in base64) go to the model
    as images, not as text.
    """

    def __init__(
        self, manifest: PluginManifest, name: str, workspace: Path, session: PluginSession | None
    ) -> None:
        definition = manifest.tool(name)
        self._manifest = manifest
        self._workspace = workspace
        self._session = session
        self.NAME = definition.name
        self.PARAMETERS = definition.input
        self._description = definition.description

    @property
    def description(self) -> str:
        return self._description

    # Async so the agent awaits it on its own loop; a sync run would go to a worker thread,
    # where call_tool's anyio.run refuses the loop context the thread inherits.
    async def run(self, **arguments: Any) -> str:
        if self._session is not None:
            response = await self._session.call(self.NAME, arguments)
        else:
            response = await call_tool_async(
                self._manifest, self.NAME, arguments, workspace=self._workspace
            )
        images = response.pop("images", [])
        return ToolText(json.dumps(response), images=images)


def plugin_tools(
    manifest: PluginManifest,
    workspace: Path,
    names: Sequence[str] | None = None,
    *,
    session: PluginSession | None,
) -> list[Tool]:
    """The plugin's tools as agent tools, or only ``names`` (e.g. one task's tools)."""
    chosen = [manifest.tool(name) for name in names] if names is not None else manifest.tools
    return [PluginTool(manifest, definition.name, workspace, session) for definition in chosen]
