"""Offline test pinning the rollout tool-record shape of nanoagent's batch agent loop.

Drives the REAL :class:`~nanoagent.core.agent.Agent` loop (``Agent.run`` -> ``_dispatch`` ->
``_run_one``) with an in-process scripted ``ChatModel`` (mirrors ``test_context``'s mock —
no model server / network / GPU). The first model turn emits TWO tool calls in one reply:
one tool that succeeds and one whose ``run`` raises (so :meth:`~nanoagent.core.tool.Tool.invoke`
returns ``is_error=True``); the next turn answers. This pins the per-call trajectory record
that training consumes:

* the ``call_log`` dict :meth:`~nanoagent.core.agent.Agent._run_one` appends —
  ``{"id", "name", "arguments", "output", "is_error"}`` (``id`` is the originating call id, the
  link the saved trajectory uses to inline ``is_error`` onto the matching ``role="tool"`` message;
  ``arguments`` is the PARSED dict, not the raw JSON string; ``is_error`` is threaded from the
  tool; the failing call carries the ``"Error: ..."`` text) — surfaced as
  :attr:`~nanoagent.core.agent.AgentResult.tool_calls`;
* the paired ``{"role": "tool", "tool_call_id", "content"}`` messages the ``asyncio.gather``
  in :meth:`~nanoagent.core.agent.Agent._dispatch` returns — exactly two, in dispatch order, keyed
  by ``call.id`` (not ``call.name``), each ``content`` equal to that call's output.

``test_trajectory.py`` only asserts ``len(result.tool_calls)`` for the ``Agent.run`` path, and
the exact dict shape is pinned only for the separate ``InteractiveSession`` path
(``test_app_modes.py``); this covers the batch ``_run_one`` path. No side effects.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_dispatch_call_log.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _OkTool(Tool):
    """A tool that succeeds: echoes its ``text`` argument so the output is call-specific."""

    NAME = "ok_tool"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    }

    def run(self, text: str) -> str:
        return f"ok:{text}"


class _BoomTool(Tool):
    """A tool whose ``run`` always raises, so ``Tool.invoke`` returns ``is_error=True``."""

    NAME = "boom_tool"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        raise RuntimeError("kaboom")


class _ScriptedModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` (mirrors ``test_context._MockModel``).

    First query: ONE reply carrying TWO tool calls — ``ok_tool`` (succeeds) then ``boom_tool``
    (raises). Next query: the final answer ``"DONE"``. No server is contacted.
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
                tool_calls=[
                    ToolCall(id="c1", name="ok_tool", arguments='{"text": "hi"}'),
                    ToolCall(id="c2", name="boom_tool", arguments="{}"),
                ],
                usage={"prompt_tokens": 1},
            )
        return Reply(content="DONE", usage={"prompt_tokens": 1})


async def test_dispatch_call_log_and_tool_message_pairing() -> None:
    # No context_window -> compaction disabled; the transcript only grows by appending, exactly
    # as the batch rollout builds the agent.
    agent = Agent(
        _ScriptedModel(),
        [_OkTool(), _BoomTool()],
        system_prompt="SYS",
        max_steps=5,
    )
    result = await agent.run("go")
    assert result.answer == "DONE"
    assert result.stop_reason == StopReason.ANSWER

    # (a) The call_log (surfaced as result.tool_calls): exactly the two per-call dicts in
    # dispatch order. ``arguments`` is the PARSED dict (not the raw '{"text": "hi"}' string);
    # the failing call threads ``is_error=True`` and carries the "Error: ..." text. Full-dict
    # equality catches dropping/renaming any of the 4 keys (e.g. output->content) and
    # hardcoding ``is_error`` instead of threading it from Tool.invoke.
    assert result.tool_calls == [
        {"id": "c1", "name": "ok_tool", "arguments": {"text": "hi"}, "output": "ok:hi", "is_error": False},
        {
            "id": "c2",
            "name": "boom_tool",
            "arguments": {},
            "output": "Error: RuntimeError: kaboom",
            "is_error": True,
        },
    ]

    # (b) Exactly two role="tool" messages, each paired to its call by ``tool_call_id`` = the
    # call's ``id`` (c1/c2, which differ from the call ``name`` here, so a name/id mix-up is
    # caught), in dispatch order (pinning asyncio.gather's input-order preservation), each
    # ``content`` equal to that call's logged ``output`` above.
    tool_msgs = [m for m in result.messages if m.get("role") == "tool"]
    assert tool_msgs == [
        {"role": "tool", "tool_call_id": "c1", "content": "ok:hi"},
        {"role": "tool", "tool_call_id": "c2", "content": "Error: RuntimeError: kaboom"},
    ]
