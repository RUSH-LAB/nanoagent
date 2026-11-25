"""Case set derivation for the task shapes the echo plugin does not have: agent, decide and tool tasks, with and without a
reference tool, the tools an agent is given, and the shapes that cannot be checked deterministically."""

from __future__ import annotations

import asyncio
import base64
import datetime
import gzip
import hashlib
import io
import re
import tarfile
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from slimconfig import Output

from nanoagent.uploaded import case_sets
from nanoagent.uploaded.case_sets import Case, CaseSet, PreparationError, Refusal, derive_case_set


@dataclass
class Query(Output):
    text: str


def tool(name: str) -> SimpleNamespace:
    return SimpleNamespace(name=name, description=f"{name} tool", input={"in": name}, output={"out": name})


def plugin(runner: str, *, reference: str | None, tools: tuple[str, ...], write: tuple[str, ...] = (), hosts: tuple[str, ...] = ()) -> SimpleNamespace:
    task = SimpleNamespace(
        id="t", runner=runner, reference=reference, tools=tools, description="Do t", instructions="Default instructions.",
        input={"type": "object"}, output={"type": "object", "o": 1}, input_type=Query,
    )  # fmt: skip
    tools_by_name = {name: tool(name) for name in {*tools, *([reference] if reference else [])}}
    return SimpleNamespace(
        id="p", name="Plugin P", version="2.0.0", task=lambda _: task, tool=tools_by_name.__getitem__,
        permissions=SimpleNamespace(filesystem_write=write, network_hosts=hosts),
    )  # fmt: skip


@pytest.fixture(autouse=True)
def reference_tool_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    async def call(manifest: Any, name: str, arguments: dict[str, Any], *, workspace: Path, **_: Any) -> dict[str, Any]:
        if arguments["text"] == "bad":
            raise ValueError("text is bad")
        # What the tool sees of the case's fixtures in its workspace.
        staged = {path.relative_to(workspace).as_posix(): path.read_text() for path in sorted(workspace.rglob("*")) if path.is_file()}
        return {"from": name, "text": arguments["text"], "staged": staged}

    monkeypatch.setattr(case_sets, "call_tool_async", call)


def cases(answer: list[str], refuse: list[str] = (), error: str = "text is bad") -> CaseSet:
    return CaseSet(
        "p", "t", [Case(f"Report {text}.", {"text": text}) for text in answer],
        [Refusal(f"Report {text}.", {"text": text}, error) for text in refuse],
    )  # fmt: skip


def derive(manifest: SimpleNamespace, case_set: CaseSet, base: Path | None = None) -> dict[str, Any]:
    return derive_case_set("set-1", case_set, manifest, "a" * 64, 5.0, base)


AGENT = plugin("agent", reference="truth", tools=("read",))


def test_an_agent_task_with_a_reference_tool_gives_the_agent_its_tools_but_never_the_reference() -> None:
    body = derive(plugin("agent", reference="truth", tools=("read", "write"), write=("workspace",)), cases(["x"], ["bad"]))
    assert body["task"]["kind"] == "agent" and body["plugin_name"] == "Plugin P" and body["version"] == "2.0.0"
    assert [(t["name"], t["writes"]) for t in body["task"]["tools"]] == [("read", True), ("write", True)]
    assert body["private"] == {"p-01": {"from": "truth", "text": "x", "staged": {}}, "p-02": "text is bad"}


def test_a_plugin_that_may_not_write_marks_no_tool_as_writing() -> None:
    body = derive(plugin("agent", reference="truth", tools=("read",)), cases(["x"]))
    assert [t["writes"] for t in body["task"]["tools"]] == [False]


def test_a_reference_tool_listed_among_the_tools_is_not_given_to_the_agent() -> None:
    body = derive(plugin("agent", reference="truth", tools=("read", "truth")), cases(["x"]))
    assert [t["name"] for t in body["task"]["tools"]] == ["read"]


def test_a_decide_task_is_pinned_like_an_agent_task() -> None:
    body = derive(plugin("decide", reference="truth", tools=("read",)), cases(["x"]))
    assert body["task"]["kind"] == "decide" and body["private"]["p-01"]["from"] == "truth"


def test_a_tool_task_pins_its_own_tool() -> None:
    body = derive(plugin("tool", reference=None, tools=("only",)), cases(["x"]))
    assert body["task"]["kind"] == "tool" and [t["name"] for t in body["task"]["tools"]] == ["only"]
    assert body["private"]["p-01"] == {"from": "only", "text": "x", "staged": {}}


@pytest.mark.parametrize("runner", ["agent", "decide"])
def test_a_task_without_a_reference_tool_pins_no_reference_for_its_answer_cases(runner: str) -> None:
    body = derive(plugin(runner, reference=None, tools=("read",)), cases(["x", "y"]))
    assert body["private"] == {"p-01": None, "p-02": None}
    assert [case["kind"] for case in body["cases"]] == ["answer", "answer"]


@pytest.mark.parametrize("runner", ["agent", "decide"])
def test_a_case_to_refuse_needs_a_reference_tool_to_confirm_it(runner: str) -> None:
    with pytest.raises(PreparationError, match="case p-02: task t has no reference tool, so nothing can confirm"):
        derive(plugin(runner, reference=None, tools=("read",)), cases(["x"], ["bad"]))


def test_a_refusal_that_names_no_error_is_refused() -> None:
    with pytest.raises(PreparationError, match="case p-02: a case to refuse names no reference_error"):
        derive(plugin("agent", reference="truth", tools=("read",)), cases(["x"], ["bad"], error=""))


def test_the_schemas_are_the_manifests_and_the_body_has_no_instructions_or_context() -> None:
    body = derive(AGENT, cases(["x"]))
    assert "context" not in body and "instructions" not in body["task"] and body["task"]["description"] == "Do t"
    assert body["task"]["input_schema"] == {"type": "object"} and body["task"]["output_schema"]["o"] == 1
    assert body["cases"] == [{"case_id": "p-01", "kind": "answer", "prompt": "Report x.", "arguments": {"text": "x"}, "fixtures": None, "expected_error": None}]


def test_reference_failures_name_the_case() -> None:
    with pytest.raises(PreparationError, match="case p-02: truth could not answer .* a case to answer: text is bad"):
        derive(plugin("agent", reference="truth", tools=("read",)), cases(["x", "bad"]))


def test_the_pin_function_is_the_plain_reference_call() -> None:
    assert asyncio.run(case_sets.pin(None, None, {"text": "x"}, None, 1.0)) == (None, None)


def test_the_hosts_the_plugin_declares_are_published_sorted_and_without_duplicates() -> None:
    manifest = plugin("agent", reference="truth", tools=("read",), hosts=("b.example.com", "a.example.com", "b.example.com"))
    assert derive(manifest, cases(["x"]))["task"]["egress_hosts"] == ["a.example.com", "b.example.com"]


def test_a_plugin_that_declares_no_hosts_publishes_none() -> None:
    assert derive(plugin("agent", reference="truth", tools=("read",)), cases(["x"]))["task"]["egress_hosts"] == []


def with_fixtures(tmp_path: Path, files: dict[str, str]) -> Path:
    for name, text in files.items():
        (tmp_path / "fx" / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / "fx" / name).write_text(text)
    return tmp_path


def test_a_prompt_that_states_every_argument_passes_the_lint_whitespace_and_numbers_included() -> None:
    @dataclass
    class Many(Output):
        text: str
        n: float
        flag: bool
        nothing: str | None
        empty: str

    manifest = plugin("agent", reference="truth", tools=("read",))
    manifest.task = lambda _: SimpleNamespace(**{**vars(plugin("agent", reference="truth", tools=("read",)).task(None)), "input_type": Many})
    arguments = {"text": "two  words", "n": 3.0, "flag": True, "nothing": None, "empty": ""}
    case_set = CaseSet("p", "t", [Case("Use two\nwords and 3 please", arguments)])
    assert derive(manifest, case_set)["cases"][0]["arguments"] == arguments


@pytest.mark.parametrize("prompt", [" Report 1.", "Report 1.\n", "\tReport 1."])
def test_a_prompt_that_starts_or_ends_with_whitespace_is_refused_naming_the_case(prompt: str) -> None:
    with pytest.raises(PreparationError, match="case p-02: the prompt starts or ends with whitespace"):
        derive(AGENT, CaseSet("p", "t", [Case("Report x.", {"text": "x"}), Case(prompt, {"text": "x"})]))


def test_a_prompt_that_omits_an_argument_names_it() -> None:
    with pytest.raises(PreparationError, match=r"case p-01: the prompt does not state argument text \(y\)"):
        derive(AGENT, CaseSet("p", "t", [Case("Report nothing.", {"text": "y"})]))


def test_the_lint_names_a_nested_argument_by_its_dotted_path() -> None:
    nested = {"text": "x", "rows": [{"id": 42}]}
    with pytest.raises(PreparationError, match=r"argument rows\.0\.id \(42\)"):
        case_sets.lint("p-01", Case("Report x.", nested))
    case_sets.lint("p-01", Case("Report x and 42.", nested))


def test_arguments_that_do_not_build_into_the_input_are_refused() -> None:
    with pytest.raises(PreparationError, match="case p-01: its arguments do not fit the input of task t"):
        derive(AGENT, CaseSet("p", "t", [Case("Report 1.", {"wrong": 1})]))


def test_a_case_to_refuse_is_answered_refused_with_its_fixtures_staged(tmp_path: Path) -> None:
    base = with_fixtures(tmp_path, {"inputs/a.csv": "a"})
    case_set = cases(["x"], ["bad"])
    case_set.refuse[0].fixtures = "fx"
    body = derive(AGENT, case_set, base)
    assert body["cases"][1]["kind"] == "refuse" and body["private"]["p-02"] == "text is bad"
    assert body["cases"][1]["expected_error"] == "text is bad" and body["cases"][1]["fixtures"]["files"].keys() == {"inputs/a.csv"}


def test_fixtures_are_staged_for_the_reference_tool_and_packed(tmp_path: Path) -> None:
    base = with_fixtures(tmp_path, {"inputs/a.csv": "alpha", "b.txt": "beta"})
    case_set = cases(["x"])
    case_set.cases[0].fixtures = "fx"
    body = derive(AGENT, case_set, base)
    assert body["private"]["p-01"]["staged"] == {"b.txt": "beta", "inputs/a.csv": "alpha"}
    fixtures = body["cases"][0]["fixtures"]
    assert fixtures["files"] == {"b.txt": hashlib.sha256(b"beta").hexdigest(), "inputs/a.csv": hashlib.sha256(b"alpha").hexdigest()}
    data = base64.b64decode(fixtures["archive"])
    assert fixtures["sha256"] == hashlib.sha256(data).hexdigest()
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data))) as tar:
        assert [(m.name, m.mtime, m.uid, m.gid, m.uname) for m in tar.getmembers()] == [
            ("b.txt", 0, 0, 0, ""), ("inputs", 0, 0, 0, ""), ("inputs/a.csv", 0, 0, 0, ""),
        ]  # fmt: skip


def test_the_fixtures_archive_is_deterministic(tmp_path: Path) -> None:
    base = with_fixtures(tmp_path, {"inputs/a.csv": "alpha", "b.txt": "beta"})
    case_set = cases(["x"])
    case_set.cases[0].fixtures = "fx"
    first, second = derive(AGENT, case_set, base), derive(AGENT, case_set, base)
    assert first["cases"][0]["fixtures"]["sha256"] == second["cases"][0]["fixtures"]["sha256"]
    assert first["cases"][0]["fixtures"]["archive"] == second["cases"][0]["fixtures"]["archive"]


def test_fixtures_resolve_against_an_uploaded_files_map() -> None:
    case_set = cases(["x"])
    case_set.cases[0].fixtures = "./fixtures/one"
    uploaded = {"fixtures/one/a.txt": b"hi", "fixtures/one/inputs/b.txt": b"yo", "fixtures/two/c.txt": b"no"}
    body = derive(AGENT, case_set, uploaded)
    assert body["private"]["p-01"]["staged"] == {"a.txt": "hi", "inputs/b.txt": "yo"}
    assert body["cases"][0]["fixtures"]["files"].keys() == {"a.txt", "inputs/b.txt"}


@pytest.mark.parametrize("folder", ["fixtures/missing", "../fixtures/one", "/fixtures/one", "fixtures\\one"])
def test_a_fixtures_folder_that_is_not_in_the_uploaded_files_is_refused(folder: str) -> None:
    case_set = cases(["x"])
    case_set.cases[0].fixtures = folder
    with pytest.raises(PreparationError, match="case p-01: the fixtures .* (are not inside the case folder|are not a folder of the uploaded case folder)"):
        derive(AGENT, case_set, {"fixtures/one/a.txt": b"hi"})


def test_uploaded_file_paths_must_stay_inside_the_case_folder() -> None:
    assert case_sets.decode_files({"a/b.txt": "aGk="}) == {"a/b.txt": b"hi"}
    for bad in ({"../a": "aGk="}, {"/a": "aGk="}, {"a": "!!"}):
        with pytest.raises(PreparationError, match="the uploaded file"):
            case_sets.decode_files(bad)


def test_a_fixture_the_platform_reserves_at_the_root_is_refused_from_a_folder_and_from_a_files_map(tmp_path: Path) -> None:
    case_set = cases(["x"])
    case_set.cases[0].fixtures = "fx"
    with pytest.raises(PreparationError, match="case p-01: the fixtures hold answer.json at their root, which the platform reserves"):
        derive(AGENT, case_set, with_fixtures(tmp_path, {"answer.json": "{}"}))
    with pytest.raises(PreparationError, match="case p-01: the fixtures hold answer.json at their root"):
        derive(AGENT, case_set, {"fx/answer.json": b"{}"})
    # `.rush/` is the session's: a fixture there would be dropped from the frozen workspace.
    for reserved in (".rush", ".rush/agents"):
        with pytest.raises(PreparationError, match=f"case p-01: the fixtures hold {reserved} at their root, which the platform reserves"):
            derive(AGENT, case_set, {f"fx/{reserved}": b"x"})
    # Deeper down it is an ordinary file.
    assert derive(AGENT, case_set, {"fx/inputs/answer.json": b"{}"})["cases"][0]["fixtures"]["files"].keys() == {"inputs/answer.json"}


CASE_FILE = """\
plugin: p
task: t
cases:
  - prompt: |
      Report x.

        Indented line, "quotes", 'apostrophes', # not a comment, and: colons.
    arguments:
      text: x
    fixtures: fx
refuse:
  - prompt: |-
      Report bad.
    arguments:
      text: bad
    reference_error: text is bad
"""


def test_a_yaml_case_file_loads_with_its_prompts_byte_for_byte() -> None:
    case_set = case_sets.parse_case_file(CASE_FILE)
    assert case_set.cases[0].prompt == 'Report x.\n\n  Indented line, "quotes", \'apostrophes\', # not a comment, and: colons.\n'
    assert case_set.cases[0].fixtures == "fx" and case_set.refuse[0].fixtures is None
    assert case_set.refuse[0].prompt == "Report bad." and case_set.refuse[0].reference_error == "text is bad"


def test_a_yaml_syntax_error_names_its_line() -> None:
    with pytest.raises(PreparationError, match=r"not valid YAML at line 5, column"):
        case_sets.parse_case_file("plugin: p\ntask: t\ncases:\n  - prompt: [unclosed\n    arguments: {}\n")


def test_a_case_file_that_is_not_a_mapping_is_refused() -> None:
    with pytest.raises(PreparationError, match="must be a YAML mapping"):
        case_sets.parse_case_file("- just\n- a list\n")


def test_the_old_case_file_shape_is_refused() -> None:
    old = "plugin: p\ntask: t\ncontext: c\nanswer:\n  - text: x\nrefuse: []\n"
    with pytest.raises(PreparationError, match="case file shape.*(context|answer)"):
        case_sets.parse_case_file(old)


def test_a_symlink_among_the_fixtures_is_refused_naming_its_path(tmp_path: Path) -> None:
    base = with_fixtures(tmp_path, {"a.txt": "a"})
    (tmp_path / "fx" / "link").symlink_to(tmp_path / "fx" / "a.txt")
    case_set = cases(["x"])
    case_set.cases[0].fixtures = "fx"
    with pytest.raises(PreparationError, match="the fixture link is a symlink"):
        derive(AGENT, case_set, base)


def test_a_fixtures_folder_outside_the_case_file_folder_is_refused(tmp_path: Path) -> None:
    (tmp_path / "base").mkdir()
    with_fixtures(tmp_path, {"a.txt": "a"})
    case_set = cases(["x"])
    case_set.cases[0].fixtures = "../fx"
    with pytest.raises(PreparationError, match="the fixtures ../fx are not inside"):
        derive(AGENT, case_set, tmp_path / "base")


@pytest.mark.parametrize(("value", "prompt"), [("5", "Process 15 items."), ("a.csv", "Read data.csv."), ("5", "Take 1.5 cups."), ("data.csv", "Read dir/data.csv.")])
def test_the_lint_refuses_an_argument_the_prompt_only_holds_inside_a_longer_token(value: str, prompt: str) -> None:
    with pytest.raises(PreparationError, match=rf"case p-01: the prompt does not state argument text \({re.escape(value)}\)"):
        case_sets.lint("p-01", Case(prompt, {"text": value}))
    case_sets.lint("p-01", Case(f"Use {value}.", {"text": value}))


def test_the_lint_refuses_an_argument_of_a_type_it_cannot_check_naming_the_case() -> None:
    with pytest.raises(PreparationError, match=r"case p-01: argument day is a date \(datetime.date\(2024, 1, 2\)\), which the prompt lint cannot check"):
        case_sets.lint("p-01", Case("Report 2024-01-02.", {"day": datetime.date(2024, 1, 2)}))


def test_a_refusal_whose_error_names_the_scratch_folder_is_refused_naming_the_case(monkeypatch: pytest.MonkeyPatch) -> None:
    async def call(manifest: Any, name: str, arguments: dict[str, Any], *, workspace: Path, **_: Any) -> dict[str, Any]:
        raise ValueError(f"text is bad: no {workspace}/in.csv")

    monkeypatch.setattr(case_sets, "call_tool_async", call)
    with pytest.raises(PreparationError, match="case p-01: truth's rejection of .* names its scratch folder"):
        derive(AGENT, CaseSet("p", "t", [], [Refusal("Report bad.", {"text": "bad"}, "text is bad")]))


@pytest.mark.parametrize("folder", [".", "./", "fx/.."])
def test_a_fixtures_folder_that_holds_the_case_file_is_refused_naming_the_case(tmp_path: Path, folder: str) -> None:
    base = with_fixtures(tmp_path, {"a.txt": "a"})
    (base / "cases.yaml").write_text("plugin: p")
    case_set = cases(["x"])
    case_set.cases[0].fixtures = folder
    with pytest.raises(PreparationError, match="case p-01: the fixtures .* hold the case file itself"):
        derive(AGENT, case_set, base)


@pytest.mark.parametrize("compat", [False, True], ids=["case file", "COMPAT(case-set-cases)"])
@pytest.mark.parametrize(
    ("schema", "problem"),
    [
        ({"anyOf": [{"type": "string"}, {"type": "integer"}]}, r"anyOf without a null branch"),
        ({"oneOf": [{"type": "string"}, {"type": "integer"}]}, r"oneOf without a null branch"),
        ({"enum": [{"a": 1}]}, r"an enum or const of non-scalar values has no skeleton"),
        ({"allOf": [{"type": "string"}]}, r"the schema's type None has no skeleton"),
        ({"not": {"type": "string"}}, r"the schema's type None has no skeleton"),
    ],
)
def test_an_output_schema_the_worker_cannot_skeleton_fails_publishing(schema: dict[str, Any], problem: str, compat: bool) -> None:
    manifest = plugin("agent", reference="truth", tools=("read",))
    task = SimpleNamespace(**{**vars(manifest.task(None)), "output": {"type": "object", "properties": {"n": schema}}})
    manifest.task = lambda _: task
    match = rf"task t: output_schema_unsupported: \$\.n: .*{problem}"
    with pytest.raises(PreparationError, match=match):
        if compat:  # COMPAT(case-set-cases)
            old = case_sets.CompatCaseSet("p", "t", "context", [{"text": "x"}], [])
            case_sets.compat_derive_case_set("set-1", old, manifest, "a" * 64, 5.0)
        else:
            derive(manifest, cases(["x"]))
