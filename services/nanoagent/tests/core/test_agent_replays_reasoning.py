"""Pin that a turn's reasoning is replayed to the model as ``reasoning_content``.

A reasoning-parser server splits the model's trace out of ``content`` into a separate field, so
whatever :class:`~nanoagent.core.agent.Agent` puts in the history is all the model gets back. Dropping
the trace hands the model a turn where it called a tool for no stated reason — it then re-derives
the same plan from scratch every step. Observed on Muse Glimmer (step6, 32/32 tasks): every
assistant turn had empty ``content``, the model re-issued near-identical searches ~48 times, and
every task ended ``context_window``/``max_steps_reached`` with an empty answer. Both served chat
templates ask for the field by name — gemma-4 renders ``reasoning``/``reasoning_content`` as a
``thought`` channel on tool-calling turns, Muse Glimmer re-emits it as its ``to=self`` channel —
and it reaches them through sglang's ``ChatCompletionMessageGenericParam.reasoning_content``.

Covers both directions, since only carrying the field is not the whole contract:

  * present  — a turn with ``reasoning`` puts ``reasoning_content`` on the assistant message the
    NEXT request sees, alongside the ``tool_calls`` pairing that request already relied on.
  * absent   — a turn without ``reasoning`` omits the key entirely rather than sending
    ``None``/``""``, so a non-reasoning backend's history is byte-identical to before.

Non-vacuity (prove by mutation, then revert): deleting the ``if reply.reasoning:`` branch in
``assistant_message`` fails the first test; making it unconditional (``out["reasoning_content"] =
reply.reasoning``) fails the second.

Everything is in-process: a scripted model that records the messages of every request and a no-op
tool; no model server, GPU, or network. Mirrors ``test_agent_limit_answer_text._ProgressModel``
(incl. the ``on_delta`` kwarg the model backend passes).

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_replays_reasoning.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool

_TRACE = "the user wants X, so search for it first"


class _NoopTool(Tool):
    """A no-op tool: the scripted model's calls dispatch here so a turn can complete."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _RecordingModel:
    """Calls ``noop`` on turn 1 then answers, recording the messages of every request.

    ``reasoning`` on the first Reply is what the second request must carry back, so
    ``self.seen[1]`` is the history the fix is about.
    """

    def __init__(self, *, reasoning: str | None) -> None:
        self._reasoning = reasoning
        self.seen: list[list[dict[str, Any]]] = []

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.seen.append([dict(m) for m in messages])
        if len(self.seen) == 1:
            return Reply(
                content=None,  # a reasoning-parser server leaves content empty on a tool turn
                tool_calls=[ToolCall(id="c1", name="noop", arguments="{}")],
                usage={"prompt_tokens": 1},
                reasoning=self._reasoning,
            )
        return Reply(content="done", usage={"prompt_tokens": 2})


def _assistant(messages: list[dict[str, Any]]) -> dict[str, Any]:
    return next(m for m in messages if m["role"] == "assistant")


async def test_reasoning_is_replayed_as_reasoning_content() -> None:
    # Turn 1 reasons and calls a tool; turn 2's request must show that trace back to the model.
    model = _RecordingModel(reasoning=_TRACE)
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=4).run("go")
    assert result.stop_reason == StopReason.ANSWER
    replayed = _assistant(model.seen[1])
    assert replayed["reasoning_content"] == _TRACE
    # the tool_calls pairing the API requires still rides along on the same message
    assert [c["id"] for c in replayed["tool_calls"]] == ["c1"]


async def test_absent_reasoning_omits_the_key() -> None:
    # A non-reasoning backend must produce the exact history it did before the field existed:
    # the key is absent, not None and not "".
    model = _RecordingModel(reasoning=None)
    await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=4).run("go")
    assert "reasoning_content" not in _assistant(model.seen[1])
