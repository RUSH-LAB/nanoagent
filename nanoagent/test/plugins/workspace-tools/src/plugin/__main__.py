"""The MCP server: each call's input built into its contract class, its output checked against its own."""

from __future__ import annotations

from typing import Any

import anyio
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server
from slimconfig import build_output, output_schema, plain_output

from contract import TOOLS, Tool
from plugin import copy_fixture, expected_note, inspect_sandbox, read_fixture, write_note

server = Server("workspace-tools")
# Each tool's implementation: its input -> its output, as contract.TOOLS types them. Every tool reads
# only the text it is given and writes nothing.
IMPLEMENTATIONS = {
    Tool.WRITE_NOTE: write_note,
    Tool.READ_FIXTURE: read_fixture,
    Tool.COPY_FIXTURE: copy_fixture,
    Tool.INSPECT_SANDBOX: inspect_sandbox,
    Tool.EXPECTED_NOTE: expected_note,
}


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(name=tool.value, inputSchema=output_schema(given), outputSchema=output_schema(made))
        for tool, (given, made) in TOOLS.items()
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    # A failure raises; the MCP server returns it as an error result.
    tool = Tool(name)
    given, made = TOOLS[tool]
    # In a thread: a blocking wait must not stop the server answering a second call made at the same time.
    output = await anyio.to_thread.run_sync(IMPLEMENTATIONS[tool], build_output(arguments, given))
    if not isinstance(output, made):
        raise TypeError(f"{name} returned {type(output).__name__}, not {made.__name__}")
    return plain_output(output)


def main() -> None:
    if set(IMPLEMENTATIONS) != set(Tool):
        raise SystemExit("IMPLEMENTATIONS must implement every contract.Tool")

    async def run() -> None:
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())

    anyio.run(run)


if __name__ == "__main__":
    main()
