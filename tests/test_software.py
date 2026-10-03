from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from nanoagent.software import call_tool, load_manifest, software_tools


def write_manifest(root: Path, command: list[str] | None = None) -> Path:
    manifest = root / "nanoagent.yaml"
    manifest.write_text(
        f"""spec: nanoagent.software/v1
id: echo
name: Echo
version: 1.0.0
runtime:
  command: {json.dumps(command or [sys.executable, "-c", "import sys; print(sys.stdin.readline())"])}
tools:
  - name: echo
    description: Echo input
    input: {{type: object}}
    output: {{type: object}}
tasks:
  - id: echo
    description: Echo input
    tools: [echo]
    instructions: Echo the supplied value.
""",
        encoding="utf-8",
    )
    return manifest


def test_loads_versioned_software_manifest(tmp_path: Path) -> None:
    manifest = load_manifest(write_manifest(tmp_path))
    assert manifest.id == "echo"
    assert manifest.task("echo").tools == ("echo",)
    assert manifest.public()["spec"] == "nanoagent.software/v1"


def test_rejects_unknown_task_tool(tmp_path: Path) -> None:
    path = write_manifest(tmp_path)
    path.write_text(path.read_text().replace("tools: [echo]", "tools: [missing]"))
    with pytest.raises(ValueError, match="unknown tools"):
        load_manifest(path)


def test_calls_jsonl_software_subprocess(tmp_path: Path) -> None:
    program = tmp_path / "tool.py"
    program.write_text(
        "import json, sys\n"
        "request = json.loads(sys.stdin.readline())\n"
        "print(json.dumps({'ok': True, 'value': request['arguments']['value']}))\n"
    )
    manifest = load_manifest(write_manifest(tmp_path, [sys.executable, str(program)]))
    assert call_tool(manifest, "echo", {"value": 42}) == {"ok": True, "value": 42}


@pytest.mark.asyncio
async def test_exposes_software_as_agent_tools(tmp_path: Path) -> None:
    program = tmp_path / "tool.py"
    program.write_text(
        "import json, sys\n"
        "request = json.loads(sys.stdin.readline())\n"
        "print(json.dumps({'ok': True, 'value': request['arguments']['value']}))\n"
    )
    manifest = load_manifest(write_manifest(tmp_path, [sys.executable, str(program)]))
    tool = software_tools(manifest)[0]
    assert tool.to_openai_spec()["function"]["parameters"] == {"type": "object"}
    result, failed = await tool.invoke(value="paper")
    assert failed is False
    assert json.loads(result)["value"] == "paper"
