from __future__ import annotations

import json
from typing import Any

import anyio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import TextContent
from jsonschema import ValidationError, validate

from nanoagent.core.tool import Tool
from nanoagent.plugin.manifest import PluginManifest


def call_tool(
    manifest: PluginManifest,
    tool: str,
    arguments: dict[str, Any],
    *,
    timeout: float = 300,
) -> dict[str, Any]:
    definition = manifest.tool(tool)
    try:
        validate(arguments, definition.input)
    except ValidationError as error:
        raise ValueError(f"invalid input for {tool}: {error.message}") from error

    response = anyio.run(_call_mcp_tool, manifest, tool, arguments, timeout)
    if not isinstance(response, dict):
        raise RuntimeError(f"{manifest.id} returned a non-object response")
    try:
        validate(response, definition.output)
    except ValidationError as error:
        raise RuntimeError(f"invalid output from {tool}: {error.message}") from error
    return response


async def _call_mcp_tool(
    manifest: PluginManifest,
    tool: str,
    arguments: dict[str, Any],
    timeout: float,
) -> Any:
    params = StdioServerParameters(
        command=manifest.command[0],
        args=list(manifest.command[1:]),
        cwd=manifest.root,
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
    def __init__(self, manifest: PluginManifest, name: str) -> None:
        definition = manifest.tool(name)
        self._manifest = manifest
        self.NAME = definition.name
        self.PARAMETERS = definition.input
        self._description = definition.description

    @property
    def description(self) -> str:
        return self._description

    def run(self, **arguments: Any) -> str:
        response = call_tool(self._manifest, self.NAME, arguments)
        if not response.get("ok", False):
            raise RuntimeError(str(response.get("error", "plugin tool failed")))
        return json.dumps(response)


def plugin_tools(manifest: PluginManifest) -> list[Tool]:
    return [PluginTool(manifest, definition.name) for definition in manifest.tools]
