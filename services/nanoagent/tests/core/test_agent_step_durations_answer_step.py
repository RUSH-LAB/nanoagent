"""Pin the shape of the ``step_durations`` entry appended on Agent.run's ANSWER step
(:meth:`nanoagent.core.agent.Agent.run`).

Each completed step appends one ``{"model", "tools"}`` timing dict to ``step_durations``,
built from the ``pending`` dict initialised in ``Agent.run`` as
``pending = {"model": 0.0, "tools": 0.0}``. On the final ANSWER step the model returns no
tool call, so the dispatch branch (which would overwrite ``pending["tools"]`` with a measured
wall-clock) never runs and the loop appends ``pending`` whole: the entry
keeps BOTH keys and its ``tools`` value stays the literal ``0.0`` init — deterministically, no
timing flakiness. ``step_durations`` is consumer-facing (serialized into every saved trajectory
-> reaches the trainer and the scorer), so this success-path shape is a contract worth pinning.

Gap this closes: the suite already pins ``step_durations`` LENGTH and copy/identity
(``test_agent_on_step_snapshot``) and the ERROR-path entries (``test_agent_error_path``,
``test_agent_error_no_pending_step``), but no test asserts the keys/values of the entry
appended on a successful answer run.

Non-vacuity (inline mutation, not coverage): replacing the answer-branch append with
``step_durations.append({"model": pending["model"]})`` (dropping the ``tools`` key) survives the
whole current suite but flips the ``set(...) == {"model", "tools"}`` assertion below, failing
this test. Verified by hand, then reverted.

What it consumes: :class:`nanoagent.core.agent.Agent` driven by an in-process scripted ChatModel
that answers on turn 1 with no tool call — no cost_limit/context_window, no model server,
network, or GPU; no side effects.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_step_durations_answer_step.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason
from nanoagent.core.tool import JsonSchema, Tool


class _NoopTool(Tool):
    """A tool that is registered but never called: the model answers immediately, so the answer
    step's ``tools`` timing stays the ``0.0`` init even though a tool was AVAILABLE to dispatch.
    """

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _AnswerModel:
    """Scripted :class:`~nanoagent.core.agent.ChatModel`: answers on the first turn with NO tool
    call, so ``Agent.run`` takes its ANSWER branch after exactly one step. Mirrors
    ``test_context._MockModel``'s shape (incl. the ``on_delta`` kwarg the model backend
    accepts); no server is contacted.
    """

    def __init__(self, *, answer: str) -> None:
        self._answer = answer

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        return Reply(content=self._answer, usage={"prompt_tokens": 1})


async def test_answer_step_duration_entry_keeps_both_keys_with_zero_tools() -> None:
    # Fully offline: one scripted turn that answers with no tool call -> exactly one ANSWER step.
    model = _AnswerModel(answer="DONE")
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=5).run("go")

    # We are genuinely on the answer branch after a single completed step.
    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == "DONE"
    assert result.steps == 1

    # One completed step -> exactly one step_durations entry.
    assert len(result.step_durations) == 1
    entry = result.step_durations[0]
    # The answer-branch append keeps the pending dict whole: BOTH timing keys survive (dropping
    # the `tools` key on the append flips this — see the module docstring's non-vacuity note).
    assert set(entry) == {"model", "tools"}
    # No tool dispatch ran on the answer step, so `tools` is the literal 0.0 init value
    # — deterministic, never a measured wall-clock magnitude.
    assert entry["tools"] == 0.0
    assert isinstance(entry["tools"], float)
