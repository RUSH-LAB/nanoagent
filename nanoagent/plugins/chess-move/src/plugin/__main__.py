"""The MCP server: each call's input built into its contract class, its output checked against its own."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import anyio
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server
from slimconfig import build_output, output_schema, plain_output

from contract import TOOLS, PinOutput, Position, Tool
from plugin import Play, pin_moves
from plugin.board import LiveBoard
from plugin.engine import Stockfish

server = Server("chess-move")
# NanoAgent names the one folder this plugin may write to.
WORKSPACE_ENV = "NANOAGENT_WORKSPACE"
# One live board for the whole process, which NanoAgent keeps for the whole task.
PLAY = Play(LiveBoard)


def pin_with_stockfish(given: Position, workspace: Path) -> PinOutput:
    with Stockfish() as engine:
        return pin_moves(given.fen, engine=engine)


# Each tool's implementation: (its input, the workspace) -> its output, as contract.TOOLS types them.
IMPLEMENTATIONS = {
    Tool.PIN_MOVES: pin_with_stockfish,
    Tool.OPEN_BOARD: PLAY.open_board,
    Tool.SCREENSHOT: PLAY.screenshot,
    Tool.DRAG: PLAY.drag,
    Tool.CLICK: PLAY.click,
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
    output = IMPLEMENTATIONS[tool](build_output(arguments, given), Path(os.environ[WORKSPACE_ENV]))
    if not isinstance(output, made):
        raise TypeError(f"{name} returned {type(output).__name__}, not {made.__name__}")
    return plain_output(output)


def main() -> None:
    if WORKSPACE_ENV not in os.environ:
        raise SystemExit(f"{WORKSPACE_ENV} is not set: NanoAgent passes the plugin's workspace folder")
    if set(IMPLEMENTATIONS) != set(Tool):
        raise SystemExit("IMPLEMENTATIONS must implement every contract.Tool")

    async def run() -> None:
        async with stdio_server() as (read, write):
            # stdout is the MCP channel, already held by the transport; msa prints its progress.
            sys.stdout = sys.stderr
            try:
                await server.run(read, write, server.create_initialization_options())
            finally:
                PLAY.close()

    anyio.run(run)


if __name__ == "__main__":
    main()
