"""Pin the MEASURED tool-phase duration appended on Agent.run's TOOL step
(:meth:`nanoagent.core.agent.Agent.run`).

Each completed step appends one ``{"model", "tools"}`` timing dict to ``step_durations``,
built from the ``pending`` dict initialised in ``Agent.run`` as
``pending = {"model": 0.0, "tools": 0.0}``. On a step that DISPATCHES tools the loop times the
dispatch with a monotonic clock and OVERWRITES the ``0.0`` init with the real wall-clock
(``pending["tools"] = time.monotonic() - t1``) right before appending
``pending`` whole. So the tool step's entry carries a strictly-positive
``tools`` measurement, not the literal init. ``step_durations`` is consumer-facing (serialized
into every saved trajectory -> reaches the trainer and the scorer), so this measured-timing contract
is worth pinning.

This is the exact complement of ``test_agent_step_durations_answer_step.py``, which pins that on
the ANSWER step (no tool call, the ``pending["tools"]`` overwrite never runs) ``tools`` STAYS the ``0.0`` init.
Here the same run also produces a final answer step, used below as a contrast control.

Non-vacuity (inline mutation, not coverage): neutralizing the ``pending["tools"]`` overwrite (e.g.
commenting it or replacing the RHS with ``0.0``) leaves the tool step's ``tools`` at the ``0.0`` init,
so the ``tool_step["tools"] > 0.0`` assertion FAILS while the rest of the nanoagent suite stays green —
the answer-step control still passes because that branch never reaches the overwrite. Verified by hand
against ``agent.py``, then reverted so only this test file is added.

What it consumes: :class:`nanoagent.core.agent.Agent` driven by an in-process scripted ChatModel that
emits ONE tool call (turn 1) then answers (turn 2), plus one async :class:`~nanoagent.core.tool.Tool`
that ``await asyncio.sleep(0.02)`` so the measured dispatch delta is reliably > 0 and the test is
non-flaky — no cost_limit/context_window, no model server, network, or GPU; no side effects.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_step_durations_tool_step.py -x -q
"""

from __future__ import annotations

import asyncio
from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _SlowTool(Tool):
    """An async tool that suspends 20ms before returning (mirrors ``_SlowTool`` in
    ``test_agent_dispatch_order_async.py``), so the step's measured tool-dispatch wall-clock is
    reliably > 0 and the ``tools > 0.0`` assertion is non-flaky."""

    NAME = "slow"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    async def run(self) -> str:
        await asyncio.sleep(0.02)
        return "slow-out"


class _ToolThenAnswerModel:
    """Scripted :class:`~nanoagent.core.agent.ChatModel`: turn 1 emits ONE tool call (-> a TOOL step
    that dispatches ``slow``), turn 2 answers ``"DONE"`` with no tool call (-> the ANSWER step).
    Mirrors ``test_context._MockModel``'s shape (incl. the ``on_delta`` kwarg the model backend
    accepts); no server is contacted.
    """

    def __init__(self) -> None:
        self._turn = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self._turn += 1
        if self._turn == 1:
            return Reply(
                content=None,
                tool_calls=[ToolCall(id="c_slow", name="slow", arguments="{}")],
                usage={"prompt_tokens": 1},
            )
        return Reply(content="DONE", usage={"prompt_tokens": 1})


async def test_tool_step_duration_entry_measures_positive_tools() -> None:
    # Fully offline: turn 1 dispatches one async tool that sleeps 20ms (TOOL step), turn 2 answers
    # with no tool call (ANSWER step) -> exactly two completed steps.
    model = _ToolThenAnswerModel()
    result = await Agent(model, [_SlowTool()], system_prompt="SYS", max_steps=5).run("go")

    # We genuinely reached the answer branch after one tool step followed by one answer step.
    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == "DONE"
    assert result.steps == 2

    # Two completed steps -> exactly two step_durations entries, in order.
    assert len(result.step_durations) == 2

    # FIRST entry is the TOOL step: it keeps BOTH timing keys, and its `tools` value was
    # OVERWRITTEN with a measured monotonic wall-clock -> strictly > 0 (the async
    # tool slept 20ms). Neutralizing that overwrite leaves `tools` at the 0.0 init and FAILS this
    # assert (the module docstring's non-vacuity note).
    tool_step = result.step_durations[0]
    assert set(tool_step) == {"model", "tools"}
    assert tool_step["tools"] > 0.0
    assert isinstance(tool_step["tools"], float)

    # SECOND entry is the ANSWER step: no tool dispatch ran, so `tools` stays the literal 0.0 init.
    # This contrast control stays GREEN under the `pending["tools"]` overwrite mutation (that branch is never
    # reached on the answer step), isolating the failure above to the tool step alone.
    answer_step = result.step_durations[1]
    assert set(answer_step) == {"model", "tools"}
    assert answer_step["tools"] == 0.0
