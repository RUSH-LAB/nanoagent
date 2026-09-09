"""Offline test pinning the ``role="tool"`` result messages in nanoagent's agent transcript.

Drives the REAL :class:`~nanoagent.core.agent.Agent` loop (``Agent.run`` -> ``_dispatch`` ->
``_run_one``) with an in-process scripted ``ChatModel`` — no model server / network / GPU. The
first model turn emits TWO calls to one ``echo`` tool in a single reply (ids ``c1``/``c2``, with
distinct ``value`` arguments); the next turn answers ``"DONE"``. This pins the TRANSCRIPT side of
dispatch: the ``{"role": "tool", "tool_call_id", "content"}`` messages that survive in
:attr:`~nanoagent.core.agent.AgentResult.messages` — exactly one per call, in input order, each keyed
by the call's ``id`` (not its ``name``) and carrying that call's own output text.

Deliberately distinct from ``test_agent_dispatch_call_log.py``, which pins the call_log /
:attr:`~nanoagent.core.agent.AgentResult.tool_calls` side; this asserts only on ``result.messages``.
Both calls hit the same tool ``name`` (``echo``), so an id/name mix-up in ``_run_one`` collapses
both ``tool_call_id`` to ``"echo"`` and is caught. No side effects.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_tool_messages.py -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _EchoTool(Tool):
    """A tool that echoes its ``value`` argument so each call's output is call-specific."""

    NAME = "echo"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {"value": {"type": "string"}},
        "required": ["value"],
    }

    def run(self, value: str) -> str:
        return f"echoed:{value}"


class _ScriptedModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` (mirrors ``test_agent_dispatch_call_log``).

    First query: ONE reply carrying TWO ``echo`` tool calls — ``c1`` (value ``"A"``) then ``c2``
    (value ``"B"``). Next query: the final answer ``"DONE"``. No server is contacted.
    """

    def __init__(self) -> None:
        self._turn = 0

    async def query(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Reply:
        self._turn += 1
        if self._turn == 1:
            return Reply(
                content=None,
                tool_calls=[
                    ToolCall(id="c1", name="echo", arguments='{"value": "A"}'),
                    ToolCall(id="c2", name="echo", arguments='{"value": "B"}'),
                ],
                usage={"prompt_tokens": 1},
            )
        return Reply(content="DONE", usage={"prompt_tokens": 1})


async def test_run_tool_result_messages_in_transcript() -> None:
    # No context_window -> compaction disabled; the transcript only grows by appending, exactly
    # as the batch rollout builds it.
    agent = Agent(
        _ScriptedModel(),
        [_EchoTool()],
        system_prompt="SYS",
        max_steps=5,
    )
    result = await agent.run("go")
    assert result.answer == "DONE"
    assert result.stop_reason == StopReason.ANSWER

    # The role="tool" entries that survive in result.messages: exactly one per call, in input
    # order (asyncio.gather preserves it), each keyed by the call's ``id`` (c1/c2, not the shared
    # ``name`` "echo", so an id/name mix-up is caught) and carrying that call's own output text.
    tool_msgs = [m for m in result.messages if m.get("role") == "tool"]
    assert tool_msgs == [
        {"role": "tool", "tool_call_id": "c1", "content": "echoed:A"},
        {"role": "tool", "tool_call_id": "c2", "content": "echoed:B"},
    ]
