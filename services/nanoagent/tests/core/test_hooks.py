"""Offline tests for :mod:`nanoagent.core.hooks` and its four call sites in :meth:`Agent.run`.

The motivating case is concrete. A harness config whose system prompt says "Call search AT MOST
ONCE" is stating a budget in prose the model may simply ignore — the tools stay general and
enforce nothing. So the headline test writes a
``before_tool`` hook that counts ``search`` calls in :attr:`HookContext.state` and refuses the
second, and pins that the agent's second call really does come back refused, with the tool never
having run.

Also pinned:

* ``before_llm`` injects its string as a user turn, ONCE per step (the malformed-arg retry loop
  re-queries within a step, and a reminder per attempt would stack up copies).
* ``session_start`` fires once per run and ``state`` is per-RUN — a shared ``Agent`` is reused
  across concurrent rollouts, so a budget living on the agent would be one budget K rollouts
  spend from at once. This is the property that would break silently in production and never in
  a single-rollout test, so it is driven through ``asyncio.gather``.
* ``hooks=None`` (the ``hooks: []`` default of every existing config) makes no hook call at all.

Fully offline: scripted in-process models and tools, no server, network or GPU.

Run (from the repo root)::

    python3 -m pytest tests/core/test_hooks.py -x -q
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.hooks import HookContext, Hooks
from nanoagent.extensions import get_hooks
from nanoagent.core.tool import JsonSchema, Tool

_BUDGET_HOOK = '''
"""One search per run, enforced."""


def before_tool(ctx):
    if ctx.tool_name != "search":
        return None
    used = ctx.state.get("search", 0)
    ctx.state["search"] = used + 1
    if used >= 1:
        return "budget exhausted: you may call search only once per question"
    return None
'''


class _Search(Tool):
    """A search tool that records every call it actually runs."""

    NAME = "search"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    }

    def __init__(self) -> None:
        self.queries: list[str] = []

    def run(self, query: str) -> str:
        self.queries.append(query)
        return f"results for {query}"


class _CallsSearchThenAnswers:
    """Calls ``search`` on the first ``n_calls`` turns, then answers.

    Which turn it is comes from the TRANSCRIPT, not a counter on ``self``: this stands in for a
    real model, which is likewise one shared object serving every concurrent rollout, and a
    counter here would make two gathered runs interfere in the fixture rather than in the code
    under test.
    """

    def __init__(self, n_calls: int = 2) -> None:
        self.n_calls = n_calls
        self.turns = 0

    async def query(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], **_: Any
    ) -> Reply:
        self.turns += 1
        done = sum(1 for m in messages if m.get("role") == "assistant")
        if done >= self.n_calls:
            return Reply(content="DONE")
        return Reply(
            content=None,
            tool_calls=[ToolCall(f"c{done}", "search", '{"query": "q"}')],
        )


def _hook_yaml(tmp_path: Path, body: str, name: str = "budget") -> str:
    """Write a hook module plus the YAML that names it; return the YAML path."""
    (tmp_path / f"{name}.py").write_text(body)
    yaml = tmp_path / f"{name}.yaml"
    yaml.write_text(f"code: {tmp_path / f'{name}.py'}\n")
    return str(yaml)


async def test_before_tool_enforces_a_per_run_search_budget(tmp_path: Path) -> None:
    # The point of hooks: the harness's "call search AT MOST ONCE" becomes enforced, not asked.
    tool = _Search()
    model = _CallsSearchThenAnswers()
    agent = Agent(
        model,
        [tool],
        system_prompt="SYS",
        max_steps=5,
        hooks=get_hooks([_hook_yaml(tmp_path, _BUDGET_HOOK)]),
    )
    result = await agent.run("a question")

    assert result.stop_reason == StopReason.ANSWER
    assert tool.queries == ["q"]  # the SECOND call never reached the tool
    outputs = [row["output"] for row in result.tool_calls]
    assert outputs[0] == "results for q"
    assert outputs[1].startswith("budget exhausted")
    assert result.tool_calls[1]["is_error"] is True  # reads to the model as a refusal


async def test_state_is_per_run_not_shared_across_concurrent_rollouts(tmp_path: Path) -> None:
    # One Agent is deliberately shared across a fan-out. If the budget lived on the Agent, the
    # two rollouts below would spend ONE budget between them and the second would start refused.
    hooks = get_hooks([_hook_yaml(tmp_path, _BUDGET_HOOK)])
    agent = Agent(
        _CallsSearchThenAnswers(), [_Search()], system_prompt="SYS", max_steps=5, hooks=hooks
    )
    a, b = await asyncio.gather(agent.run("one"), agent.run("two"))
    for result in (a, b):
        # Each rollout gets its own full budget: first call served, second refused.
        assert [row["output"].startswith("budget") for row in result.tool_calls] == [False, True]


async def test_before_llm_injects_a_reminder_once_per_step(tmp_path: Path) -> None:
    hook = '''
def before_llm(ctx):
    return "REMINDER"
'''
    model = _CallsSearchThenAnswers(n_calls=1)
    agent = Agent(
        model,
        [_Search()],
        system_prompt="SYS",
        max_steps=5,
        hooks=get_hooks([_hook_yaml(tmp_path, hook, "remind")]),
    )
    result = await agent.run("a question")
    reminders = [m for m in result.messages if m.get("content") == "REMINDER"]
    assert len(reminders) == model.turns == 2  # one per step, none duplicated
    assert all(m["role"] == "user" for m in reminders)


async def test_session_start_fires_once_per_run_with_the_live_transcript(tmp_path: Path) -> None:
    hook = '''
def session_start(ctx):
    ctx.state["seen"] = len(ctx.messages)
    ctx.messages.append({"role": "user", "content": "PREAMBLE"})


def after_tool(ctx):
    assert ctx.state["seen"] == 2  # system + task, before the preamble
'''
    model = _CallsSearchThenAnswers(n_calls=1)
    agent = Agent(
        model,
        [_Search()],
        system_prompt="SYS",
        max_steps=5,
        hooks=get_hooks([_hook_yaml(tmp_path, hook, "start")]),
    )
    result = await agent.run("a question")
    assert [m["content"] for m in result.messages].count("PREAMBLE") == 1


async def test_no_hooks_configured_makes_no_hook_call() -> None:
    # `hooks: []` is what every existing config sets, and must be identical to before hooks existed.
    assert get_hooks([]) is None
    tool = _Search()
    agent = Agent(_CallsSearchThenAnswers(n_calls=1), [tool], system_prompt="SYS", max_steps=5)
    result = await agent.run("a question")
    assert result.stop_reason == StopReason.ANSWER
    assert tool.queries == ["q"]  # nothing intercepted


def test_first_non_none_wins_and_later_hooks_do_not_overwrite() -> None:
    class _Mod:
        @staticmethod
        def before_tool(ctx: HookContext) -> str:
            return "first"

    class _Mod2:
        @staticmethod
        def before_tool(ctx: HookContext) -> str:
            return "second"

    run = Hooks([_Mod, _Mod2]).begin([])
    assert run.fire("before_tool", step=0, tool_name="x") == "first"


def test_a_module_with_no_hook_function_is_rejected(tmp_path: Path) -> None:
    # A typo'd trigger name would otherwise load as a hook that silently never fires.
    yaml = _hook_yaml(tmp_path, "def befor_tool(ctx):\n    return None\n", "typo")
    with pytest.raises(ValueError, match="defines no hook function"):
        get_hooks([yaml])
