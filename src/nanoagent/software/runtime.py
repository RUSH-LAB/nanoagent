from __future__ import annotations

import json
import subprocess
from typing import Any

from nanoagent.core.tool import Tool
from nanoagent.software.manifest import SoftwareManifest


def call_tool(
    manifest: SoftwareManifest,
    tool: str,
    arguments: dict[str, Any],
    *,
    timeout: float = 300,
) -> dict[str, Any]:
    manifest.tool(tool)
    request = json.dumps({"tool": tool, "arguments": arguments}) + "\n"
    completed = subprocess.run(
        manifest.command,
        cwd=manifest.root,
        input=request,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if completed.returncode:
        detail = completed.stderr.strip() or f"exit status {completed.returncode}"
        raise RuntimeError(f"{manifest.id} failed: {detail}")
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RuntimeError(f"{manifest.id} must return exactly one JSON response")
    try:
        response = json.loads(lines[0])
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{manifest.id} returned invalid JSON") from error
    if not isinstance(response, dict):
        raise RuntimeError(f"{manifest.id} returned a non-object response")
    return response


class SoftwareTool(Tool):
    def __init__(self, manifest: SoftwareManifest, name: str) -> None:
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
            raise RuntimeError(str(response.get("error", "software tool failed")))
        return json.dumps(response)


def software_tools(manifest: SoftwareManifest) -> list[Tool]:
    return [SoftwareTool(manifest, definition.name) for definition in manifest.tools]
