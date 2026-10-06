from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import anyio
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from plugin import Play, pin_moves
from plugin.board import LiveBoard
from plugin.engine import Stockfish


def _schema(name: str) -> dict[str, Any]:
    return json.loads((Path.cwd() / "schemas" / name).read_text())


server = Server("chess-move")
# NanoAgent names the one folder this plugin may write to.
WORKSPACE_ENV = "NANOAGENT_WORKSPACE"
# One live board for the whole process, which NanoAgent keeps for the whole task.
PLAY = Play(LiveBoard)


def pin_with_stockfish(fen: str) -> dict:
    with Stockfish() as engine:
        return pin_moves(fen, engine=engine)


# name -> (description, schema file stem, implementation, whether it writes to the workspace)
TOOLS = {
    "pin_moves": (
        (
            "Score every legal move of a chess position with Stockfish and pin each one's resulting position and win "
            "probability"
        ),
        "pin",
        pin_with_stockfish,
        False,
    ),
    "open_board": (
        "Open the chess app on a position, playing the side to move, and return a screenshot of the board",
        "open",
        PLAY.open_board,
        True,
    ),
    "screenshot": ("Return a screenshot of the live chess board", "screenshot", PLAY.screenshot, False),
    "drag": (
        "Press the mouse at one point of the board screenshot, drag it to another and release it there",
        "drag",
        PLAY.drag,
        True,
    ),
    "click": ("Click the mouse at one point of the board screenshot", "click", PLAY.click, True),
}


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name=name,
            description=description,
            inputSchema=_schema(f"{stem}-input.json"),
            outputSchema=_schema(f"{stem}-output.json"),
        )
        for name, (description, stem, _, _) in TOOLS.items()
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        if name not in TOOLS:
            raise ValueError(f"unknown tool {name!r}")
        _, _, function, writes = TOOLS[name]
        if writes:
            return function(**arguments, workspace=Path(os.environ[WORKSPACE_ENV]))
        return function(**arguments)
    except Exception as error:  # noqa: BLE001 - MCP boundary returns structured failures
        return {"ok": False, "error": str(error)}


def main() -> None:
    if WORKSPACE_ENV not in os.environ:
        raise SystemExit(f"{WORKSPACE_ENV} is not set: NanoAgent passes the plugin's workspace folder")

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
