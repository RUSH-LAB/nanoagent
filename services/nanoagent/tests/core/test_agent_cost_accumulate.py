"""Offline test pinning Agent.run's cumulative DOLLAR-COST summation across turns
(:meth:`nanoagent.core.agent.Agent.run`).

``AgentResult.cost`` is the run's cumulative dollar cost — the dollar-denominated parallel of the
cumulative-token ``usage`` that :mod:`~nanoagent.tests.test_usage_accumulate` guards. nanoagent is the
rollout layer that captures the agent's LLM calls as the trajectory; ``cost`` is read alongside ``usage`` as the trajectory's cost/reward signal and gates
``cost_limit``. :meth:`~nanoagent.core.agent.Agent.run` builds it by starting ``cost = 0.0`` and folding
each model turn in place (``agent.py``: ``cost += reply.cost``).

That MULTI-TURN summation was UNPINNED: every other test asserting ``result.cost`` runs exactly one
cost-charging turn (the ``cost_limit`` guard trips before a 2nd — see
:mod:`~nanoagent.tests.test_agent_run_limits`), and the trajectory/cli tests set ``cost`` on a
directly-constructed :class:`~nanoagent.core.agent.AgentResult` without running the loop. So the mutation
``cost += reply.cost`` -> ``cost = reply.cost`` (overwrite instead of add) keeps only the LAST turn's
cost and silently mis-bills every multi-turn rollout, yet survives the whole suite. These tests drive
a real multi-turn ``Agent.run`` (no ``cost_limit``, so every turn charges) and assert the cumulative
total, so the overwrite makes them FAIL.

What it consumes: :class:`nanoagent.core.agent.Agent` driven by an in-process scripted ChatModel + a
no-op tool — mirrors ``test_agent_run_limits._NeverAnswersModel`` / ``test_agent_on_step_snapshot``
(no model server, network, or GPU; no side effects).

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_cost_accumulate.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _NoopTool(Tool):
    """A no-op tool: the scripted model's calls dispatch here so a tool turn can complete."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _CostModel:
    """Scripted :class:`~nanoagent.core.agent.ChatModel` charging one cost per turn from ``costs``.

    Each ``query`` returns the next entry of ``costs`` as ``reply.cost``; every turn but the LAST
    emits a single ``noop`` tool call (so the loop continues), and the last turn returns a final
    ``"DONE"`` answer (so the run ends on :attr:`~nanoagent.core.agent.StopReason.ANSWER` after exactly
    ``len(costs)`` cost-charging turns). ``turns`` records how many queries actually ran. Mirrors
    ``test_agent_run_limits._NeverAnswersModel``'s shape, incl. the ``on_delta`` kwarg the real
    model backend accepts; no server is contacted.
    """

    def __init__(self, costs: list[float]) -> None:
        self._costs = costs
        self.turns = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        cost = self._costs[self.turns]
        self.turns += 1
        if self.turns < len(self._costs):
            return Reply(
                content=None,
                tool_calls=[ToolCall(id=f"c{self.turns}", name="noop", arguments="{}")],
                usage={"prompt_tokens": 1},
                cost=cost,
            )
        return Reply(content="DONE", usage={"prompt_tokens": 1}, cost=cost)


async def test_cost_accumulates_over_multi_turn_run() -> None:
    # The GOAL case: 3 noop-tool turns + 1 answer turn, each charging 0.5. With no cost_limit every
    # turn charges, so the run folds 4 * 0.5 -> 2.0. The overwrite mutation (cost = reply.cost) keeps
    # only the last turn's 0.5, so result.cost would be 0.5 != 2.0 and this assertion FAILS.
    model = _CostModel([0.5, 0.5, 0.5, 0.5])
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=10).run("go")
    assert result.stop_reason == StopReason.ANSWER
    assert model.turns == 4  # 3 tool turns + 1 answer turn, each queried once
    assert result.steps == 4
    assert result.cost == 2.0  # 0.5 + 0.5 + 0.5 + 0.5 — a true running sum, not the last turn


async def test_cost_sums_distinct_per_turn_costs() -> None:
    # Distinct per-turn costs pin a true running SUM over the turns in order — not the last turn
    # (overwrite -> 2.0) nor the first (-> 0.25). 0.25 + 0.5 + 1.0 + 2.0 == 3.75, and each value is
    # exactly representable in float so the equality is safe.
    model = _CostModel([0.25, 0.5, 1.0, 2.0])
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=10).run("go")
    assert result.stop_reason == StopReason.ANSWER
    assert model.turns == 4
    assert result.cost == 3.75  # overwrite would leave the answer turn's 2.0; first-only -> 0.25
