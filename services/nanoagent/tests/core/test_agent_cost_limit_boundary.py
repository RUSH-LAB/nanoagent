"""Pin Agent.run's cost-limit guard at the EXACT-equality boundary (:mod:`nanoagent.core.agent`).

Flow control caps each rollout's cost to bound worst-case task time, and nanoagent's run mode
is where that cap lives. The guard checks
``cost >= self._cost_limit`` at the TOP of :meth:`~nanoagent.core.agent.Agent.run`'s loop. The only
existing cost-limit-trip test (``test_agent_run_limits.py``) drives accumulated cost STRICTLY
ABOVE the cap (``cost_limit=0.5``, per-turn cost ``1.0``), where ``cost >= 0.5`` and
``cost > 0.5`` are both true — so a ``>=`` -> ``>`` mutation survives the whole suite. The
boundary itself, accumulated cost landing EXACTLY on ``cost_limit``, was unpinned.

This file drives a real :meth:`Agent.run` with a scripted model that never answers (one
``noop`` tool call every turn, so only a cap can stop the loop) and a per-turn ``cost`` chosen
so accumulated cost hits the cap EXACTLY (``cost_limit=1.0``, per-turn ``1.0``, all
float-exact). The boundary test asserts the run stops on the completed turn — COST_LIMIT,
exactly one completed turn, ``cost == cost_limit``; under ``>=`` -> ``>`` the loop runs a second
turn before tripping (still COST_LIMIT one turn later, but ``steps == 2`` and ``cost == 2.0``),
so the ``steps``/``cost``/``turns`` asserts — not ``stop_reason`` — fail and kill the mutation.
A below-cap control (cost never reaches the cap) runs to MAX_STEPS, proving the boundary trip is
caused by cost reaching the cap rather than the guard firing unconditionally.

Everything is in-process — a tiny mock ChatModel and a no-op tool; no model server, GPU, or
network. Mirrors ``test_agent_run_limits._NeverAnswersModel`` (incl. the ``on_delta`` kwarg the
model backend accepts).

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_cost_limit_boundary.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _NoopTool(Tool):
    """A no-op tool: the scripted model's calls dispatch here so a turn can complete."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _NeverAnswersModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` that NEVER returns a final answer.

    Every ``query`` returns a single ``noop`` tool call, so the agent loop can only end on a
    cap. Each turn charges ``cost`` to drive the cost guard, and ``turns`` records how many
    queries actually ran. Mirrors ``test_agent_run_limits._NeverAnswersModel``, incl. the
    ``on_delta`` kwarg the model backend passes; no server is contacted.
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


async def test_run_stops_when_accumulated_cost_equals_cost_limit_exactly() -> None:
    # The boundary the existing suite leaves unpinned: per-turn cost (1.0) equals cost_limit
    # (1.0), so after turn 0 accumulated cost is EXACTLY the cap. The guard runs at the top of
    # the loop, so turn 0 completes (cost -> 1.0), then the top of turn 1 sees cost == cost_limit
    # and trips. Under `>=` it stops here; under the `>=` -> `>` mutation `1.0 > 1.0` is False, so
    # a second turn runs (steps 2, cost 2.0) — the asserts below catch that and kill the mutation.
    model = _NeverAnswersModel(cost=1.0)
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=10, cost_limit=1.0).run("go")
    assert result.stop_reason == StopReason.COST_LIMIT
    assert result.steps == 1  # exactly one completed turn before the boundary trip
    assert result.cost == 1.0  # accumulated cost landed EXACTLY on cost_limit
    assert model.turns == 1  # tripped before querying a second time


async def test_run_continues_to_max_steps_when_cost_stays_below_cap() -> None:
    # Control: per-turn cost (0.25) never lets accumulated cost reach the cap (1.0) within
    # max_steps (3) — 0.25, 0.5, 0.75 — so the cost guard never trips and the run ends on
    # MAX_STEPS. This proves the boundary test's COST_LIMIT is caused by cost reaching the cap,
    # not by the guard firing unconditionally. (0.25 is float-exact, so cost == 0.75 holds.)
    model = _NeverAnswersModel(cost=0.25)
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=3, cost_limit=1.0).run("go")
    assert result.stop_reason == StopReason.MAX_STEPS
    assert result.steps == 3  # == max_steps; cost never crossed the cap
    assert result.cost == 0.75  # 0.25 * 3, still below cost_limit
    assert model.turns == 3
