from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import anyio
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from plugin import list_recipes, nutrition, solve, submit_meal


def _schema(name: str) -> dict[str, Any]:
    return json.loads((Path.cwd() / "schemas" / name).read_text())


server = Server("meal-suggestion")
# NanoAgent names the one folder this plugin may write to; every tool reads its input files there.
WORKSPACE_ENV = "NANOAGENT_WORKSPACE"


# name -> (description, schema file stem, implementation)
TOOLS = {
    "solve": ("Find the best meal of whole servings that meets the constraints and the preference", "solve", solve),
    "list_recipes": ("List the recipes for a meal that meet a food preference", "recipes", list_recipes),
    "nutrition": ("Give one serving of a recipe, its ingredients and its nutrition", "nutrition", nutrition),
    "submit_meal": ("Write the suggested meal, each dish's recipe and servings, to meal.json", "submit", submit_meal),
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
        for name, (description, stem, _) in TOOLS.items()
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        if name not in TOOLS:
            raise ValueError(f"unknown tool {name!r}")
        _, _, function = TOOLS[name]
        return function(**arguments, workspace=Path(os.environ[WORKSPACE_ENV]))
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
