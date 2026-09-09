"""Pin Agent.run's mid-run-exception ERROR path (:mod:`nanoagent.core.agent`).

nanoagent is the ROLLOUT layer that captures the agent's LLM calls as a trajectory, and a
failing/overrunning rollout must still be scorable. The one
place that realizes that failure-capture is :meth:`~nanoagent.core.agent.Agent.run`'s
``except Exception`` branch: on a mid-run model exception it appends the in-flight step's
partial timing to ``step_durations``, builds a terminal
:class:`~nanoagent.core.agent.AgentResult` with ``stop_reason=StopReason.ERROR`` and
``error="{ExcType}: {msg}"`` (answer = best-effort last assistant text), emits it once via
``on_step``, then re-raises the original exception. ``test_context``/``test_trajectory``
only drive ``on_step`` on happy paths, so this contract was untested.

Everything is in-process: a scripted :class:`_RaisingModel` raises on a chosen turn — no
model server is contacted (CPU-only, mirrors ``test_context._MockModel``). ``Agent.run``
logs the failure via ``logger.exception`` before re-raising, so pytest captures one
traceback per test (expected — the tests assert the re-raise, they don't suppress the log).

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_error_path.py -x -q
"""

from __future__ import annotations

from typing import Any

import pytest
from nanoagent.core.agent import Agent, AgentResult, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _NoopTool(Tool):
    """A no-op tool: lets a turn complete one tool step before the next query raises."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _RaisingModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` that raises on a chosen turn.

    The first ``pre_turns`` queries each return one ``noop`` tool call (carrying ``content``
    so the error result's best-effort answer is non-empty); the next query raises ``exc``,
    driving ``Agent.run``'s ``except`` branch. Mirrors ``test_context._MockModel``'s shape
    (incl. the ``on_delta`` kwarg the model backend accepts); no server is contacted.
    """

    def __init__(self, *, exc: Exception, pre_turns: int = 0, content: str = "") -> None:
        self._exc = exc
        self._pre_turns = pre_turns
        self._content = content
        self._turn = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self._turn += 1
        if self._turn <= self._pre_turns:
            return Reply(
                content=self._content,
                tool_calls=[ToolCall(id=f"c{self._turn}", name="noop", arguments="{}")],
                usage={"prompt_tokens": 1},
            )
        raise self._exc


async def test_run_reraises_model_exception() -> None:
    # The original exception must propagate out of Agent.run (so the caller sees
    # it), even with no on_step callback wired.
    agent = Agent(_RaisingModel(exc=RuntimeError("boom")), [], system_prompt="SYS", max_steps=5)
    with pytest.raises(RuntimeError, match="boom"):
        await agent.run("go")


async def test_error_path_emits_single_error_result_via_on_step() -> None:
    # Raised on the very first query: on_step fires exactly once, with the terminal ERROR result.
    fires: list[AgentResult] = []
    agent = Agent(_RaisingModel(exc=RuntimeError("boom")), [], system_prompt="SYS", max_steps=5)
    with pytest.raises(RuntimeError, match="boom"):
        await agent.run("go", on_step=fires.append)

    assert len(fires) == 1
    err = fires[0]
    assert err.stop_reason == StopReason.ERROR
    assert err.error == "RuntimeError: boom"  # f"{type(e).__name__}: {e}"
    assert err.answer == ""  # no assistant turn completed -> best-effort text is empty
    assert err.steps == 0  # call_log is empty
    # The in-flight step's partial timing is appended even though the query never returned.
    assert err.step_durations == [{"model": 0.0, "tools": 0.0}]


async def test_error_path_appends_inflight_step_after_completed_step() -> None:
    # One tool step completes, then the next query raises: the terminal ERROR result carries
    # the completed step PLUS the dead in-flight step, and is the only ERROR among the emits.
    fires: list[AgentResult] = []
    model = _RaisingModel(exc=ValueError("kaboom"), pre_turns=1, content="thinking")
    agent = Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=5)
    with pytest.raises(ValueError, match="kaboom"):
        await agent.run("go", on_step=fires.append)

    # The completed tool step emits one RUNNING snapshot, then exactly one terminal ERROR.
    assert [r.stop_reason for r in fires] == [StopReason.RUNNING, StopReason.ERROR]
    err = fires[-1]
    assert err.error == "ValueError: kaboom"
    assert err.steps == 1  # the one dispatched noop call
    assert err.answer == "thinking"  # best-effort last assistant text
    # Partial-timing append: the completed step, then the in-flight step that never finished.
    assert len(err.step_durations) == 2
    assert set(err.step_durations[0]) == {"model", "tools"}
    assert err.step_durations[-1] == {"model": 0.0, "tools": 0.0}
