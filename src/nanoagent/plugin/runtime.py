from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Sequence
from functools import partial
from pathlib import Path
from typing import Any

import anyio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import get_default_environment, stdio_client
from mcp.types import TextContent
from jsonschema import ValidationError, validate

from nanoagent.core.tool import Tool
from nanoagent.plugin.manifest import PluginManifest, load_manifest
from nanoagent.plugin.verifier import verify_input, verify_output

# The one folder a plugin may write to (its `filesystem: write: [workspace]` permission).
WORKSPACE_ENV = "NANOAGENT_WORKSPACE"
PREFLIGHT_TIMEOUT = 60.0


def plugin_env(manifest: PluginManifest, workspace: Path) -> dict[str, str]:
    """What the plugin process sees: the variables its `.env` names, set from this environment."""
    return {
        **{name: os.environ[name] for name in manifest.env if name in os.environ},
        WORKSPACE_ENV: str(workspace.resolve()),
    }


def preflight(manifest: PluginManifest, env: dict[str, str]) -> None:
    """Run the plugin's `run.sh` in the environment the plugin will get; fail unless it exits 0."""
    completed = subprocess.run(
        ["bash", "run.sh"],
        cwd=manifest.root,
        env={**get_default_environment(), **env},
        capture_output=True,
        text=True,
        timeout=PREFLIGHT_TIMEOUT,
        check=False,
    )
    if completed.returncode:
        output = (completed.stderr or completed.stdout).strip() or f"exit {completed.returncode}"
        raise RuntimeError(f"{manifest.id} run.sh: this environment cannot run the plugin: {output}")


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
    # The rules are re-checked on every call: a plugin edited since it loaded, or a manifest
    # built by hand, is refused.
    if load_manifest(manifest.root) != manifest:
        raise ValueError(f"plugin {manifest.id} changed since it was loaded; load it again")
    if not workspace.is_dir():
        raise ValueError(f"plugin workspace {workspace} is not a folder")
    definition = manifest.tool(tool)
    try:
        validate(arguments, definition.input)
    except ValidationError as error:
        raise ValueError(f"invalid input for {tool}: {error.message}") from error
    input_check = verify_input(manifest.root, tool, arguments)
    if not input_check.valid:
        raise ValueError(f"plugin input verification failed: {input_check.message}")

    env = plugin_env(manifest, workspace)
    preflight(manifest, env)
    response = await _call_mcp_tool(manifest, tool, arguments, env, timeout)
    if not isinstance(response, dict):
        raise RuntimeError(f"{manifest.id} returned a non-object response")
    try:
        validate(response, definition.output)
    except ValidationError as error:
        raise RuntimeError(f"invalid output from {tool}: {error.message}") from error
    output_check = verify_output(manifest.root, tool, arguments, response, workspace)
    if not output_check.valid:
        raise RuntimeError(f"plugin output verification failed: {output_check.message}")
    return response


async def _call_mcp_tool(
    manifest: PluginManifest,
    tool: str,
    arguments: dict[str, Any],
    env: dict[str, str],
    timeout: float,
) -> Any:
    params = StdioServerParameters(
        command=manifest.command[0],
        args=list(manifest.command[1:]),
        cwd=manifest.root,
        env=env,
    )
    with anyio.fail_after(timeout):
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                offered = {item.name: item for item in (await session.list_tools()).tools}
                if tool not in offered:
                    raise RuntimeError(f"{manifest.id} MCP server does not offer {tool!r}")
                definition = manifest.tool(tool)
                if offered[tool].inputSchema != definition.input:
                    raise RuntimeError(f"{manifest.id} MCP input schema differs from its manifest")
                if offered[tool].outputSchema != definition.output:
                    raise RuntimeError(f"{manifest.id} MCP output schema differs from its manifest")
                result = await session.call_tool(tool, arguments=arguments)
    if result.structuredContent is not None:
        return result.structuredContent
    text = [item.text for item in result.content if isinstance(item, TextContent)]
    if len(text) != 1:
        raise RuntimeError(f"{manifest.id} must return exactly one MCP text result")
    try:
        return json.loads(text[0])
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{manifest.id} returned invalid JSON in its MCP result") from error


class PluginTool(Tool):
    def __init__(self, manifest: PluginManifest, name: str, workspace: Path) -> None:
        definition = manifest.tool(name)
        self._manifest = manifest
        self._workspace = workspace
        self.NAME = definition.name
        self.PARAMETERS = definition.input
        self._description = definition.description

    @property
    def description(self) -> str:
        return self._description

    # Async so the agent awaits it on its own loop; a sync run would go to a worker thread,
    # where call_tool's anyio.run refuses the loop context the thread inherits.
    async def run(self, **arguments: Any) -> str:
        response = await call_tool_async(
            self._manifest, self.NAME, arguments, workspace=self._workspace
        )
        if not response.get("ok", False):
            raise RuntimeError(str(response.get("error", "plugin tool failed")))
        return json.dumps(response)


def plugin_tools(manifest: PluginManifest, workspace: Path, names: Sequence[str] | None = None) -> list[Tool]:
    """The plugin's tools as agent tools, or only ``names`` (e.g. one task's tools)."""
    chosen = [manifest.tool(name) for name in names] if names is not None else manifest.tools
    return [PluginTool(manifest, definition.name, workspace) for definition in chosen]
