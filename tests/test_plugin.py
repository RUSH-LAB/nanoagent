from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.plugin import call_tool, load_manifest, plugin_tools


def write_plugin(root: Path) -> Path:
    for name, content in {
        "README.md": "# Echo\n",
        "pyproject.toml": "[project]\nname='echo'\nversion='1.0.0'\n",
        "uv.lock": "version = 1\n",
        "src/plugin/__init__.py": "",
        "src/plugin/__main__.py": (
            "import json, sys\n"
            "request = json.loads(sys.stdin.readline())\n"
            "print(json.dumps({'ok': True, 'value': request['arguments']['value']}))\n"
        ),
        "schemas/input.json": json.dumps(
            {
                "type": "object",
                "required": ["value"],
                "properties": {"value": {"type": "string"}},
                "additionalProperties": False,
            }
        ),
        "schemas/output.json": json.dumps(
            {
                "type": "object",
                "required": ["ok", "value"],
                "properties": {"ok": {"const": True}, "value": {"type": "string"}},
                "additionalProperties": False,
            }
        ),
    }.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    manifest = root / "nanoagent.yaml"
    manifest.write_text(
        """spec: nanoagent.plugin/v1
id: echo
name: Echo
version: 1.0.0
runtime: {type: python}
permissions:
  network: {hosts: []}
  filesystem: {write: [workspace]}
tools:
  - name: echo
    description: Echo input
    input: schemas/input.json
    output: schemas/output.json
tasks:
  - id: echo
    description: Echo input
    tools: [echo]
    instructions: Echo the supplied value.
""",
        encoding="utf-8",
    )
    return manifest


def test_loads_strict_plugin_manifest(tmp_path: Path) -> None:
    manifest = load_manifest(write_plugin(tmp_path))
    assert manifest.command == ("uv", "run", "--frozen", "python", "-m", "plugin")
    assert manifest.public()["spec"] == "nanoagent.plugin/v1"


def test_rejects_missing_standard_file(tmp_path: Path) -> None:
    path = write_plugin(tmp_path)
    (tmp_path / "README.md").unlink()
    with pytest.raises(ValueError, match="README.md"):
        load_manifest(path)


def test_rejects_custom_runtime_command(tmp_path: Path) -> None:
    path = write_plugin(tmp_path)
    path.write_text(path.read_text().replace("runtime: {type: python}", "runtime: {type: python, command: bad}"))
    with pytest.raises(ValueError, match="exactly"):
        load_manifest(path)


def test_rejects_unknown_task_tool(tmp_path: Path) -> None:
    path = write_plugin(tmp_path)
    path.write_text(path.read_text().replace("tools: [echo]", "tools: [missing]"))
    with pytest.raises(ValueError, match="unknown tools"):
        load_manifest(path)


def test_validates_tool_input_before_launch(tmp_path: Path) -> None:
    manifest = load_manifest(write_plugin(tmp_path))
    with pytest.raises(ValueError, match="invalid input"):
        call_tool(manifest, "echo", {"value": 42})


@pytest.mark.asyncio
async def test_exposes_plugin_as_agent_tools(tmp_path: Path) -> None:
    manifest = load_manifest(write_plugin(tmp_path))
    tool = plugin_tools(manifest)[0]
    assert tool.to_openai_spec()["function"]["parameters"]["required"] == ["value"]
