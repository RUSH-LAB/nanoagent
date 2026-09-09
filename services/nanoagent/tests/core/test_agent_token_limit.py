"""Pin Agent.run's per-rollout TOKEN_LIMIT cap (:mod:`nanoagent.core.agent`).

Flow control names three per-rollout caps — turns/tokens/wall-clock — to bound worst-case
task time. ``turns`` is ``max_steps`` (MAX_STEPS) and ``wall-clock`` is
``run_batch(timeout=...)``, but the ``tokens`` cap was genuinely absent (``cost_limit`` is a
DOLLARS cap, ≈0 for a free/local SGLang model, and ``context_window`` only COMPACTS history).
This pins the new graceful cap: a top-of-loop guard ``usage.get("total_tokens", 0) >=
self._token_limit`` that emits a terminal :attr:`~nanoagent.core.agent.StopReason.TOKEN_LIMIT`,
mirroring the existing ``cost_limit`` guard exactly (NOT the ``run_batch`` score-zero kill).

It drives a real :meth:`Agent.run` with a scripted model that never answers (one ``noop`` tool
call every turn, so only a cap can stop the loop) and a per-turn ``total_tokens`` chosen for
each case:

  * TRIP — per-turn tokens (100) cross the cap (50) after one turn, so the top of turn 1 trips:
    TOKEN_LIMIT, ``steps == 1``, model queried exactly once (before the 2nd query).
  * BOUNDARY (``>=``) — per-turn tokens (100) land EXACTLY on ``token_limit`` (100); the run
    stops on that completed turn. Under a ``>=`` -> ``>`` mutation ``100 > 100`` is False, so a
    second turn runs (``steps == 2``, accumulated 200) — the ``steps``/``turns``/``usage``
    asserts (not ``stop_reason``) fail and kill the mutation.
  * CONTROL — with ``token_limit`` set but per-turn tokens kept below it, the run ends MAX_STEPS,
    proving the trip is caused by tokens reaching the cap, not the guard firing unconditionally.
  * BACK-COMPAT — a default ``Agent`` with NO ``token_limit`` (the ``None`` default) is
    unaffected even with high per-turn tokens, so the cap is opt-in.

Everything is in-process — a tiny mock ChatModel and a no-op tool; no model server, GPU, or
network. Mirrors ``test_agent_cost_limit_boundary._NeverAnswersModel`` (incl. the ``on_delta``
kwarg the model backend accepts), but charges ``total_tokens`` instead of ``cost``.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_token_limit.py -x -q
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
    cap. Each turn reports ``total_tokens`` to drive the token guard, and ``turns`` records how
    many queries actually ran. Mirrors ``test_agent_cost_limit_boundary._NeverAnswersModel``,
    incl. the ``on_delta`` kwarg the model backend passes; no server is contacted.
    """

    def __init__(self, *, total_tokens: int = 0) -> None:
        self._total_tokens = total_tokens
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
            usage={"total_tokens": self._total_tokens},
        )


async def test_run_stops_when_accumulated_tokens_cross_token_limit() -> None:
    # token_limit (50) is below the per-turn tokens (100). The guard is checked at the TOP of the
    # loop BEFORE the query, so turn 0 runs (total_tokens -> 100, crossing 50) and the trip
    # happens at the top of turn 1, before a second query — pinning steps/turns at the trip.
    model = _NeverAnswersModel(total_tokens=100)
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=10, token_limit=50).run("go")
    assert result.stop_reason == StopReason.TOKEN_LIMIT
    assert result.steps == 1  # one completed turn before the top-of-loop guard tripped
    assert model.turns == 1  # tripped before querying a second time


async def test_run_stops_when_accumulated_tokens_equal_token_limit_exactly() -> None:
    # Boundary: per-turn tokens (100) equal token_limit (100), so after turn 0 accumulated tokens
    # are EXACTLY the cap. The guard runs at the top of the loop, so turn 0 completes
    # (total_tokens -> 100), then the top of turn 1 sees 100 >= 100 and trips. Under the
    # `>=` -> `>` mutation `100 > 100` is False, so a second turn runs (steps 2, tokens 200) — the
    # asserts below catch that and kill the mutation.
    model = _NeverAnswersModel(total_tokens=100)
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=10, token_limit=100).run("go")
    assert result.stop_reason == StopReason.TOKEN_LIMIT
    assert result.steps == 1  # exactly one completed turn before the boundary trip
    assert result.usage["total_tokens"] == 100  # accumulated tokens landed EXACTLY on the cap
    assert model.turns == 1  # tripped before querying a second time


async def test_run_continues_to_max_steps_when_tokens_stay_below_cap() -> None:
    # Control: per-turn tokens (100) never let accumulated tokens reach the cap (1000) within
    # max_steps (3) — 100, 200, 300 — so the token guard never trips and the run ends on
    # MAX_STEPS. This proves the trip is caused by tokens reaching the cap, not by the guard
    # firing unconditionally whenever a token_limit is set.
    model = _NeverAnswersModel(total_tokens=100)
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=3, token_limit=1000).run("go")
    assert result.stop_reason == StopReason.MAX_STEPS
    assert result.steps == 3  # == max_steps; tokens never crossed the cap
    assert result.usage["total_tokens"] == 300  # 100 * 3, still below token_limit
    assert model.turns == 3


async def test_default_agent_without_token_limit_is_unaffected() -> None:
    # Back-compat: with no token_limit (the None default) the guard is disabled, so even high
    # per-turn tokens (100) cannot stop the loop — it runs to MAX_STEPS. The cap is opt-in.
    model = _NeverAnswersModel(total_tokens=100)
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=3).run("go")
    assert result.stop_reason == StopReason.MAX_STEPS
    assert result.steps == 3  # == max_steps; no cap to trip
    assert model.turns == 3
