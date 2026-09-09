"""Pin that Agent.run converts the server's upfront 'maximum context length' 400 into
a graceful :class:`~nanoagent.core.agent.StopReason.CONTEXT_WINDOW` (:mod:`nanoagent.core.agent`).

The post-reply CONTEXT_WINDOW check in ``Agent.run`` only fires for prompts the inference
server actually ACCEPTED. SGLang (and any OpenAI-compatible server) instead refuses upfront
with HTTP 400 when ``prompt_tokens + max_tokens > context_length``: the request never
reaches the GPU, so there is no reply to inspect. Without the catch added in agent.py, the
``openai.BadRequestError`` escapes ``model.query``, hits the outer ``except``, and the run
is recorded as ``StopReason.ERROR`` and re-raised — which is what every task in the
2026-06-16 batch was reduced to. The catch turns that same error into a clean
``CONTEXT_WINDOW`` stop with the last assistant text, like any post-reply overflow.

Non-vacuity (inline mutation, not coverage): change the substring check in agent.py from
``"maximum context length"`` to anything that does NOT appear in the raised exception's
``str``, and this test FAILS — the bare ``raise`` re-propagates and ``agent.run`` raises
the synthetic ``_OverflowError``. Restore the substring and it PASSES.

What it consumes: :class:`nanoagent.core.agent.Agent`, :class:`~nanoagent.core.agent.Reply`,
:class:`~nanoagent.core.agent.StopReason`, and one :class:`~nanoagent.core.tool.Tool` subclass — all
in-process. No model server, network, or GPU. Provider-agnostic by design (the catch matches
on the exception's ``str``, not its type), so a plain Exception suffices as a stand-in.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_context_window_400.py -x -q
"""

from __future__ import annotations

from typing import Any

import pytest

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _NoopTool(Tool):
    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _OverflowError(Exception):
    """Stand-in for openai.BadRequestError whose message carries the canonical phrasing."""


_OVERFLOW_MESSAGE = (
    "Error code: 400 - Requested token count exceeds the model's "
    "maximum context length of 32768 tokens"
)


class _FirstTurnOverflowModel:
    """Scripted model that raises the 400-shaped error on its FIRST query."""

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        raise _OverflowError(_OVERFLOW_MESSAGE)


class _SecondTurnOverflowModel:
    """One good turn (tool call) then the 400 — proves last_assistant_text falls through."""

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
                content="thinking...",
                tool_calls=[ToolCall(id="c1", name="noop", arguments="{}")],
                usage={"prompt_tokens": 100},
            )
        raise _OverflowError(_OVERFLOW_MESSAGE)


async def test_first_turn_overflow_stops_with_context_window() -> None:
    agent = Agent(_FirstTurnOverflowModel(), [_NoopTool()], system_prompt="SYS", max_steps=5)
    result = await agent.run("go")  # must NOT raise

    assert result.stop_reason == StopReason.CONTEXT_WINDOW
    assert result.answer == ""  # no prior assistant content yet
    assert result.steps == 1


async def test_overflow_after_a_real_turn_keeps_last_assistant_text() -> None:
    agent = Agent(_SecondTurnOverflowModel(), [_NoopTool()], system_prompt="SYS", max_steps=5)
    result = await agent.run("go")

    assert result.stop_reason == StopReason.CONTEXT_WINDOW
    assert result.answer == "thinking..."  # carried from the previous assistant turn
    # The first turn ran and dispatched its tool call before the 400 hit on turn 2.
    assert any(m.get("role") == "tool" for m in result.messages)


async def test_unrelated_error_is_still_raised() -> None:
    """A non-overflow exception must NOT be silently converted to CONTEXT_WINDOW."""

    class _OtherError(Exception):
        pass

    class _AlwaysOther:
        async def query(
            self,
            messages: list[dict[str, Any]],
            tools: list[dict[str, Any]],
            *,
            on_delta: Any = None,
        ) -> Reply:
            raise _OtherError("connection reset by peer")

    with pytest.raises(_OtherError):
        await Agent(_AlwaysOther(), [_NoopTool()], system_prompt="SYS", max_steps=5).run("go")
