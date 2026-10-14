from __future__ import annotations

import base64
import functools
import re
import subprocess
import tempfile
from pathlib import Path

import pytest

from nanoagent.plugin import call_tool, load_manifest, plugin_tools


CONTRACT = """from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    ECHO = "echo"


class Task(Enum):
    ECHO = "echo"


@dataclass
class EchoInput(Output):
    value: Annotated[str, "The value to echo"]


@dataclass
class EchoOutput(Output):
    value: str


TOOLS = {Tool.ECHO: (EchoInput, EchoOutput)}
TASKS = {Task.ECHO: EchoInput}
"""

MANIFEST = """_ > nanoagent.plugin.manifest.ManifestConfig:
id: echo
name: Echo
version: 1.0.0
status: ready
nanoagent: ~=0.3.0
runtime > nanoagent.plugin.manifest.RuntimeConfig:
  type: mcp_stdio
  command: [echo-server]
permissions > nanoagent.plugin.manifest.PermissionsConfig:
  network > nanoagent.plugin.manifest.NetworkConfig: {hosts: []}
  filesystem > nanoagent.plugin.manifest.FilesystemConfig: {write: [workspace]}
tools > dict[contract.Tool, nanoagent.plugin.manifest.ToolConfig]:
  echo:
    description: Echo input
tasks > dict[contract.Task, nanoagent.plugin.manifest.TaskConfig]:
  echo:
    description: Echo input
    runner: tool
    tools: [echo]
    reference: null
    instructions: Echo the supplied value.
"""


PRODUCT = """_ > nanoagent.plugin.manifest.ProductConfig:
tagline: Echo what you say
summary: It repeats its input.
highlights: [Exact, Instant]
steps: [Say something, Hear it back]
"""

ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>\n'


README = """# Echo

## Tools

`echo` repeats its input.

## Layout

The template's.

## Develop and run

`uv run pytest`
"""

PYPROJECT = """[project]
name = "nanoagent-echo"
version = "1.0.0"
requires-python = ">=3.12"
dependencies = []

[tool.pytest.ini_options]
pythonpath = ["."]
"""


@functools.cache
def _uv_lock() -> str:
    """The fixture's lock, as this machine's uv writes it, so the template's run.sh accepts it."""
    with tempfile.TemporaryDirectory() as folder:
        (Path(folder) / "pyproject.toml").write_text(PYPROJECT, encoding="utf-8")
        subprocess.run(["uv", "lock", "--quiet"], cwd=folder, check=True)
        return (Path(folder) / "uv.lock").read_text(encoding="utf-8")


def write_plugin(root: Path) -> Path:
    from nanoagent.plugin.manifest import TEMPLATE

    for name, content in {
        "README.md": README,
        "LICENSE": (TEMPLATE / "LICENSE").read_text().replace("{{year}}", "2026").replace("{{name}}", "Echo"),
        "pyproject.toml": PYPROJECT,
        "uv.lock": _uv_lock(),
        ".gitignore": (TEMPLATE / "dot.gitignore").read_text(),
        ".env": "# no variables\n",
        "run.sh": (TEMPLATE / "run.sh").read_text(),
        "src/echo.py": "",
        "tests/test_verifier.py": "",
        "ui/app.js": (TEMPLATE / "ui" / "app.js").read_text(),
        "ui/app.css": (TEMPLATE / "ui" / "app.css").read_text(),
        "product/product.yaml": PRODUCT,
        "product/icon.svg": ICON,
        "verifier/__init__.py": (
            "def verify_input(tool, value):\n"
            "    return {'valid': bool(value.value), 'score': 1.0, 'message': 'ok', 'details': {}}\n"
            "def verify_output(tool, input_value, output_value, workspace):\n"
            "    valid = output_value.value == input_value.value\n"
            "    return {'valid': valid, 'score': float(valid), 'message': 'ok' if valid else 'mismatch',"
            " 'details': {}}\n"
            "def verify_task(task, arguments, reference, workspace):\n"
            "    return {'valid': True, 'score': 1.0, 'message': 'checked per call', 'details': {}}\n"
        ),
        "contract.py": CONTRACT,
    }.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    manifest = root / "nanoagent.yaml"
    manifest.write_text(MANIFEST, encoding="utf-8")
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


@pytest.mark.parametrize("name", ["src", "tests", "ui", "product", "verifier"])
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
    with (tmp_path / "run.sh").open("a", encoding="utf-8") as run_sh:
        run_sh.write("echo 'API_KEY is not set' >&2\nexit 1\n")
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

    manifest = load_manifest(write_plugin(tmp_path).parent)
    assert verify_input(manifest, "echo", {"value": "yes"}).score == 1
    assert verify_output(manifest, "echo", {"value": "yes"}, {"value": "no"}, tmp_path).valid is False


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


@pytest.mark.parametrize(
    ("change", "problem"),
    [
        ("import os\n", "contract.py:1: imports 'os'"),
        ("from __future__ import annotations\n", "contract.py:1: imports '__future__'"),
        ("print('loaded')\n", "contract.py:1: holds a Expr"),
        ("def f():\n    pass\n", "contract.py:1: holds a FunctionDef"),
        ("X = open('secret')\n", "contract.py:1: uses a Call"),
    ],
)
def test_contract_holds_only_declarations(tmp_path: Path, change: str, problem: str) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    (tmp_path / "contract.py").write_text(change + CONTRACT, encoding="utf-8")
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert problem in error.value.violations[0]


def test_contract_fields_are_required_and_typed(tmp_path: Path) -> None:
    write_plugin(tmp_path)
    contract = tmp_path / "contract.py"
    contract.write_text(CONTRACT.replace("value: str\n", "value: str = 'x'\n"), encoding="utf-8")
    with pytest.raises(ValueError, match="value has a default: every field is required"):
        load_manifest(tmp_path)
    contract.write_text(CONTRACT.replace("value: str\n", "value: set\n"), encoding="utf-8")
    with pytest.raises(ValueError, match="cannot be typed"):
        load_manifest(tmp_path)


def test_every_tool_has_a_contract_entry(tmp_path: Path) -> None:
    write_plugin(tmp_path)
    contract = tmp_path / "contract.py"
    contract.write_text(CONTRACT.replace('    ECHO = "echo"\n\n\nclass Task', '    ECHO = "echo"\n    MORE = "more"\n\n\nclass Task'))
    with pytest.raises(ValueError, match="TOOLS must map every Tool member"):
        load_manifest(tmp_path)


def test_manifest_keys_are_the_contract_tools(tmp_path: Path) -> None:
    path = write_plugin(tmp_path)
    path.write_text(path.read_text().replace("  echo:\n    description: Echo input\ntasks", "  ech:\n    description: Echo input\ntasks"))
    with pytest.raises(ValueError, match="'ech' is not a valid Tool|ech"):
        load_manifest(tmp_path)


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
        verify_input(load_manifest(tmp_path), "echo", {"value": "yes"})


@pytest.mark.asyncio
async def test_exposes_plugin_as_agent_tools(tmp_path: Path) -> None:
    manifest = load_manifest(write_plugin(tmp_path).parent)
    tool = plugin_tools(manifest, tmp_path, session=None)[0]
    assert tool.to_openai_spec()["function"]["parameters"]["required"] == ["value"]


SERVER = """import os
import sys
from pathlib import Path

import anyio
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server
from slimconfig import build_output, output_schema, plain_output

sys.path.insert(0, os.getcwd())
from contract import EchoInput, EchoOutput

server = Server("echo")
CALLS = []


@server.list_tools()
async def list_tools():
    return [types.Tool(name="echo", inputSchema=output_schema(EchoInput), outputSchema=output_schema(EchoOutput))]


@server.call_tool()
async def call_tool(name, arguments):
    given = build_output(arguments, EchoInput)
    if given.value == "fail":
        raise ValueError("asked to fail")
    Path(os.environ["NANOAGENT_WORKSPACE"], "echo.txt").write_text(given.value)
    CALLS.append(given.value)
    # Every value this process has seen: one process for a session keeps them all.
    return plain_output(EchoOutput(value="+".join(CALLS)))


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
arguments: {tmp_path / "arguments.json"}
inputs:
  - {tmp_path / "given.txt"}
timeout: 60.0
""",
        encoding="utf-8",
    )
    (tmp_path / "given.txt").write_text("a file the task reads", encoding="utf-8")
    (tmp_path / "arguments.json").write_text('{"value": "hello"}', encoding="utf-8")
    home = tmp_path / "run"
    monkeypatch.setattr(sys, "argv", ["nanoagent", "plugin", "run"])
    with pytest.raises(SystemExit) as exit_:
        main(["run", f"config={config}", f"home={home}"])
    assert exit_.value.code == 0
    run = load_layout(home, PluginRunLayout)
    assert run.result.response == {"value": "hello"}
    assert (run.workspace / "echo.txt").read_text() == "hello"
    assert (run.workspace / "inputs" / "given.txt").read_text() == "a file the task reads"
    assert run.verdict.valid is True


def test_verifier_package_may_import_its_own_modules(tmp_path: Path) -> None:
    from nanoagent.plugin import verify_input

    write_plugin(tmp_path)
    (tmp_path / "verifier" / "rules.py").write_text("import re\nVALUE = re.compile('^y')\n", encoding="utf-8")
    init = tmp_path / "verifier" / "__init__.py"
    init.write_text(
        init.read_text().replace("bool(value.value)", "isinstance(value, EchoInput) and bool(VALUE.match(value.value))")
        + "from contract import EchoInput\nfrom .rules import VALUE\n",
        encoding="utf-8",
    )
    manifest = load_manifest(tmp_path)
    assert verify_input(manifest, "echo", {"value": "yes"}).valid is True
    assert verify_input(manifest, "echo", {"value": "no"}).valid is False


def test_product_is_what_a_catalog_shows(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    product = load_manifest(tmp_path).public()["product"]
    assert product == {
        "tagline": "Echo what you say",
        "summary": "It repeats its input.",
        "highlights": ["Exact", "Instant"],
        "steps": ["Say something", "Hear it back"],
        "icon": "data:image/svg+xml;base64," + base64.b64encode(ICON.encode()).decode(),
    }
    page = tmp_path / "product" / "product.yaml"
    page.write_text(
        PRODUCT.replace("tagline: Echo what you say", "tagline: ' '")
        .replace("highlights: [Exact, Instant]", "highlights: [Exact]")
        .replace("steps: [Say something, Hear it back]", "steps: [Say something, '']")
    )
    (tmp_path / "product" / "notes.txt").write_text("draft\n")
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "unexpected product/notes.txt",
        "product/product.yaml tagline is blank",
        "product/product.yaml highlights must hold 2 to 4 entries, not 1",
        "product/product.yaml steps has a blank entry",
    ]


@pytest.mark.parametrize(
    ("icon", "problem"),
    [
        ('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "not hold <script>"),
        ('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', "event handler onload"),
        (
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink">'
            '<path x:href="https://example.com/a.svg"/></svg>',
            "link outside itself",
        ),
        ('<svg xmlns="http://www.w3.org/2000/svg"><style>@import "x.css";</style></svg>', "from its <style>"),
        ("<svg/>", "SVG namespace"),
        ("<svg", "not well-formed"),
    ],
)
def test_the_icon_only_draws(tmp_path: Path, icon: str, problem: str) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    (tmp_path / "product" / "icon.svg").write_text(icon)
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert any(problem in violation for violation in error.value.violations), error.value.violations


def test_reports_every_broken_rule_at_once(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    path = write_plugin(tmp_path)
    (tmp_path / "run.sh").unlink()
    (tmp_path / "tests" / "test_verifier.py").unlink()
    (tmp_path / ".env").write_text("TOKEN=secret\n", encoding="utf-8")
    path.write_text(path.read_text().replace("name: Echo\n", "name: Echo\nauthor: someone\n"))
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations[:3] == [
        "missing run.sh",
        "missing tests/test_verifier.py",
        ".env line 1 must be a variable NAME with no value",
    ]
    assert "sets `author`, which is not a field of" in error.value.violations[3]


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
    for artifact in (".git/HEAD", ".venv/pyvenv.cfg", "verifier/__pycache__/x.pyc", "src/.DS_Store"):
        (tmp_path / artifact).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / artifact).write_text("", encoding="utf-8")
    load_manifest(tmp_path)

    (tmp_path / "downloads").mkdir()
    (tmp_path / "notes.txt").write_text("", encoding="utf-8")
    (tmp_path / "schemas").mkdir()
    (tmp_path / "verifier" / "data.csv").write_text("", encoding="utf-8")
    (tmp_path / "src" / "data.csv").write_text("", encoding="utf-8")
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "unexpected downloads",
        "unexpected notes.txt",
        "unexpected schemas",
        "unexpected verifier/data.csv: only .py files belong there",
    ]


ROOT = Path(__file__).resolve().parents[1]


def _layout(folder: Path) -> set[str]:
    from nanoagent.plugin.manifest import TOOL_ARTIFACTS

    return {path.name for path in folder.iterdir() if path.name not in TOOL_ARTIFACTS}


@pytest.mark.parametrize("plugin", sorted(path.name for path in (ROOT / "plugins").iterdir() if path.is_dir()))
def test_every_built_in_plugin_follows_every_rule(plugin: str) -> None:
    assert load_manifest(ROOT / "plugins" / plugin).id == plugin


def test_plugin_new_creates_a_plugin_shaped_like_the_reference(tmp_path: Path) -> None:
    from nanoagent.cli.plugin import main

    assert main(["new", str(tmp_path / "my-notes")]) == 0
    manifest = load_manifest(tmp_path / "my-notes")
    assert (manifest.id, manifest.name) == ("my-notes", "My Notes")
    assert _layout(tmp_path / "my-notes") == _layout(ROOT / "plugins" / "arxiv-source")
    assert "{{" not in (tmp_path / "my-notes" / "LICENSE").read_text()
    assert main(["new", str(tmp_path / "my-notes")]) == 1
    assert main(["new", str(tmp_path / "Bad_Name")]) == 1


def _echo_plugin(tmp_path: Path) -> Path:
    import sys

    plugin = tmp_path / "plugin"
    manifest = write_plugin(plugin)
    manifest.write_text(manifest.read_text().replace("[echo-server]", f"[{sys.executable}, src/server.py]"))
    (plugin / "src" / "server.py").write_text(SERVER, encoding="utf-8")
    # The fixture's verifier wants the output to echo the input; this server reports its history.
    verifier = plugin / "verifier" / "__init__.py"
    verifier.write_text(
        verifier.read_text().replace(
            "output_value.value == input_value.value",
            "output_value.value.endswith(input_value.value)",
        ),
        encoding="utf-8",
    )
    return plugin


async def test_a_session_keeps_one_plugin_process_for_every_call(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginSession

    manifest = load_manifest(_echo_plugin(tmp_path))
    async with PluginSession(manifest, tmp_path, timeout=60) as session:
        assert (await session.call("echo", {"value": "a"}))["value"] == "a"
        assert (await session.call("echo", {"value": "b"}))["value"] == "a+b"
        with pytest.raises(RuntimeError, match="echo echo failed: asked to fail"):
            await session.call("echo", {"value": "fail"})
    with pytest.raises(RuntimeError, match="not open"):
        await session.call("echo", {"value": "c"})


async def test_plugin_tool_images_reach_the_model_as_images() -> None:
    from nanoagent.core.tool import Tool, ToolText

    class Shot(Tool):
        NAME = "shot"
        PARAMETERS = {"type": "object", "properties": {}}

        @property
        def description(self) -> str:
            return "a picture"

        def run(self) -> str:
            return ToolText("{}", images=[{"media_type": "image/png", "data": "iVBORw=="}])

    text, is_error = await Shot().invoke()
    assert (str(text), is_error, text.images) == ("{}", False, [{"media_type": "image/png", "data": "iVBORw=="}])


@pytest.mark.parametrize(
    ("versions", "problem"),
    [
        ("~=0.2.0", "nanoagent.yaml nanoagent: the plugin runs on NanoAgent ~=0.2.0, not this NanoAgent, 0.3.0"),
        ('">=0.4"', "nanoagent.yaml nanoagent: the plugin runs on NanoAgent >=0.4, not this NanoAgent, 0.3.0"),
        ("latest", "nanoagent.yaml nanoagent 'latest' is not a version range, such as ~=0.3.0"),
        ('""', "nanoagent.yaml nanoagent '' is not a version range, such as ~=0.3.0"),
    ],
)
def test_a_plugin_names_the_nanoagent_versions_it_runs_on(tmp_path: Path, versions: str, problem: str) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    manifest = tmp_path / "nanoagent.yaml"
    manifest.write_text(manifest.read_text().replace("nanoagent: ~=0.3.0", f"nanoagent: {versions}"))
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [problem]


def test_ui_is_a_static_web_page(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    (tmp_path / "ui" / "app.js").unlink()
    (tmp_path / "ui" / "app.css").unlink()
    (tmp_path / "ui" / "server.py").write_text("", encoding="utf-8")
    (tmp_path / "ui" / "index.html").write_text("old", encoding="utf-8")
    (tmp_path / "ui" / "kit").mkdir()
    (tmp_path / "ui" / "kit" / "dom.js").write_text("old", encoding="utf-8")
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "missing ui/app.js",
        "missing ui/app.css",
        "unexpected ui/index.html: NanoAgent serves the page's index.html and kit/",
        "unexpected ui/kit/dom.js: NanoAgent serves the page's index.html and kit/",
        "unexpected ui/server.py: ui/ holds only static web files",
    ]


def test_ui_scripts_import_only_what_nanoagent_serves(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    (tmp_path / "ui" / "app.js").write_text(
        'import { chatLayout } from "./kit/components.js";\n'
        'import { helper } from "./lib/helper.js";\n'
        'import { missing } from "./kit/missing.js";\n'
        'import { other } from "./other.js";\n'
        'import lit from "lit";\n'
        'import remote from "https://example.com/x.js";\n'
        'import up from "../contract.js";\n'
        "const later = await import(name);\n"
        "export const page = chatLayout;\n",
        encoding="utf-8",
    )
    (tmp_path / "ui" / "lib").mkdir()
    (tmp_path / "ui" / "lib" / "helper.js").write_text('export { h } from "../kit/dom.js";\n', encoding="utf-8")
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "ui/app.js must export the page's layout as its default export",
        "ui/app.js calls import() with a computed path; import only literal paths",
        "ui/app.js imports './kit/missing.js', which NanoAgent does not serve",
        "ui/app.js imports './other.js', which NanoAgent does not serve",
        "ui/app.js imports 'lit': import only ./ or ../ paths, the kit's or ui/'s own",
        "ui/app.js imports 'https://example.com/x.js': import only ./ or ../ paths, the kit's or ui/'s own",
        "ui/app.js imports '../contract.js', outside ui/",
    ]


def test_serves_the_plugin_page_in_nanoagents_own_kit(tmp_path: Path) -> None:
    from nanoagent.plugin.manifest import PAGE
    from nanoagent.web.app import _ui_file

    write_plugin(tmp_path)
    manifest = load_manifest(tmp_path)
    assert _ui_file(manifest, "") == PAGE / "index.html"
    assert _ui_file(manifest, "kit/dom.js") == PAGE / "kit" / "dom.js"
    assert _ui_file(manifest, "kit/server.py") is None
    assert _ui_file(manifest, "app.js") == (tmp_path / "ui" / "app.js").resolve()
    assert _ui_file(manifest, "../nanoagent.yaml") is None


@pytest.mark.parametrize(
    ("path", "edit", "problem"),
    [
        ("LICENSE", lambda text: text.replace("The Echo authors", "Someone"), "LICENSE must be the template's MIT license"),
        (".gitignore", lambda text: text.replace("*.pyc\n", ""), ".gitignore must ignore *.pyc"),
        ("run.sh", lambda text: "exit 0\n", "run.sh must begin with the template's checks"),
        ("README.md", lambda text: text.replace("# Echo", "# Repeat"), "README.md must open with # Echo"),
        ("README.md", lambda text: text.replace("## Layout\n", ""), "README.md must have the sections"),
        ("README.md", lambda text: text.replace("`echo`", "echo"), "README.md ## Tools does not name echo"),
        ("pyproject.toml", lambda text: text.replace("nanoagent-echo", "echo"), "must name the project nanoagent-echo"),
        ("pyproject.toml", lambda text: text.replace('pythonpath = ["."]', ""), "plugin root on pytest's path"),
    ],
)
def test_standard_files_are_the_templates(tmp_path: Path, path: str, edit, problem: str) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    file = tmp_path / path
    file.write_text(edit(file.read_text() if file.exists() else ""), encoding="utf-8")
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert [violation for violation in error.value.violations if problem in violation], error.value.violations
