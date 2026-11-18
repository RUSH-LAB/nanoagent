"""Case set derivation for the task shapes the echo plugin does not have: agent, decide and tool tasks, with and without a
reference tool, the tools an agent is given, and the shapes that cannot be checked deterministically."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest
from slimconfig import Output

from nanoagent.uploaded import case_sets
from nanoagent.uploaded.case_sets import CaseSet, PreparationError, Refusal, derive_case_set


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
    async def call(manifest: Any, name: str, arguments: dict[str, Any], **_: Any) -> dict[str, Any]:
        if arguments["text"] == "bad":
            raise ValueError("text is bad")
        return {"from": name, "text": arguments["text"]}

    monkeypatch.setattr(case_sets, "call_tool_async", call)


def cases(answer: list[str], refuse: list[str] = (), error: str = "text is bad") -> CaseSet:
    return CaseSet("p", "t", "ctx", [{"text": text} for text in answer], [Refusal({"text": text}, error) for text in refuse])


def derive(manifest: SimpleNamespace, case_set: CaseSet) -> dict[str, Any]:
    return derive_case_set("set-1", case_set, manifest, "a" * 64, 5.0)


def test_an_agent_task_with_a_reference_tool_gives_the_agent_its_tools_but_never_the_reference() -> None:
    body = derive(plugin("agent", reference="truth", tools=("read", "write"), write=("workspace",)), cases(["x"], ["bad"]))
    assert body["task"]["kind"] == "agent" and body["plugin_name"] == "Plugin P" and body["version"] == "2.0.0"
    assert [(t["name"], t["writes"]) for t in body["task"]["tools"]] == [("read", True), ("write", True)]
    assert body["private"] == {"p-01": {"from": "truth", "text": "x"}, "p-02": "text is bad"}


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
    assert body["private"]["p-01"] == {"from": "only", "text": "x"}


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


def test_the_instructions_and_schemas_are_the_manifests() -> None:
    task = derive(plugin("agent", reference="truth", tools=("read",)), cases(["x"]))["task"]
    assert (task["description"], task["instructions"]) == ("Do t", "Default instructions.")
    assert task["input_schema"] == {"type": "object"} and task["output_schema"]["o"] == 1


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
