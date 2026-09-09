"""Offline pin: a STRUCTURED (non-string) tool result is ``str()``-threaded into BOTH the
``role="tool"`` message content and the per-call ``output`` log, from one source.

This pins the "agent also calls --> a search tool" edge on the realistic case the search tool returns a STRUCTURED result (a dict of hits, not a
plain string). That structured payload must be ``str()``-stringified faithfully as it
crosses the :meth:`nanoagent.core.tool.Tool.invoke` -> :meth:`nanoagent.core.agent.Agent._run_one`
seam, landing as a ``str`` in BOTH sinks fed from the single ``text`` in ``_run_one``:

* the ``{"role": "tool", ..., "content"}`` message the next model turn sees, and
* :attr:`~nanoagent.core.agent.AgentResult.tool_calls`'s ``output`` (the trajectory row
  the scorer and the trainer read back).

Disjoint from the existing agent-loop tests, which all return STRINGS from ``run`` (so
``str()`` is a no-op and the structured-payload path is never exercised):
``test_agent_dispatch_call_log.py`` / ``test_agent_tool_messages.py`` /
``test_trajectory_multi_turn_capture.py`` use string-returning echo tools, and
``test_tool.py`` pins ``Tool.invoke``'s ``str()`` in isolation on a scalar int — never
building a ``role="tool"`` message or a call_log row from a structured return. Also
disjoint from the landed advertise-tool-specs (request-OUT) and multi-turn on-disk
(capture-BACK) tests.

What it consumes (read-only): the REAL :meth:`nanoagent.core.agent.Agent.run` loop, plus
:class:`~nanoagent.core.agent.Reply` / :class:`~nanoagent.core.agent.ToolCall` /
:class:`~nanoagent.core.agent.StopReason` to script the model and a pure-Python
:class:`~nanoagent.core.tool.Tool` returning a dict. No model server / network / GPU / native
extension — the ``ChatModel`` is an in-process scripted stand-in.

What it produces: nothing — purely in-memory, no disk or other side effects.

How to run it (from the repo root)::

    python3 -m pytest tests/core/test_agent_structured_tool_result_threaded.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool

# The STRUCTURED (non-string) payload the search tool returns — a dict of hits standing in
# for a search result, deliberately NOT pre-stringified. Its ``str()`` is what must land
# in both sinks; the test computes EXPECTED = str(this) once (dict ``str()`` is
# insertion-order-stable in CPython, so the rendered form is deterministic).
_STRUCTURED_HITS: dict[str, Any] = {"hits": ["doc-1", "doc-2"], "total": 2}


class _StructuredSearchTool(Tool):
    """Stand-in for a search engine: returns STRUCTURED hits (a dict), not a string."""

    NAME = "search"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    }

    def run(self, query: str) -> dict[str, Any]:
        # Return the STRUCTURED dict itself (a fresh copy, not str(...)) so the loop's
        # Tool.invoke -> _run_one seam is the one that must stringify it.
        return dict(_STRUCTURED_HITS)


class _SearchThenAnswerModel:
    """Scripted :class:`~nanoagent.core.agent.ChatModel`: one ``search`` tool call, then answer.

    Turn 1 -> ``ToolCall(id="c1")`` for ``search`` with ``content=None`` (a pure tool-call
    turn). Turn 2 -> ``Reply(content="DONE")`` with no tool call, which the loop reads as the
    final answer (``StopReason.ANSWER``). No model server is contacted; ``on_delta`` mirrors
    the keyword the real model backend accepts (the agent loop itself queries positionally).
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
                    ToolCall(id="c1", name="search", arguments='{"query": "bm25 hits"}'),
                ],
                usage={"prompt_tokens": 1},
            )
        return Reply(content="DONE", usage={"prompt_tokens": 1})


async def test_structured_tool_result_str_threaded_into_both_sinks() -> None:
    # No context_window -> compaction disabled; the transcript only grows by appending,
    # exactly as the batch rollout builds the agent.
    agent = Agent(
        _SearchThenAnswerModel(),
        [_StructuredSearchTool()],
        system_prompt="SYS",
        max_steps=5,
    )
    result = await agent.run("find docs")

    # The structured dict, rendered exactly as Tool.invoke's str() would render it. Computed
    # from the same value the tool returns, so it never drifts from a hand-copied string.
    expected = str(_STRUCTURED_HITS)
    # Sanity: it really is the dict's repr, not some already-string payload.
    assert expected == "{'hits': ['doc-1', 'doc-2'], 'total': 2}"

    # (0) The run ended cleanly on the tool-call-free second turn.
    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == "DONE"

    # (1) Exactly one role="tool" message, keyed to its originating call (c1). Its content is
    # the STRINGIFIED structured payload (a str, not the raw dict) — this is the context the
    # next model turn sees. isinstance(str) catches a leak of the un-stringified dict.
    tool_msgs = [m for m in result.messages if m.get("role") == "tool"]
    assert len(tool_msgs) == 1
    message = tool_msgs[0]
    assert message["tool_call_id"] == "c1"
    assert isinstance(message["content"], str)
    assert message["content"] == expected

    # (2) Exactly one call_log row (surfaced as result.tool_calls) — the trajectory row the
    # evaluator/trainer read. Its ``output`` is the same stringified structured payload (a
    # str), is_error is False, and ``arguments`` is the PARSED dict the model sent.
    assert len(result.tool_calls) == 1
    row = result.tool_calls[0]
    assert row["name"] == "search"
    assert row["arguments"] == {"query": "bm25 hits"}
    assert row["is_error"] is False
    assert isinstance(row["output"], str)
    assert row["output"] == expected

    # (3) Single-source faithfulness: both sinks are fed from the one ``text`` in
    # Agent._run_one, so the trajectory ``output`` is byte-identical to the message content
    # the model saw. Decoupling them in _run_one (or dropping str() in Tool.invoke) breaks
    # this — no existing test builds this message/row from a structured payload.
    assert row["output"] == message["content"]
