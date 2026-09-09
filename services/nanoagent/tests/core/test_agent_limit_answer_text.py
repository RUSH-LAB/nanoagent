"""Pin Agent.run's terminal answer = ``last_assistant_text`` on the MAX_STEPS and COST_LIMIT paths.

nanoagent is the ROLLOUT layer, and flow control caps each rollout's turns/cost to bound
worst-case task time; when a cap stops the loop there is no clean
final reply, so :meth:`~nanoagent.core.agent.Agent.run` surfaces a best-effort answer via
:func:`~nanoagent.core.agent.last_assistant_text` — the last assistant message that carried content.
Both cap paths do this (``agent.py``: COST_LIMIT and MAX_STEPS), but only the ERROR path's
identical use is pinned (``test_agent_error_path.py``).

These two were UNCOVERED for the *answer*: the existing limit tests
(``test_agent_run_limits.py``, ``test_agent_cost_limit_boundary.py``) assert
``stop_reason``/``steps``/``cost``/``turns`` but never ``answer``, and their
``_NeverAnswersModel`` emits ``content=None``, so ``last_assistant_text`` returns ``""``
regardless — a mutation hardcoding either terminal answer to ``""`` survives the whole suite.
This file drives the complement: a scripted model that emits assistant
``content`` on every tool-call turn but never a final answer, so ``assistant_message``
preserves that content and the terminal ``last_assistant_text`` returns it.

  * MAX_STEPS  — ``max_steps=2``, no cost cap; the model only ever emits tool calls, so the loop
    exhausts ``range(max_steps)`` and returns ``StopReason.MAX_STEPS`` with the last assistant
    text as the answer.
  * COST_LIMIT — ``cost_limit`` below the per-turn cost; one turn runs (cost crosses the cap),
    then the top-of-loop guard trips and returns ``StopReason.COST_LIMIT`` with that turn's
    assistant text as the answer.

Non-vacuity (prove by mutation, then revert): hardcoding the MAX_STEPS terminal answer to ``""``
fails the first test; hardcoding the COST_LIMIT terminal answer to ``""`` fails the second; each
is an independent single-line change and the rest of the ``src/nanoagent`` suite stays green.

Everything is in-process: a scripted :class:`_ProgressModel` and a no-op tool; no model server,
GPU, or network. Mirrors ``test_agent_run_limits._NeverAnswersModel`` (incl. the ``on_delta``
kwarg the model backend accepts), but carries non-empty ``content`` each turn.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_limit_answer_text.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool

# The assistant content the model carries every turn; the same value the cap-path answer must
# surface, so coupling both sides to one constant pins "answer == the last assistant text".
_PARTIAL = "partial progress"


class _NoopTool(Tool):
    """A no-op tool: the scripted model's calls dispatch here so a turn can complete."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _ProgressModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` that carries content but NEVER answers.

    Every ``query`` returns one ``noop`` tool call AND non-empty ``content`` (``_PARTIAL``), so
    the loop can only end on a cap while each turn leaves a content-bearing assistant message for
    ``last_assistant_text`` to surface. Each turn charges ``cost`` so a test can drive the cost
    guard. Mirrors ``test_agent_run_limits._NeverAnswersModel`` (incl. the ``on_delta`` kwarg the
    model backend passes), differing only in carrying ``content``; no server is contacted.
    """

    def __init__(self, *, cost: float = 0.0) -> None:
        self._cost = cost
        self.turns = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.turns += 1
        return Reply(
            content=_PARTIAL,
            tool_calls=[ToolCall(id=f"c{self.turns}", name="noop", arguments="{}")],
            usage={"prompt_tokens": 1},
            cost=self._cost,
        )


async def test_max_steps_terminal_answer_is_last_assistant_text() -> None:
    # The model only ever emits tool calls (+ content), so the loop runs every max_steps turn and
    # stops on MAX_STEPS; the terminal answer is the best-effort last assistant text, not "".
    model = _ProgressModel()
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=2).run("go")
    assert result.stop_reason == StopReason.MAX_STEPS
    assert result.answer == _PARTIAL  # last_assistant_text(messages), not a hardcoded ""


async def test_cost_limit_terminal_answer_is_last_assistant_text() -> None:
    # cost_limit (0.5) is below the per-turn cost (1.0): turn 0 runs (cost -> 1.0, crossing the
    # cap), then the top-of-loop guard trips on turn 1. The terminal answer is the best-effort
    # last assistant text from the completed turn, not "".
    model = _ProgressModel(cost=1.0)
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=10, cost_limit=0.5).run("go")
    assert result.stop_reason == StopReason.COST_LIMIT
    assert result.answer == _PARTIAL  # last_assistant_text(messages), not a hardcoded ""
