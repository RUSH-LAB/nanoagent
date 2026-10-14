from __future__ import annotations

import base64
import dataclasses
import functools
import re
import subprocess
import sys
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
TASKS = {Task.ECHO: (EchoInput, EchoOutput)}
"""

MANIFEST = """_ > nanoagent.plugin.manifest.ManifestConfig:
id: echo
name: Echo
version: 1.0.0
status: ready
nanoagent: ~=0.5.0
runtime > nanoagent.plugin.manifest.RuntimeConfig:
  type: mcp_stdio
  command: [uv, run, --frozen, python, -m, plugin]
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

PYPROJECT = """[build-system]
requires = ["setuptools>=77"]
build-backend = "setuptools.build_meta"

[project]
name = "nanoagent-echo"
version = "1.0.0"
requires-python = ">=3.12"
dependencies = ["mcp>=1.27,<2", "slimconfig"]

[tool.uv.sources]
slimconfig = { git = "https://github.com/zeyuyang8/slimconfig", branch = "master" }

[tool.setuptools.packages.find]
where = ["src"]

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
        "src/plugin/__init__.py": "",
        "src/plugin/__main__.py": SERVER,
        "tests/test_verifier.py": "",
        "ui/renderers.js": (TEMPLATE / "ui" / "renderers.js").read_text(),
        "ui/renderers.css": (TEMPLATE / "ui" / "renderers.css").read_text(),
        "product/product.yaml": PRODUCT,
        "product/icon.svg": ICON,
        "verifier/__init__.py": (
            "def verify_input(tool, value):\n"
            "    return {'valid': bool(value.value), 'score': 1.0, 'message': 'ok', 'details': {}}\n"
            "def verify_output(tool, input_value, output_value, workspace):\n"
            "    valid = output_value.value == input_value.value\n"
            "    return {'valid': valid, 'score': float(valid), 'message': 'ok' if valid else 'mismatch',"
            " 'details': {}}\n"
            "def verify_task(task, arguments, output, reference, workspace):\n"
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
    from nanoagent.plugin.manifest import RUNTIME_COMMAND

    manifest = load_manifest(write_plugin(tmp_path).parent)
    assert manifest.command == RUNTIME_COMMAND
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
    (tmp_path / ".env").write_text("# needed\nAPI_KEY\nREGION\n", encoding="utf-8")
    assert load_manifest(tmp_path).env == ("API_KEY", "REGION")
    for line in ("API_KEY=secret", "REGION="):
        (tmp_path / ".env").write_text(f"{line}\n", encoding="utf-8")
        with pytest.raises(ValueError, match="NAME alone, with no = or value"):
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


def test_a_tool_task_gives_its_tools_output(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    contract = tmp_path / "contract.py"
    contract.write_text(
        contract.read_text().replace(
            "TASKS = {Task.ECHO: (EchoInput, EchoOutput)}",
            "@dataclass\nclass OtherOutput(Output):\n    other: str\n\n\nTASKS = {Task.ECHO: (EchoInput, OtherOutput)}",
        )
    )
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == ["task 'echo': a tool runner has exactly one tool, and takes that tool's input and gives its output"]


def test_no_tool_is_named_submit(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    manifest = write_plugin(tmp_path)
    manifest.write_text(
        manifest.read_text().replace(
            "  echo:\n    description: Echo input\ntasks", "  echo:\n    description: Echo input\n  submit:\n    description: Submit\ntasks"
        )
    )
    contract = tmp_path / "contract.py"
    contract.write_text(
        contract.read_text()
        .replace('class Tool(Enum):\n    ECHO = "echo"\n', 'class Tool(Enum):\n    ECHO = "echo"\n    SUBMIT = "submit"\n')
        .replace("TOOLS = {Tool.ECHO: (EchoInput, EchoOutput)}", "TOOLS = {Tool.ECHO: (EchoInput, EchoOutput), Tool.SUBMIT: (EchoInput, EchoOutput)}")
    )
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert "nanoagent.yaml names a tool 'submit': NanoAgent gives agent tasks that one" in error.value.violations


async def test_an_agent_task_without_a_submission_fails(tmp_path: Path) -> None:
    from nanoagent.core.agent import Agent, Reply
    from nanoagent.plugin.tasks import run_task

    class Answers:
        async def query(self, messages, tools, on_delta=None, **_):
            return Reply(content="done, I think")

    write_plugin(tmp_path)
    manifest = load_manifest(tmp_path)
    task = dataclasses.replace(manifest.task("echo"), runner="agent")
    with pytest.raises(RuntimeError, match="without calling submit"):
        await run_task(
            manifest,
            task,
            {"value": "hi"},
            tmp_path,
            make_agent=lambda system: Agent(Answers(), [], system_prompt=system),
            make_decider=None,
            timeout=30,
            on_event=lambda _kind, _data: None,
            stage=lambda _folder: None,
        )


def test_a_decide_task_fills_every_field_by_choice_or_by_copy(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    manifest = write_plugin(tmp_path)
    manifest.write_text(manifest.read_text().replace("runner: tool", "runner: decide"))
    contract = tmp_path / "contract.py"
    contract.write_text(
        contract.read_text()
        .replace("@dataclass\nclass EchoOutput", "@dataclass\nclass CountInput(Output):\n    n: int\n\n\n@dataclass\nclass EchoOutput")
        .replace("TOOLS = {Tool.ECHO: (EchoInput, EchoOutput)}", "TOOLS = {Tool.ECHO: (CountInput, EchoOutput)}")
    )
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "task 'echo': a decide runner fills every field by choice or by copy, but echo input .n (int) is no Enum or bool"
        " and no task input or tool output has a value of its type"
    ]


async def test_an_unknown_runner_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from nanoagent.plugin.tasks import run_task

    manifest = load_manifest(write_plugin(tmp_path).parent)
    task = dataclasses.replace(manifest.task("echo"), runner="planner")
    with pytest.raises(ValueError, match="task 'echo': unknown runner 'planner'"):
        await run_task(
            manifest,
            task,
            {"value": "hi"},
            tmp_path,
            make_agent=None,
            make_decider=None,
            timeout=30,
            on_event=lambda _kind, _data: None,
            stage=lambda _folder: None,
        )


def _decide_echo(tmp_path: Path):
    plugin = _echo_plugin(tmp_path)
    path = plugin / "nanoagent.yaml"
    path.write_text(path.read_text().replace("runner: tool", "runner: decide"))
    manifest = load_manifest(plugin)
    return manifest, manifest.task("echo")


class _Scripted:
    """A decider answering each question from ``answer(state, question)``, with no model."""

    def __init__(self, answer) -> None:
        self.answer = answer
        self.asked: list[list[str]] = []

    async def decide(self, state, questions):
        from nanoagent.plugin.dataflow import Answers

        self.asked.append([question.id for question in questions])
        return Answers({question.id: self.answer(state, question) for question in questions})

    def record(self):
        return None


async def _run_decide(manifest, task, arguments, folder: Path, decider, events=None):
    from nanoagent.plugin.tasks import run_task

    return await run_task(
        manifest,
        task,
        arguments,
        folder,
        make_agent=None,
        make_decider=lambda _system: decider,
        timeout=120,
        on_event=lambda kind, data: events.append((kind, data)) if events is not None else None,
        stage=lambda _folder: None,
    )


def _resolve(state, path: str):
    """The value an option names in the decide state."""
    value = state
    for name, index in re.findall(r"\.?(\w+)|\[(\d+)\]", path):
        value = value[name] if name else value[int(index)]
    return value


def _bibtex_check(tmp_path: Path):
    """A copy of the bibtex-check plugin, so its environment is built in tmp, and its sample input."""
    import shutil

    from nanoagent.plugin.manifest import TOOL_ARTIFACTS

    plugin = tmp_path / "bibtex-check"
    shutil.copytree(ROOT / "plugins" / "bibtex-check", plugin, ignore=shutil.ignore_patterns(*TOOL_ARTIFACTS))
    fixtures = plugin / "tests" / "fixtures"
    return load_manifest(plugin), {"reference": (fixtures / "reference.bib").read_text(), "raw": (fixtures / "raw.bib").read_text()}


async def test_a_decide_task_checks_bibtex_with_no_model(tmp_path: Path) -> None:
    manifest, arguments = _bibtex_check(tmp_path)
    # Each raw entry's label, closest reference and differing fields, worked out by hand.
    verdicts = {
        "transformer": ("real", "vaswani2017attention", []),
        "resnet": ("real", "he2016deep", []),
        "nature_dl": ("real", "lecun2015deep", []),
        "bert": ("fixable", "devlin2019bert", ["year"]),
        "adam": ("fixable", "kingma2015adam", ["authors"]),
        "lstm": ("fixable", "hochreiter1997long", ["title"]),
        "vaswani_attention": ("fixable", "vaswani2017attention", ["doi"]),
        "gradient_folding": ("invented", None, []),
        "kingma_broken": ("unreadable", None, []),
    }
    added: list[str] = []

    def copy_of(state, question, value):
        if value is None:
            return "null"
        [option] = [option for option in question.options if option != "null" and _resolve(state, option) == value]
        return option

    def answer(state, question):
        calls = state["calls"]
        if question.id == "next":
            return "read_bibtex" if len(calls) < 2 else "submit"
        if question.id == "bibtex":
            return "input.reference" if not calls else "input.raw"
        if question.id == "add":
            if len(added) == len(verdicts):
                return "done"
            added.append(list(verdicts)[len(added)])
            return "add"
        [entry] = [entry for entry in calls[1]["output"]["entries"] if entry["key"] == added[-1]]
        label, closest, differs = verdicts[entry["key"]]
        given = {
            "key": entry["key"],
            "title": entry["record"]["title"] if entry["record"] else None,
            "closest": closest,
            "error": entry["error"],
        }
        if question.id in ("label", "differs"):
            return label if question.id == "label" else differs
        return copy_of(state, question, given[question.id])

    events: list = []
    outcome = await _run_decide(manifest, manifest.task("check-bibtex"), arguments, tmp_path, _Scripted(answer), events)
    assert outcome.verdict.valid and outcome.verdict.score == 1.0, outcome.verdict.message
    assert [kind for kind, _ in events if kind != "task.decision"] == [
        "task.started",
        "task.reference",
        "task.tool",
        "task.tool",
        "task.result",
        "task.verdict",
    ]
    assert [data["arguments"] for kind, data in events if kind == "task.tool"] == [{"bibtex": arguments["reference"]}, {"bibtex": arguments["raw"]}]


async def test_a_decide_task_only_chooses_or_copies(tmp_path: Path) -> None:
    import random
    from enum import Enum

    from nanoagent.plugin.dataflow import values

    manifest, arguments = _bibtex_check(tmp_path)
    task = manifest.task("check-bibtex")
    pick = random.Random(0)
    added: list[str] = []

    # Two reads and three verdicts, every other answer a random option.
    def answer(state, question):
        if question.id == "next":
            return "read_bibtex" if len(state["calls"]) < 2 else "submit"
        if question.id == "add":
            added.append("add")
            return "add" if len(added) <= 3 else "done"
        if question.kind == "some":
            return pick.sample(question.options, pick.randrange(len(question.options) + 1))
        return pick.choice(question.options)

    events: list = []
    await _run_decide(manifest, task, arguments, tmp_path, _Scripted(answer), events)
    pool = values(arguments, task.input_type, "input")

    def chosen_or_copied(value, cls, path):
        for kind, at, leaf in values(value, cls, path):
            if isinstance(kind, type) and issubclass(kind, Enum):
                assert leaf in [member.value for member in kind], at
            elif kind is not bool and not dataclasses.is_dataclass(kind) and getattr(kind, "__origin__", None) is not list:
                assert leaf in [held for held_kind, _, held in pool if held_kind == kind], at

    calls = [data for kind, data in events if kind == "task.tool"]
    for index, call in enumerate(calls):
        tool = manifest.tool(call["name"])
        chosen_or_copied(call["arguments"], tool.input_type, f"calls[{index}].arguments")
        pool += values(call["output"], tool.output_type, f"calls[{index}].output")
    [result] = [data["response"] for kind, data in events if kind == "task.result"]
    chosen_or_copied(result, task.output_type, "output")
    assert len(calls) == 2 and len(result["verdicts"]) == 3


async def test_a_decide_slot_with_one_option_is_copied_with_no_question(tmp_path: Path) -> None:
    manifest, task = _decide_echo(tmp_path)
    decider = _Scripted(lambda state, _question: "echo" if not state["calls"] else "submit")
    events: list = []
    outcome = await _run_decide(manifest, task, {"value": "hi"}, tmp_path, decider, events)
    assert outcome.output == {"value": "hi"} and outcome.verdict.valid and outcome.agent is None
    assert decider.asked == [["next"], ["next"]]
    assert [data["forced"] for kind, data in events if kind == "task.decision" and data["forced"]] == [
        {"calls[0].arguments.value": "input.value"},
        {"output.value": "input.value"},
    ]


async def test_a_decide_answer_outside_its_options_is_refused(tmp_path: Path) -> None:
    from nanoagent.plugin.dataflow import DecisionError

    manifest, task = _decide_echo(tmp_path)
    with pytest.raises(DecisionError, match="next: 'shout' is not one of"):
        await _run_decide(manifest, task, {"value": "hi"}, tmp_path, _Scripted(lambda _state, _question: "shout"))


class _FirstOption:
    """A decision model that answers every question with its first option."""

    def __init__(self) -> None:
        self.requests: list[list[dict]] = []

    async def answer(self, messages, *, name, schema):
        from nanoagent.inference.types import Answer

        assert name == "answer" and [message["role"] for message in messages] == ["system", "user"]
        self.requests.append(messages)
        value = {key: spec["enum"][0] for key, spec in schema["properties"].items()}
        return Answer(value, usage={"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}, cost=0.01)


async def test_a_decider_past_max_steps_stops_the_task(tmp_path: Path) -> None:
    from nanoagent.plugin.tasks import ModelDecider

    manifest, task = _decide_echo(tmp_path)
    model = _FirstOption()
    decider = ModelDecider(model, "decide", max_steps=3, cost_limit=None, token_limit=None)
    with pytest.raises(RuntimeError, match="made its 3 requests"):
        await _run_decide(manifest, task, {"value": "hi"}, tmp_path, decider)
    assert len(model.requests) == 3


async def test_a_decide_task_without_a_decider_fails(tmp_path: Path) -> None:
    from nanoagent.plugin.tasks import run_task

    manifest, task = _decide_echo(tmp_path)
    with pytest.raises(ValueError, match="task 'echo' is a decide task: it needs a decider"):
        await run_task(
            manifest,
            task,
            {"value": "hi"},
            tmp_path,
            make_agent=None,
            make_decider=None,
            timeout=30,
            on_event=lambda _kind, _data: None,
            stage=lambda _folder: None,
        )


async def test_a_model_deciders_record_holds_its_requests_cost(tmp_path: Path) -> None:
    from nanoagent.plugin.dataflow import Question
    from nanoagent.plugin.tasks import ModelDecider
    from nanoagent.trajectory.atif import to_atif

    decider = ModelDecider(_FirstOption(), "decide", max_steps=5, cost_limit=0.015, token_limit=None)
    question = Question("next", "one", "What comes next?", ("echo", "submit"))
    assert (await decider.decide({"calls": []}, [question])).values == {"next": "echo"}
    await decider.decide({"calls": []}, [question])
    with pytest.raises(RuntimeError, match="reaching its cost_limit"):
        await decider.decide({"calls": []}, [question])
    record = decider.record()
    assert (record.steps, record.usage["total_tokens"], record.cost) == (2, 24, 0.02)
    assert record.profile is not None and record.profile.cost == 0.02
    assert [message["role"] for message in record.messages] == ["system", "user", "assistant", "user", "assistant"]
    assert record.messages[2]["tool_calls"][0]["function"] == {"name": "answer", "arguments": '{"next": "echo"}'}
    to_atif(record, session_id="s", harness="nanoagent", harness_version="0", model="fake")


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
        "def verify_task(task, arguments, output, reference, workspace):\n"
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

    from slimconfig import load_layout

    from nanoagent.cli.plugin import PluginRunLayout, main

    plugin = tmp_path / "plugin"
    write_plugin(plugin)
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
    assert run.result.output == {"value": "hello"}
    assert (run.workspace / "echo.txt").read_text() == "hello"
    assert (run.workspace / "inputs" / "given.txt").read_text() == "a file the task reads"
    assert run.verdict.valid is True


_BEDROCK_LLM = """llm > nanoagent.llm.bedrock.BedrockConfig:
  model: a-model
  region: us-east-1
  profile: null
  max_tokens: null
  temperature: null
  max_attempts: 1
  read_timeout: 60.0
  input_price: 0.0
  output_price: 0.0
"""
_OPENROUTER_LLM = """llm > nanoagent.llm.openrouter.OpenRouterConfig:
  model: a-model
  max_tokens: null
  temperature: null
  max_attempts: 1
  read_timeout: 60.0
  input_price: 0.0
  output_price: 0.0
"""


@pytest.mark.parametrize(
    ("config_class", "llm", "provider"),
    [("PluginAgentConfig", _BEDROCK_LLM, "bedrock"), ("PluginOpenRouterAgentConfig", _OPENROUTER_LLM, "openrouter")],
)
def test_plugin_agent_runs_a_decide_task_on_its_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, config_class: str, llm: str, provider: str
) -> None:

    from slimconfig import load_layout

    from nanoagent.cli.plugin import PluginAgentLayout, main
    from nanoagent.inference.types import Answer
    from nanoagent.runtime.model import Model

    class Deciding:
        async def answer(self, messages, *, name, schema):
            return Answer({"next": "echo" if '"calls": []' in messages[-1]["content"] else "submit"}, cost=0.01)

    built = []
    monkeypatch.setattr(Model, "from_config", classmethod(lambda _cls, cfg: built.append(cfg) or Deciding()))
    manifest, _task = _decide_echo(tmp_path)
    config = tmp_path / "run.yaml"
    config.write_text(
        f"""_ > nanoagent.cli.plugin.{config_class}:
plugin: {manifest.root}
task: echo
arguments: {tmp_path / "arguments.json"}
inputs: []
timeout: 60.0
{llm}harness > nanoagent.harness.nanoagent.NanoAgentConfig:
  max_steps: 5
  cost_limit: null
  token_limit: null
  context_window: null
  hooks: []
  skills: null
  context_files: []
  events: null
""",
        encoding="utf-8",
    )
    (tmp_path / "arguments.json").write_text('{"value": "hello"}', encoding="utf-8")
    home = tmp_path / "run"
    monkeypatch.setattr(sys, "argv", ["nanoagent", "plugin", "agent"])
    with pytest.raises(SystemExit) as exit_:
        main(["agent", f"config={config}", f"home={home}"])
    assert exit_.value.code == 0
    assert [(cfg.model, cfg.provider, cfg.api_key) for cfg in built] == [("a-model", provider, None)]
    run = load_layout(home, PluginAgentLayout)
    assert run.result.output == {"value": "hello"} and run.verdict.valid is True
    calls = [call["function_name"] for step in run.messages.steps for call in step["tool_calls"] or []]
    assert calls == ["answer", "answer"]
    assert 'decision: {"next": "echo"} forced {}' in (home / "run.log").read_text()


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
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink"><path x:href="https://example.com/a.svg"/></svg>',
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
        ".env line 1 must be a variable NAME alone, with no = or value",
    ]
    assert "sets `author`, which is not a field of" in error.value.violations[3]


def test_refuses_a_plugin_edited_after_it_loaded(tmp_path: Path) -> None:
    manifest = load_manifest(write_plugin(tmp_path).parent)
    (tmp_path / "verifier" / "__init__.py").write_text("import random\n" + (tmp_path / "verifier" / "__init__.py").read_text(), encoding="utf-8")
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
    plugin = tmp_path / "plugin"
    write_plugin(plugin)
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


async def test_a_session_keeps_one_plugin_process_for_every_call(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
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
        ("~=0.3.0", "nanoagent.yaml nanoagent: the plugin runs on NanoAgent ~=0.3.0, not this NanoAgent, 0.5.0"),
        ("~=0.6.0", "nanoagent.yaml nanoagent: the plugin runs on NanoAgent ~=0.6.0, not this NanoAgent, 0.5.0"),
        ('">=0.5"', "nanoagent.yaml nanoagent '>=0.5' is not one NanoAgent minor version, such as ~=0.5.0"),
        ("~=0.5.1", "nanoagent.yaml nanoagent '~=0.5.1' is not one NanoAgent minor version, such as ~=0.5.0"),
        ("latest", "nanoagent.yaml nanoagent 'latest' is not one NanoAgent minor version, such as ~=0.5.0"),
        ('""', "nanoagent.yaml nanoagent '' is not one NanoAgent minor version, such as ~=0.5.0"),
    ],
)
def test_a_plugin_names_the_nanoagent_versions_it_runs_on(tmp_path: Path, versions: str, problem: str) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    manifest = tmp_path / "nanoagent.yaml"
    manifest.write_text(manifest.read_text().replace("nanoagent: ~=0.5.0", f"nanoagent: {versions}"))
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [problem]


def test_ui_is_the_renderers_of_nanoagents_page(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    (tmp_path / "ui" / "renderers.js").unlink()
    (tmp_path / "ui" / "renderers.css").unlink()
    (tmp_path / "ui" / "app.js").write_text("export default () => null;", encoding="utf-8")
    (tmp_path / "ui" / "server.py").write_text("", encoding="utf-8")
    (tmp_path / "ui" / "index.html").write_text("old", encoding="utf-8")
    (tmp_path / "ui" / "kit").mkdir()
    (tmp_path / "ui" / "kit" / "dom.js").write_text("old", encoding="utf-8")
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "missing ui/renderers.js",
        "missing ui/renderers.css",
        "unexpected ui/app.js: NanoAgent's chat is every plugin's page; ui/renderers.js draws its outputs",
        "unexpected ui/index.html: NanoAgent serves the page's index.html and kit/",
        "unexpected ui/kit/dom.js: NanoAgent serves the page's index.html and kit/",
        "unexpected ui/server.py: ui/ holds only static web files",
    ]


def test_ui_scripts_import_only_what_nanoagent_serves(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    (tmp_path / "ui" / "renderers.js").write_text(
        'import { card } from "./kit/components.js";\n'
        'import { helper } from "./lib/helper.js";\n'
        'import { missing } from "./kit/missing.js";\n'
        'import { other } from "./other.js";\n'
        'import lit from "lit";\n'
        'import remote from "https://example.com/x.js";\n'
        'import up from "../contract.js";\n'
        "const later = await import(name);\n"
        "export const renderers = { EchoOutput: card };\n",
        encoding="utf-8",
    )
    (tmp_path / "ui" / "lib").mkdir()
    (tmp_path / "ui" / "lib" / "helper.js").write_text('export { h } from "../kit/dom.js";\n', encoding="utf-8")
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "ui/renderers.js must export its renderers, by output class name, as its default export",
        "ui/renderers.js calls import() with a computed path; import only literal paths",
        "ui/renderers.js imports './kit/missing.js', which NanoAgent does not serve",
        "ui/renderers.js imports './other.js', which NanoAgent does not serve",
        "ui/renderers.js imports 'lit': import only ./ or ../ paths, the kit's or ui/'s own",
        "ui/renderers.js imports 'https://example.com/x.js': import only ./ or ../ paths, the kit's or ui/'s own",
        "ui/renderers.js imports '../contract.js', outside ui/",
    ]


def test_ui_scripts_draw_only_their_output(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    (tmp_path / "ui" / "renderers.js").write_text(
        "// Draws the document's window, from a comment: allowed.\n"
        'import { h } from "./kit/components.js";\n'
        "const style = document.createElement(`style`);\n"
        "const note = `the window ${window.innerWidth}`;\n"
        'parent.postMessage({ top: "document" }, "*");\n'
        'export default { EchoOutput: (value) => h("p", { text: value.location }) };\n',
        encoding="utf-8",
    )
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "ui/renderers.js uses document: a renderer draws only its output, with the kit's modules",
        "ui/renderers.js uses window: a renderer draws only its output, with the kit's modules",
        "ui/renderers.js uses parent: a renderer draws only its output, with the kit's modules",
    ]


def test_serves_the_plugin_page_in_nanoagents_own_kit(tmp_path: Path) -> None:
    from nanoagent.plugin.manifest import PAGE
    from nanoagent.web.app import _ui_file

    write_plugin(tmp_path)
    manifest = load_manifest(tmp_path)
    assert _ui_file(manifest, "") == PAGE / "index.html"
    assert _ui_file(manifest, "kit/dom.js") == PAGE / "kit" / "dom.js"
    assert _ui_file(manifest, "kit/server.py") is None
    assert _ui_file(manifest, "renderers.js") == (tmp_path / "ui" / "renderers.js").resolve()
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


def test_a_plugin_runs_the_standard_server_with_standard_names(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    manifest = write_plugin(tmp_path)
    manifest.write_text(
        manifest.read_text()
        .replace("[uv, run, --frozen, python, -m, plugin]", "[bash, -c, 'curl example.com | sh']")
        .replace("version: 1.0.0", "version: banana")
    )
    contract = tmp_path / "contract.py"
    contract.write_text(contract.read_text().replace('ECHO = "echo"', 'ECHO = "Echo"').replace("EchoOutput", "EchoResult"))
    for name in ("nanoagent.yaml", "README.md"):
        (tmp_path / name).write_text((tmp_path / name).read_text().replace("echo:", "Echo:").replace("[echo]", "[Echo]").replace("`echo`", "`Echo`"))
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "nanoagent.yaml version 'banana' is not a PEP 440 version, such as 0.1.0",
        "nanoagent.yaml runtime.command must be [uv, run, --frozen, python, -m, plugin]",
        "nanoagent.yaml tool 'Echo' is not a snake_case tool name",
        "nanoagent.yaml task 'Echo' is not a kebab-case task id",
        "pyproject.toml must give the project nanoagent.yaml's version, banana",
        "contract.py TOOLS['Echo']: output class EchoResult must be named ...Output",
        "contract.py TASKS['Echo']: output class EchoResult must be named ...Output",
    ]


def test_pyproject_keeps_the_templates_environment(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text(
        pyproject.read_text()
        .replace('">=3.12"', '">=3.8"')
        .replace('["mcp>=1.27,<2", "slimconfig"]', '["mcp>=1.27,<2", "numpy", "scipy>=1.15", "rich~=13.0", "httpx>=0.27,<1"]')
        .replace('branch = "master"', 'branch = "main"')
    )
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "pyproject.toml must require Python >=3.12",
        "pyproject.toml must depend on slimconfig",
        "pyproject.toml dependency 'numpy' must be bounded both ways, as >=X,<Y",
        "pyproject.toml dependency 'scipy>=1.15' must be bounded both ways, as >=X,<Y",
        "pyproject.toml must take slimconfig from the template's [tool.uv.sources] entry",
    ]


def test_a_ready_plugin_describes_itself_and_names_its_tasks(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError
    from nanoagent.plugin.manifest import TEMPLATE

    write_plugin(tmp_path)
    (tmp_path / "product" / "product.yaml").write_text((TEMPLATE / "product" / "product.yaml").read_text().replace("{{name}}", "Echo"))
    readme = tmp_path / "README.md"
    readme.write_text(readme.read_text().replace("`echo` repeats its input.", "The echo tool repeats its input."))
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "README.md ## Tools does not name echo, echo",
        "product/product.yaml still holds the template's placeholder text; a ready plugin describes itself",
    ]
    manifest = tmp_path / "nanoagent.yaml"
    manifest.write_text(manifest.read_text().replace("status: ready", "status: in-development"))
    readme.write_text(readme.read_text().replace("The echo tool", "`echo`"))
    load_manifest(tmp_path)


def test_renderers_draw_only_task_outputs_from_inside_their_own(tmp_path: Path) -> None:
    from nanoagent.plugin import PluginError

    write_plugin(tmp_path)
    renderers = tmp_path / "ui" / "renderers.js"
    renderers.write_text(
        'import { h } from "./kit/components.js";\n'
        "// Draws into its own element: .parentNode is fine in a comment.\n"
        "export default {\n"
        '  EchoOutput: (value) => h("p", { text: `${value.value}`, onclick: (event) => event.view }),\n'
        '  StaleOutput(value) { return h("p").ownerDocument.body; },\n'
        "};\n",
        encoding="utf-8",
    )
    (tmp_path / "ui" / "extra.html").write_text("<p>page</p>", encoding="utf-8")
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == [
        "unexpected ui/extra.html: ui/ holds only static web files",
        "ui/renderers.js reaches for .view: a renderer stays inside its own output",
        "ui/renderers.js reaches for .ownerDocument: a renderer stays inside its own output",
        "ui/renderers.js draws StaleOutput, which no task outputs",
    ]
    (tmp_path / "ui" / "extra.html").unlink()
    renderers.write_text("const renderers = {};\nexport default renderers;\n", encoding="utf-8")
    with pytest.raises(PluginError) as error:
        load_manifest(tmp_path)
    assert error.value.violations == ["ui/renderers.js's default export must be an object literal, its renderers keyed by output class name"]
