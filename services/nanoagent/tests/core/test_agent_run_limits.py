"""Pin Agent.run's cap/termination contract and the duplicate-tool guard (:mod:`nanoagent.core.agent`).

nanoagent is the ROLLOUT layer, and flow control caps each rollout's turns/cost to bound
worst-case task time; nanoagent's run mode is where those caps live. The two run-mode caps and the constructor's tool-name guard were UNCOVERED
for :meth:`~nanoagent.core.agent.Agent.run` — the existing limit tests drive
``InteractiveSession``, a separate loop, and ``__init__``'s duplicate-tool ``ValueError`` was
untested anywhere:

  * MAX_STEPS  — a model that never returns a final answer exhausts ``range(max_steps)`` and
    returns ``StopReason.MAX_STEPS`` with ``steps == max_steps``.
  * COST_LIMIT — the cost guard is checked at the TOP of the loop, BEFORE the next query, so
    with ``cost_limit`` below the per-turn cost it trips on the turn AFTER the cost crosses
    the cap: one turn runs (the model is queried once, cost accrues), then the next iteration
    returns ``StopReason.COST_LIMIT`` with ``steps == 1`` and one turn's cost accrued.
  * duplicate tool name — ``Agent.__init__`` collapses ``{t.name: t}`` and raises
    ``ValueError("duplicate tool name in `tools`")`` when two tools share a name.

Everything is in-process: a scripted :class:`_NeverAnswersModel` always returns one ``noop``
tool call (never a final answer) so only a cap can stop the loop, and carries a per-turn
``cost`` to drive the cost guard. Mirrors ``test_context._MockModel``'s shape (incl. the
``on_delta`` kwarg the model backend accepts); no model server, GPU, or network.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_run_limits.py -x -q
"""

from __future__ import annotations

from typing import Any

import pytest
from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _NoopTool(Tool):
    """A no-op tool: the scripted model's calls dispatch here so a turn can complete."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _DuplicateNoopTool(Tool):
    """A second, distinct tool that deliberately reuses ``_NoopTool``'s NAME."""

    NAME = "noop"  # collides with _NoopTool.NAME on purpose
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "dup"


class _NeverAnswersModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` that NEVER returns a final answer.

    Every ``query`` returns a single ``noop`` tool call, so the agent loop can only end on a
    cap — MAX_STEPS (turns exhausted) or COST_LIMIT (accumulated cost crosses the cap). Each
    turn charges ``cost`` so a test can drive the cost guard, and ``turns`` records how many
    queries actually ran. Mirrors ``test_context._MockModel``'s shape, incl. the ``on_delta``
    kwarg the model backend passes; no server is contacted.
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
            content=None,
            tool_calls=[ToolCall(id=f"c{self.turns}", name="noop", arguments="{}")],
            usage={"prompt_tokens": 1},
            cost=self._cost,
        )


async def test_run_stops_at_max_steps_when_model_never_answers() -> None:
    # A model that only ever emits tool calls drives run() through every one of its max_steps
    # turns and then stops: terminal MAX_STEPS with steps == max_steps (one query per step).
    model = _NeverAnswersModel()
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=3).run("go")
    assert result.stop_reason == StopReason.MAX_STEPS
    assert result.steps == 3  # == max_steps
    assert model.turns == 3  # one query per step, never an early answer


async def test_run_stops_at_cost_limit_one_turn_after_cap_crossed() -> None:
    # cost_limit (0.5) is below the per-turn cost (1.0). The guard is checked at the TOP of the
    # loop BEFORE the query, so turn 0 runs (cost -> 1.0, crossing 0.5) and the trip happens at
    # the top of turn 1, before a second query — pinning the real steps/cost at the trip.
    model = _NeverAnswersModel(cost=1.0)
    result = await Agent(
        model, [_NoopTool()], system_prompt="SYS", max_steps=10, cost_limit=0.5
    ).run("go")
    assert result.stop_reason == StopReason.COST_LIMIT
    assert result.steps == 1  # one completed turn before the top-of-loop guard tripped
    assert result.cost == 1.0  # exactly one turn's cost accrued (0.0 + 1.0)
    assert model.turns == 1  # tripped before querying a second time


def test_duplicate_tool_name_raises_value_error() -> None:
    # Two distinct tools sharing a NAME collapse {t.name: t} from 2 entries to 1; __init__
    # detects the length mismatch and refuses to build the agent.
    with pytest.raises(ValueError, match="duplicate tool name"):
        Agent(
            _NeverAnswersModel(),
            [_NoopTool(), _DuplicateNoopTool()],
            system_prompt="SYS",
        )
