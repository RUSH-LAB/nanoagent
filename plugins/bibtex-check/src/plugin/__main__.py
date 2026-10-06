from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import anyio
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from plugin import parse_bibtex, read_bibtex, submit_verdicts


def _schema(name: str) -> dict[str, Any]:
    return json.loads((Path.cwd() / "schemas" / name).read_text())


server = Server("bibtex-check")
# NanoAgent names the one folder this plugin may write to.
WORKSPACE_ENV = "NANOAGENT_WORKSPACE"
# name -> (description, schema file stem, implementation, whether it reads or writes the workspace)
TOOLS = {
    "parse_bibtex": (
        "Parse the reference and raw BibTeX files into the registered schema",
        "parse",
        parse_bibtex,
        True,
    ),
    "read_bibtex": ("Read a BibTeX file's entries in the registered schema", "read", read_bibtex, True),
    "submit_verdicts": (
        "Write one verdict, real or hallucinated, per raw entry key to verdicts.json",
        "verdicts",
        submit_verdicts,
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
