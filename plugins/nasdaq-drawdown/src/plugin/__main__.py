from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import anyio
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from plugin import get_closes, list_constituents, pin_week, submit_tickers


def _schema(name: str) -> dict[str, Any]:
    return json.loads((Path.cwd() / "schemas" / name).read_text())


server = Server("nasdaq-drawdown")
# NanoAgent names the one folder this plugin may write to.
WORKSPACE_ENV = "NANOAGENT_WORKSPACE"
# name -> (description, schema file stem, implementation, whether it writes to the workspace)
TOOLS = {
    "pin_week": (
        "Pin every Nasdaq-100 constituent's close on a session and 5 sessions earlier",
        "pin",
        pin_week,
        False,
    ),
    "list_constituents": (
        "List the Nasdaq-100 constituents and the 5-session week ending on a date",
        "constituents",
        list_constituents,
        False,
    ),
    "get_closes": ("Get each ticker's daily close on a trading session", "closes", get_closes, False),
    "submit_tickers": (
        "Submit the tickers that fell at least 5% over the week, written to tickers.json",
        "submit",
        submit_tickers,
        True,
    ),
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
            await server.run(read, write, server.create_initialization_options())

    anyio.run(run)


if __name__ == "__main__":
    main()
