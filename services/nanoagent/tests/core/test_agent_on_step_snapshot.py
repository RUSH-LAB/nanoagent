"""Offline test pinning Agent.run's per-step on_step snapshot-isolation contract
(:meth:`nanoagent.core.agent.Agent.run`).

Each intermediate RUNNING :class:`~nanoagent.core.agent.AgentResult` emitted to the ``on_step``
callback must FREEZE its ``usage`` and ``step_durations`` at emit time: the ``result()`` closure
builds them with ``dict(usage)`` and ``list(step_durations)`` (defensive copies) while
intentionally aliasing ``messages`` and ``call_log``. So a later loop iteration that mutates the
shared run state — ``_accumulate(usage, ...)`` grows ``usage``; ``step_durations.append(...)``
grows the list — can never retroactively corrupt an already-emitted snapshot. This is the
rollout-capture seam the trajectory writer (``on_step`` -> ``IncrementalTrajectoryWriter``)
depends on: snapshot k must keep reporting step-k state forever.

What it consumes: :class:`nanoagent.core.agent.Agent` driven by an in-process scripted ChatModel
(no model server, network, or GPU; no side effects).

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_on_step_snapshot.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, AgentResult, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _NoopTool(Tool):
    """A no-op tool, only there to give the agent loop something to dispatch each step."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _ScriptedModel:
    """Scripted :class:`~nanoagent.core.agent.ChatModel`: ``tool_steps`` single-``noop`` turns then
    a final ``"DONE"`` answer.

    Every turn reports the same ``prompt_tokens``, so the run's cumulative usage after step k is
    exactly ``(k + 1) * prompt_tokens`` and ``step_durations`` has exactly ``k + 1`` entries —
    both grow monotonically every step, which is what makes a frozen step-k snapshot trivially
    distinguishable from the still-growing run state when re-read after the run.
    """

    def __init__(self, *, prompt_tokens: int, tool_steps: int) -> None:
        self._prompt_tokens = prompt_tokens
        self._tool_steps = tool_steps
        self._turns = 0

    async def query(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Reply:
        self._turns += 1
        usage = {"prompt_tokens": self._prompt_tokens}
        if self._turns <= self._tool_steps:
            return Reply(
                content=None,
                tool_calls=[ToolCall(id=f"c{self._turns}", name="noop", arguments="{}")],
                usage=usage,
            )
        return Reply(content="DONE", usage=usage)


async def test_running_snapshots_freeze_usage_and_step_durations() -> None:
    """A RUNNING snapshot keeps reporting its own step's usage / durations forever.

    Drives a real 3-tool-step ``Agent.run`` and captures, per snapshot, the state observed at
    emit time (``on_step`` runs synchronously inside the loop). After the run — when the shared
    run state has grown past every snapshot — each RUNNING snapshot must STILL read its step-k
    values, proving ``result()`` froze copies rather than aliasing the growing run state.
    """
    fires: list[AgentResult] = []
    # (len(step_durations), usage["prompt_tokens"]) as seen the instant each snapshot fired.
    at_emit: list[tuple[int, int]] = []

    def record(r: AgentResult) -> None:
        fires.append(r)
        at_emit.append((len(r.step_durations), r.usage.get("prompt_tokens", 0)))

    model = _ScriptedModel(prompt_tokens=10, tool_steps=3)
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=10).run("go", on_step=record)

    # One RUNNING snapshot per tool step, then the terminal ANSWER.
    assert [r.stop_reason for r in fires] == [StopReason.RUNNING] * 3 + [StopReason.ANSWER]
    assert result.stop_reason == StopReason.ANSWER
    # The run's FINAL state grew past every RUNNING snapshot: 4 steps, usage 4 * 10.
    assert len(result.step_durations) == 4
    assert result.usage["prompt_tokens"] == 40

    running = [r for r in fires if r.stop_reason == StopReason.RUNNING]
    for i, snap in enumerate(running):
        k = i + 1  # the k-th completed step (1-indexed)
        # Captured at step k, the snapshot saw exactly its own step: k durations, k * 10
        # cumulative tokens.
        assert at_emit[i] == (k, k * 10)
        # ...and RE-READ AFTER the whole run it STILL reads (k, k * 10) — NOT the final
        # (4, 40), proving result() froze copies. A buggy alias (``usage`` / ``step_durations``
        # instead of the copies) would report the grown totals here, failing the two below.
        assert len(snap.step_durations) == k
        assert snap.usage["prompt_tokens"] == k * 10
        # The frozen ``steps`` count matches its durations length (snapshot k == k steps done).
        assert snap.steps == k

    # Distinct snapshots are distinct container objects: each ``dict(usage)`` / ``list(...)`` is
    # fresh, so a later step's in-place mutation cannot reach back into an earlier snapshot.
    assert running[0].step_durations is not running[1].step_durations
    assert running[0].usage is not running[1].usage


async def test_running_snapshots_alias_messages_and_call_log() -> None:
    """The other half of the seam: ``messages`` / ``call_log`` are intentionally NOT copied.

    ``result()`` aliases the live ``messages`` and ``call_log`` straight onto every snapshot
    (only ``usage`` / ``step_durations`` are defensively copied) — the trajectory writer wants
    the growing conversation + tool log, and a full copy per step would be wasteful. Pinning the
    aliasing keeps a future "defensively copy everything" change a deliberate one, and documents
    why the freeze in the test above is needed only for the two accumulating scalars.
    """
    fires: list[AgentResult] = []
    model = _ScriptedModel(prompt_tokens=10, tool_steps=3)
    await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=10).run("go", on_step=fires.append)

    running = [r for r in fires if r.stop_reason == StopReason.RUNNING]
    assert len(running) >= 2
    # (``AgentResult.tool_calls`` is the run's ``call_log``; result() fills it positionally.)
    # The SAME underlying list object across snapshots (aliased, not copied per step)...
    assert running[0].messages is running[1].messages
    assert running[0].tool_calls is running[1].tool_calls
    # ...and identical to the terminal result's, so an early snapshot sees the FINAL, fully
    # grown conversation / tool log — the live view the trajectory writer relies on.
    assert running[0].messages is fires[-1].messages
    assert running[0].tool_calls is fires[-1].tool_calls
