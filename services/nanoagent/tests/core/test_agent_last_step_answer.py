"""Pin that the LAST step asks for an answer instead of expiring mid-investigation.

A run that hits ``max_steps`` while still searching returns whatever text it happened to say
last — usually nothing. Measured on Muse Glimmer (step6, 32 tasks): 31 runs ended
``max_steps_reached`` with an empty answer. A scorer cannot score an empty string, and under
GRPO an all-empty group has uniform reward, hence zero advantage and no gradient — so this is
not a cosmetic loss, it is the difference between a usable RL signal and none.

The fix spends no extra budget: on step ``max_steps - 1`` a user turn tells the model it is out
of steps, so the last turn answers rather than searching. Query count, token accounting, and the
``max_steps``/``token_limit``/``cost_limit`` contracts are all unchanged — which is what the four
budget-invariant tests (``test_agent_run_limits``, ``test_agent_token_limit``,
``test_agent_cost_limit_boundary``) keep pinned, and why the prompt is appended INSIDE the step
rather than as an extra turn after the loop.

Covers the two halves of that claim:

  * a model that answers when asked stops at ANSWER with non-empty text, in exactly
    ``max_steps`` queries — not ``max_steps + 1``.
  * a model that ignores the nudge still stops at MAX_STEPS, so the cap stays a hard cap.

Non-vacuity (prove by mutation, then revert): deleting the ``if step == self._max_steps - 1``
branch in ``Agent.run`` fails the first test (stop_reason MAX_STEPS, answer ""); changing it to
append after the loop instead fails the query-count assertion.

Everything is in-process: a scripted model and a no-op tool; no model server, GPU, or network.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_last_step_answer.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool

_MAX_STEPS = 4
_ANSWER = "Exact Answer: cyclic AMP | Confidence: 60%"


class _NoopTool(Tool):
    """A no-op tool: the scripted model's calls dispatch here so a turn can complete."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _SearchesForever:
    """Calls ``noop`` every turn, answering only once told it is out of steps.

    ``obedient=False`` models a model that ignores the instruction, which must not weaken the
    cap. Records every request so the test can count queries and find the prompt.
    """

    def __init__(self, *, obedient: bool) -> None:
        self._obedient = obedient
        self.seen: list[list[dict[str, Any]]] = []

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.seen.append([dict(m) for m in messages])
        told_to_finish = "no steps left" in str(messages[-1].get("content", ""))
        if told_to_finish and self._obedient:
            return Reply(content=_ANSWER, usage={"prompt_tokens": 1})
        return Reply(
            content=None,
            tool_calls=[ToolCall(id=f"c{len(self.seen)}", name="noop", arguments="{}")],
            usage={"prompt_tokens": 1},
        )


async def _run(*, obedient: bool) -> tuple[_SearchesForever, Any]:
    model = _SearchesForever(obedient=obedient)
    agent = Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=_MAX_STEPS)
    return model, await agent.run("go")


async def test_last_step_produces_a_scoreable_answer() -> None:
    model, result = await _run(obedient=True)
    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == _ANSWER
    # the whole point: the answer costs no query beyond the cap
    assert len(model.seen) == _MAX_STEPS
    # and the prompt lands on the last step only, so earlier turns search unimpeded
    nudged = [i for i, msgs in enumerate(model.seen) if "no steps left" in str(msgs[-1]["content"])]
    assert nudged == [_MAX_STEPS - 1]


async def test_ignoring_the_prompt_still_stops_at_max_steps() -> None:
    model, result = await _run(obedient=False)
    assert result.stop_reason == StopReason.MAX_STEPS
    assert result.steps == _MAX_STEPS
    assert len(model.seen) == _MAX_STEPS
