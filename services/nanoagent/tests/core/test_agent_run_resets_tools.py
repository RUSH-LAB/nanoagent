"""Offline test pinning that Agent.run resets EVERY registered tool at run-start
(:meth:`nanoagent.core.agent.Agent.run`).

nanoagent is the rollout layer whose ``run_batch`` reuses ONE
:class:`~nanoagent.core.agent.Agent` across many fanned-out tasks. The per-task isolation
contract that makes that reuse safe lives at the very top of :meth:`Agent.run`::

    for tool in self._tools.values():
        tool.reset()

so each task starts every registered tool from a clean slate and no per-tool state (e.g. a
stateful tool's per-task retrieval budget) leaks from the prior task. Nothing drove
``Agent.run`` to confirm this: ``test_tool_base`` calls ``Tool.reset()`` in isolation,
``test_code.py`` test ``CodeExec.reset`` directly, and the twice-run agent tests
(``test_agent_cost_accumulate``, ``test_agent_token_limit``) build a FRESH Agent with
stateless tools that never override ``reset``. So DELETING that loop passes the entire
existing suite.

This drives the SAME Agent across two ``run`` calls with two tools whose ``reset()`` bumps a
counter; the scripted model answers on turn 1 with no tool call, so each run does exactly one
query and ends on :attr:`~nanoagent.core.agent.StopReason.ANSWER` without ever invoking a tool —
the counters move ONLY because run-start reset fired. Registering two distinctly-named tools
pins the loop visiting EVERY tool (not just the first), and asserting 0 -> 1 -> 2 pins
once-per-run (not once-in-``__init__``, nor once-ever). Deleting the loop leaves both counters
at 0, so the test FAILS — non-vacuity.

What it consumes: :class:`nanoagent.core.agent.Agent` driven by an in-process scripted ChatModel +
two reset-counting tools — mirrors ``test_agent_cost_accumulate`` / ``test_agent_token_limit``
(no model server, network, or GPU; no side effects).

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_run_resets_tools.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason
from nanoagent.core.tool import JsonSchema, Tool


class _ResetCountingTool(Tool):
    """A tool whose ``reset()`` bumps ``reset_count`` so the test can observe Agent.run call it.

    ``run`` is never reached here (the model answers with no tool call); only the run-start
    reset is exercised. Each instance carries its own counter, so registering two proves the
    reset loop visits every tool, not just the first.
    """

    NAME = "counter_a"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def __init__(self) -> None:
        self.reset_count = 0

    def run(self) -> str:
        return "ok"

    def reset(self) -> None:
        self.reset_count += 1


class _SecondResetCountingTool(_ResetCountingTool):
    """A second reset-counting tool with a distinct NAME, so the two register without colliding
    and the test pins the reset loop iterating over EVERY registered tool."""

    NAME = "counter_b"


class _AnswerOnTurnOneModel:
    """Scripted :class:`~nanoagent.core.agent.ChatModel` that answers immediately with no tool call.

    Each ``query`` returns a final-answer :class:`~nanoagent.core.agent.Reply` (no ``tool_calls``),
    so :meth:`Agent.run` does exactly one query and ends on ANSWER without dispatching a tool.
    ``turns`` records how many queries ran. Mirrors the in-process mocks in
    ``test_agent_cost_accumulate`` / ``test_agent_token_limit`` (incl. the ``on_delta`` kwarg the
    real model backend accepts); no server is contacted.
    """

    def __init__(self) -> None:
        self.turns = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.turns += 1
        return Reply(content="DONE")


async def test_run_resets_every_registered_tool_once_per_run() -> None:
    # The shared-agent fan-out contract: ONE Agent reused across tasks must reset every
    # registered tool at the start of EVERY run, so per-task tool state never leaks across tasks.
    model = _AnswerOnTurnOneModel()
    # Concrete-typed so .reset_count resolves; passed as an inline list literal so expected-type
    # inference types it as list[Tool] for Agent (mirrors the siblings' `[_NoopTool()]`).
    tool_a = _ResetCountingTool()
    tool_b = _SecondResetCountingTool()
    agent = Agent(model, [tool_a, tool_b], system_prompt="SYS", max_steps=5)

    # Construction must NOT reset (only Agent.run does) — pins reset isn't called in __init__.
    assert (tool_a.reset_count, tool_b.reset_count) == (0, 0)

    result1 = await agent.run("task one")
    assert result1.stop_reason == StopReason.ANSWER  # answered turn 1, no tool call dispatched
    assert model.turns == 1  # one query, answered immediately
    assert (tool_a.reset_count, tool_b.reset_count) == (1, 1)  # run-start reset fired on EVERY tool

    # Re-run the SAME agent (the fan-out reuse): each tool is reset again, exactly once more.
    result2 = await agent.run("task two")
    assert result2.stop_reason == StopReason.ANSWER
    assert model.turns == 2  # the second run did its own single query
    assert (tool_a.reset_count, tool_b.reset_count) == (2, 2)  # 0 -> 1 -> 2: once per run, not once-ever
