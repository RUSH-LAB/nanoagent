from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import anyio
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from plugin import download_source, list_daily_papers, save_raw_paper, save_search_results, search_papers, write_digest


def _schema(name: str) -> dict[str, Any]:
    return json.loads((Path.cwd() / "schemas" / name).read_text())


server = Server("arxiv-source")
# NanoAgent names the one folder this plugin may write to.
WORKSPACE_ENV = "NANOAGENT_WORKSPACE"


# name -> (description, schema file stem, implementation, whether it writes to the workspace)
TOOLS = {
    "search_papers": ("Search arXiv and return the matching papers' metadata", "search", search_papers, False),
    "download_source": ("Download and safely unpack an arXiv paper source archive", "download", download_source, True),
    "save_search_results": (
        "Search arXiv, then download and unpack every result's source archive",
        "save",
        save_search_results,
        True,
    ),
    "list_daily_papers": (
        "List the papers arXiv shows for each person, first submitted on a date",
        "daily",
        list_daily_papers,
        False,
    ),
    "save_raw_paper": (
        "Save a paper's source under docs/raw/{first_author_name}-{paper_short_name}-{arxiv_id}-{date}",
        "raw",
        save_raw_paper,
        True,
    ),
    "write_digest": ("Write the daily digest as docs/digest-{date}.json and .md", "digest", write_digest, True),
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
