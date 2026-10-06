from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from nanoagent.plugin import call_tool, load_manifest, plugin_tools


def write_plugin(root: Path) -> Path:
    for name, content in {
        "README.md": "# Echo\n",
        "LICENSE": "MIT\n",
        "pyproject.toml": "[project]\nname = 'echo'\nversion = '1.0.0'\n",
        "uv.lock": "",
        ".gitignore": ".venv/\n",
        ".env": "# no variables\n",
        "run.sh": "exit 0\n",
        "src/echo.py": "",
        "tests/test_echo.py": "",
        "verifier/__init__.py": (
            "def verify_input(tool, value):\n"
            "    return {'valid': bool(value.get('value')), 'score': 1.0, 'message': 'ok', 'details': {}}\n"
            "def verify_output(tool, input_value, output_value, workspace):\n"
            "    valid = output_value.get('value') == input_value.get('value')\n"
            "    return {'valid': valid, 'score': float(valid), 'message': 'ok' if valid else 'mismatch',"
            " 'details': {}}\n"
            "def verify_task(task, arguments, reference, workspace):\n"
            "    return {'valid': True, 'score': 1.0, 'message': 'checked per call', 'details': {}}\n"
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
runtime:
  type: mcp_stdio
  command: [echo-server]
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
    runner: tool
    tools: [echo]
    input: schemas/input.json
    reference: null
    instructions: Echo the supplied value.
""",
        encoding="utf-8",
    )
    return manifest


def test_loads_strict_plugin_manifest(tmp_path: Path) -> None:
    manifest = load_manifest(write_plugin(tmp_path).parent)
    assert manifest.command == ("echo-server",)
    assert manifest.public()["spec"] == "nanoagent.plugin/v1"


def test_rejects_missing_standard_file(tmp_path: Path) -> None:
    path = write_plugin(tmp_path)
    (tmp_path / "README.md").unlink()
    with pytest.raises(ValueError, match="README.md"):
        load_manifest(path.parent)


@pytest.mark.parametrize("name", ["src", "tests", "schemas", "verifier"])
def test_rejects_missing_standard_folder(tmp_path: Path, name: str) -> None:
    import shutil

    write_plugin(tmp_path)
    shutil.rmtree(tmp_path / name)
    with pytest.raises(ValueError, match=f"{name}/"):
        load_manifest(tmp_path)


def test_env_names_variables_without_values(tmp_path: Path) -> None:
    write_plugin(tmp_path)
    (tmp_path / ".env").write_text("# needed\nAPI_KEY\nREGION=\n", encoding="utf-8")
    assert load_manifest(tmp_path).env == ("API_KEY", "REGION")
    (tmp_path / ".env").write_text("API_KEY=secret\n", encoding="utf-8")
    with pytest.raises(ValueError, match="no value"):
        load_manifest(tmp_path)


def test_failing_run_sh_stops_the_launch(tmp_path: Path) -> None:
    write_plugin(tmp_path)
    (tmp_path / "run.sh").write_text("echo 'API_KEY is not set' >&2\nexit 1\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="API_KEY is not set"):
        call_tool(load_manifest(tmp_path), "echo", {"value": "x"}, workspace=tmp_path)


def test_rejects_unknown_task_tool(tmp_path: Path) -> None:
    path = write_plugin(tmp_path)
    path.write_text(path.read_text().replace("tools: [echo]", "tools: [missing]"))
    with pytest.raises(ValueError, match="undeclared tools"):
        load_manifest(path.parent)


def test_validates_tool_input_before_launch(tmp_path: Path) -> None:
    manifest = load_manifest(write_plugin(tmp_path).parent)
    with pytest.raises(ValueError, match="invalid input"):
        call_tool(manifest, "echo", {"value": 42}, workspace=tmp_path)


def test_runs_standard_verifier(tmp_path: Path) -> None:
    from nanoagent.plugin import verify_input, verify_output

    write_plugin(tmp_path)
    assert verify_input(tmp_path, "echo", {"value": "yes"}).score == 1
    assert verify_output(tmp_path, "echo", {"value": "yes"}, {"ok": True, "value": "no"}, tmp_path).valid is False


@pytest.mark.parametrize(
    ("source", "problem"),
    [
        ("import urllib.request\n", "imports 'urllib.request'"),
        ("from pathlib import os\n", "imports 'os'"),
        ("x = eval('1')\n", "uses eval()"),
        ("x = ''.__class__\n", "uses .__class__"),
        ("from pathlib import Path\nPath('x').write_text('y')\n", "uses .write_text"),
    ],
)
def test_rejects_nondeterministic_verifier_source(tmp_path: Path, source: str, problem: str) -> None:
    write_plugin(tmp_path)
    verifier = tmp_path / "verifier" / "__init__.py"
    verifier.write_text(source + verifier.read_text(), encoding="utf-8")
    with pytest.raises(ValueError, match=re.escape(problem)):
        load_manifest(tmp_path)


def test_rejects_verifier_without_the_standard_functions(tmp_path: Path) -> None:
    write_plugin(tmp_path)
    (tmp_path / "verifier" / "__init__.py").write_text("def verify_input(tool, value):\n    return {}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="defines no verify_output"):
        load_manifest(tmp_path)


def test_rejects_schemas_outside_the_schemas_folder(tmp_path: Path) -> None:
    path = write_plugin(tmp_path)
    (tmp_path / "input.json").write_text((tmp_path / "schemas/input.json").read_text(), encoding="utf-8")
    path.write_text(path.read_text().replace("input: schemas/input.json", "input: input.json"))
    with pytest.raises(ValueError, match="schemas/"):
        load_manifest(path.parent)


def test_fails_a_verifier_whose_two_calls_disagree(tmp_path: Path) -> None:
    from nanoagent.plugin import verify_input

    write_plugin(tmp_path)
    (tmp_path / "verifier" / "__init__.py").write_text(
        "calls = []\n"
        "def verify_input(tool, value):\n"
        "    calls.append(1)\n"
        "    return {'valid': True, 'score': 1 / len(calls), 'message': 'ok', 'details': {}}\n"
        "def verify_output(tool, input_value, output_value, workspace):\n"
        "    return {'valid': True, 'score': 1.0, 'message': 'ok', 'details': {}}\n"
        "def verify_task(task, arguments, reference, workspace):\n"
        "    return {'valid': True, 'score': 1.0, 'message': 'ok', 'details': {}}\n",
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="not deterministic"):
        verify_input(tmp_path, "echo", {"value": "yes"})


@pytest.mark.asyncio
async def test_exposes_plugin_as_agent_tools(tmp_path: Path) -> None:
    manifest = load_manifest(write_plugin(tmp_path).parent)
    tool = plugin_tools(manifest, tmp_path)[0]
    assert tool.to_openai_spec()["function"]["parameters"]["required"] == ["value"]


SERVER = """import json
import os
from pathlib import Path

import anyio
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

server = Server("echo")


@server.list_tools()
async def list_tools():
    schema = lambda name: json.loads(Path("schemas", name).read_text())
    return [types.Tool(name="echo", description="Echo input",
                       inputSchema=schema("input.json"), outputSchema=schema("output.json"))]


@server.call_tool()
async def call_tool(name, arguments):
    Path(os.environ["NANOAGENT_WORKSPACE"], "echo.txt").write_text(arguments["value"])
    return {"ok": True, "value": arguments["value"]}


async def main():
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())

anyio.run(main)
"""


def test_plugin_run_writes_a_slimconfig_run_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import sys

    from slimconfig import load_layout

    from nanoagent.cli.plugin import PluginRunLayout, main

    plugin = tmp_path / "plugin"
    manifest = write_plugin(plugin)
    manifest.write_text(manifest.read_text().replace("[echo-server]", f"[{sys.executable}, src/server.py]"))
    (plugin / "src" / "server.py").write_text(SERVER, encoding="utf-8")
    config = tmp_path / "run.yaml"
    config.write_text(
        f"""_ > nanoagent.cli.plugin.PluginRunConfig:
plugin: {plugin}
task: echo
arguments:
  - value=hello
timeout: 60.0
""",
        encoding="utf-8",
    )
    home = tmp_path / "run"
    monkeypatch.setattr(sys, "argv", ["nanoagent", "plugin", "run"])
    with pytest.raises(SystemExit) as exit_:
        main(["run", f"config={config}", f"home={home}"])
    assert exit_.value.code == 0
    run = load_layout(home, PluginRunLayout)
    assert run.result.response == {"ok": True, "value": "hello"}
    assert (run.workspace / "echo.txt").read_text() == "hello"


def test_verifier_package_may_import_its_own_modules(tmp_path: Path) -> None:
    from nanoagent.plugin import verify_input

    write_plugin(tmp_path)
    (tmp_path / "verifier" / "rules.py").write_text("import re\nVALUE = re.compile('^y')\n", encoding="utf-8")
    init = tmp_path / "verifier" / "__init__.py"
    init.write_text(
        init.read_text().replace("bool(value.get('value'))", "bool(VALUE.match(value['value']))")
        + "from .rules import VALUE\n",
        encoding="utf-8",
    )
    assert verify_input(tmp_path, "echo", {"value": "yes"}).valid is True
    assert verify_input(tmp_path, "echo", {"value": "no"}).valid is False


def test_reports_every_broken_rule_at_once(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    path = write_plugin(tmp_path)
    (tmp_path / "run.sh").unlink()
    (tmp_path / "tests" / "test_echo.py").unlink()
    (tmp_path / ".env").write_text("TOKEN=secret\n", encoding="utf-8")
    path.write_text(path.read_text().replace("name: Echo\n", "name: Echo\nauthor: someone\n"))
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "missing run.sh",
        "tests/ holds no test_*.py",
        ".env line 1 must be a variable NAME with no value",
        "nanoagent.yaml (top level): Additional properties are not allowed ('author' was unexpected)",
    ]


def test_refuses_a_plugin_edited_after_it_loaded(tmp_path: Path) -> None:
    manifest = load_manifest(write_plugin(tmp_path).parent)
    (tmp_path / "verifier" / "__init__.py").write_text(
        "import random\n" + (tmp_path / "verifier" / "__init__.py").read_text(), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="imports 'random'"):
        call_tool(manifest, "echo", {"value": "x"}, workspace=tmp_path)


def test_allows_tool_artifacts_but_refuses_extra_files(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    for artifact in (".git/HEAD", ".venv/pyvenv.cfg", "verifier/__pycache__/x.pyc", "schemas/.DS_Store"):
        (tmp_path / artifact).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / artifact).write_text("", encoding="utf-8")
    load_manifest(tmp_path)

    (tmp_path / "downloads").mkdir()
    (tmp_path / "notes.txt").write_text("", encoding="utf-8")
    (tmp_path / "schemas" / "old.json").write_text("{}", encoding="utf-8")
    (tmp_path / "verifier" / "data.csv").write_text("", encoding="utf-8")
    (tmp_path / "src" / "data.csv").write_text("", encoding="utf-8")
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "unexpected downloads",
        "unexpected notes.txt",
        "unexpected verifier/data.csv: only .py files belong there",
        "unexpected schemas/old.json: schemas/ holds only the schemas tools and tasks reference",
    ]


ROOT = Path(__file__).resolve().parents[1]


def _layout(folder: Path) -> set[str]:
    from nanoagent.plugin.manifest import TOOL_ARTIFACTS

    return {path.name for path in folder.iterdir() if path.name not in TOOL_ARTIFACTS}


def test_the_built_in_reference_plugin_follows_every_rule() -> None:
    manifest = load_manifest(ROOT / "plugins" / "arxiv-source")
    assert [task.id for task in manifest.tasks if task.reference] == ["daily-digest"]


def test_plugin_new_creates_a_plugin_shaped_like_the_reference(tmp_path: Path) -> None:
    from nanoagent.cli.plugin import main

    assert main(["new", str(tmp_path / "my-notes")]) == 0
    manifest = load_manifest(tmp_path / "my-notes")
    assert (manifest.id, manifest.name) == ("my-notes", "My Notes")
    assert _layout(tmp_path / "my-notes") == _layout(ROOT / "plugins" / "arxiv-source")
    assert "{{" not in (tmp_path / "my-notes" / "LICENSE").read_text()
    assert main(["new", str(tmp_path / "my-notes")]) == 1
    assert main(["new", str(tmp_path / "Bad_Name")]) == 1
