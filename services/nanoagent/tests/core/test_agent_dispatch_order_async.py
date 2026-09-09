"""Offline test pinning that nanoagent records call_log in DISPATCH order under async tools.

Regression test for a trajectory-determinism bug. When ONE model reply carries multiple tool
calls, :meth:`~nanoagent.core.agent.Agent._dispatch` runs them concurrently with ``asyncio.gather``.
``gather`` returns its results (the ``role="tool"`` messages) in INPUT order, so
:attr:`~nanoagent.core.agent.AgentResult.messages` is correctly ordered. But if each per-call
coroutine appended its own ``call_log`` row *after* its ``await``, the rows would land in
COMPLETION order — so for genuinely-suspending async tools (a real HTTP / search call)
a slower call's row lands after a faster one and :attr:`~nanoagent.core.agent.AgentResult.tool_calls`
(which IS ``call_log``) ends up ordered differently from ``messages``: the trajectory disagrees
with itself. nanoagent's trajectory is consumed downstream by a trainer and a scorer,
so a self-inconsistent ordering is a real correctness
defect — not cosmetic.

Drives the REAL :class:`~nanoagent.core.agent.Agent` loop (mirrors
``test_agent_dispatch_call_log.py``'s scripted-``ChatModel`` + ``Tool``-subclass pattern) with
TWO **async** tools of inverted latency emitted in ONE reply: a ``"slow"`` tool dispatched FIRST
whose ``run`` sleeps 50ms, and a ``"fast"`` tool dispatched SECOND that sleeps 0. The slow tool
finishes LAST, so the buggy append-inside-``_run_one`` shape yields ``result.tool_calls`` in
completion order ``["fast", "slow"]``; the fix populates ``call_log`` from ``gather``'s
input-ordered return list, giving ``["slow", "fast"]`` — agreeing with the (already-correct)
``messages`` order. :meth:`~nanoagent.core.tool.Tool.invoke` awaits an awaitable ``run`` result, so an
``async def run`` genuinely suspends. No model server / network / GPU; no side effects.

The existing ``test_agent_dispatch_call_log.py`` uses SYNC tool ``run`` methods that never yield,
so its append order coincidentally equals dispatch order and it cannot catch this; this test adds
the async-suspension case. Reverting ``_dispatch``/``_run_one`` to the append-inside-``_run_one``
shape makes assertion (a) below FAIL (tool_calls come back ``["fast", "slow"]``) while ``messages``
stays correct — proving non-vacuity by mutation.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_dispatch_order_async.py -x -q
"""

from __future__ import annotations

import asyncio
from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _SlowTool(Tool):
    """An async tool that suspends 50ms before returning, so it finishes LAST."""

    NAME = "slow"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    async def run(self) -> str:
        await asyncio.sleep(0.05)
        return "slow-out"


class _FastTool(Tool):
    """An async tool that yields once (``sleep(0)``) then returns, so it finishes FIRST."""

    NAME = "fast"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    async def run(self) -> str:
        await asyncio.sleep(0.0)
        return "fast-out"


class _ScriptedModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` (mirrors ``test_agent_dispatch_call_log``).

    First query: ONE reply carrying TWO tool calls — ``slow`` (dispatched first) then ``fast``
    (dispatched second). Next query: the final answer ``"DONE"``. No server is contacted.
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
                    ToolCall(id="c_slow", name="slow", arguments="{}"),
                    ToolCall(id="c_fast", name="fast", arguments="{}"),
                ],
                usage={"prompt_tokens": 1},
            )
        return Reply(content="DONE", usage={"prompt_tokens": 1})


async def test_dispatch_call_log_in_dispatch_order_under_async_tools() -> None:
    # No context_window -> compaction disabled; the transcript only grows by appending, exactly
    # as the batch rollout builds the agent. The slow tool is dispatched FIRST but finishes LAST.
    agent = Agent(
        _ScriptedModel(),
        [_SlowTool(), _FastTool()],
        system_prompt="SYS",
        max_steps=5,
    )
    result = await agent.run("go")
    assert result.answer == "DONE"
    assert result.stop_reason == StopReason.ANSWER

    # (a) call_log (surfaced as result.tool_calls) is in DISPATCH order — slow then fast — NOT
    # the completion order ["fast", "slow"] the append-inside-_run_one bug produces (slow finishes
    # last). This is the assertion that FAILS against the buggy shape and passes with the fix.
    log_names = [tc["name"] for tc in result.tool_calls]
    assert log_names == ["slow", "fast"], f"tool_calls not in dispatch order: {log_names}"

    # (b) The two role="tool" messages are paired to their call by ``tool_call_id`` in dispatch
    # order (already correct today: asyncio.gather preserves its input order in the result list).
    tool_msgs = [m for m in result.messages if m.get("role") == "tool"]
    msg_ids = [m["tool_call_id"] for m in tool_msgs]
    assert msg_ids == ["c_slow", "c_fast"], f"messages not in dispatch order: {msg_ids}"

    # (c) The two orders AGREE — call_log row N describes the same call as message N (id
    # "c_<name>"). This trajectory self-consistency is exactly what the fix restores.
    assert msg_ids == ["c_" + n for n in log_names], "tool_calls and messages order disagree"
