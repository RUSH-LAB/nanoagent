"""Pin Agent.run's ERROR path when the exception is raised with NO step in flight
(:meth:`nanoagent.core.agent.Agent.run`).

nanoagent is the ROLLOUT layer, which must still emit a scorable terminal ERROR result on
failure. :meth:`~nanoagent.core.agent.Agent.run`'s ``except Exception`` branch
guards that with ``if pending is not None: step_durations.append(pending)`` — it appends the
in-flight step's partial timing ONLY when a step is mid-flight. The complementary
``test_agent_error_path`` cases all raise from ``model.query`` (where ``pending`` was just
set), so they only ever exercise the TRUE branch. This file pins the FALSE branch (arc
``240->242``): an exception raised when ``pending is None`` — already reset to ``None`` after
the completed step's durations were appended — must NOT append again (no double-counting,
no trailing ``None``).

The realistic trigger: a RUNNING ``on_step`` snapshot fires AFTER a tool step completes
(``pending`` reset to ``None``); the trajectory writer behind that callback hits a disk error
and raises. ``Agent.run`` then enters its ``except`` branch with ``pending is None``.

Everything is in-process: a scripted :class:`_OneToolStepModel` returns one ``noop`` tool
call so a step completes, and a :class:`_WriterCallback` raises on the RUNNING snapshot only
(``content`` is carried so the error result's best-effort answer is non-empty). No model
server, network, or GPU; mirrors ``test_agent_error_path``. ``Agent.run`` logs the failure
via ``logger.exception`` before re-raising, so pytest captures one traceback (expected — the
test asserts the re-raise, it does not suppress the log).

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_error_no_pending_step.py -x -q
"""

from __future__ import annotations

from typing import Any

import pytest
from nanoagent.core.agent import Agent, AgentResult, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _NoopTool(Tool):
    """A no-op tool: lets the one turn complete a tool step (so ``pending`` is reset to None)."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _OneToolStepModel:
    """Scripted :class:`~nanoagent.core.agent.ChatModel`: every turn returns a single ``noop`` tool
    call (carrying ``content`` so the error result's best-effort answer is non-empty). The run
    calls it exactly once — the RUNNING-snapshot callback raises right after turn 1's step
    completes — so one unconditional tool-call reply is all that is needed. Mirrors
    ``test_context._MockModel``'s shape (incl. the ``on_delta`` kwarg the model backend accepts);
    no server is contacted.
    """

    def __init__(self, *, content: str) -> None:
        self._content = content

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        return Reply(
            content=self._content,
            tool_calls=[ToolCall(id="c1", name="noop", arguments="{}")],
            usage={"prompt_tokens": 1},
        )


class _WriterCallback:
    """An ``on_step`` callback that records every fire and raises on the RUNNING snapshot only.

    Simulates a trajectory-writer disk error mid-rollout: it fails on the per-step RUNNING
    snapshot (emitted AFTER the step completed, when ``pending`` is already ``None``), but not on
    the terminal ERROR result the ``except`` branch later feeds it — so the run re-raises the
    original :class:`RuntimeError` and the captured ERROR result stays inspectable.
    """

    def __init__(self) -> None:
        self.fires: list[AgentResult] = []

    def __call__(self, result: AgentResult) -> None:
        self.fires.append(result)
        if result.stop_reason == StopReason.RUNNING:
            raise RuntimeError("writer-disk-full")


async def test_error_with_no_pending_step_does_not_reappend_duration() -> None:
    # One tool step completes (pending appended then reset to None), then the RUNNING on_step
    # snapshot raises: Agent.run enters `except` with `pending is None`, so the FALSE branch
    # (arc 240->242) must SKIP the append — the terminal ERROR result carries exactly the one
    # real completed step, not a re-appended None.
    cb = _WriterCallback()
    agent = Agent(_OneToolStepModel(content="thinking"), [_NoopTool()], system_prompt="SYS", max_steps=5)
    with pytest.raises(RuntimeError, match="writer-disk-full"):
        await agent.run("go", on_step=cb)

    # on_step fired twice: the RUNNING snapshot (which raised), then the terminal ERROR result.
    assert [r.stop_reason for r in cb.fires] == [StopReason.RUNNING, StopReason.ERROR]
    err = cb.fires[-1]
    assert err.stop_reason == StopReason.ERROR
    assert err.error == "RuntimeError: writer-disk-full"  # f"{type(e).__name__}: {e}"
    assert err.answer == "thinking"  # best-effort last assistant text from the completed step
    assert err.steps == 1  # the one dispatched noop call (len(call_log))
    # KILLER ASSERTION: `pending` was already None, so the guard skips the append — exactly the
    # one completed step survives, with no trailing None. Dropping `if pending is not None:`
    # (making the append unconditional) appends the None, making this list length 2.
    assert len(err.step_durations) == 1
    assert set(err.step_durations[0]) == {"model", "tools"}
