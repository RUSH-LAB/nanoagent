"""Unit tests for nanoagent context management / compaction (:mod:`nanoagent.core.agent`).

Everything is mocked — no model server is contacted. A :class:`_MockModel` reports a
configurable ``prompt_tokens`` per turn (to drive the 80% threshold), returns tool calls for
the first N turns then a final answer, and answers compaction turns (queried with no tools)
with a canned summary while recording every message list it receives.

Run (from the repo root)::

    python3 -m pytest tests/core/test_context.py -x -q
"""

from __future__ import annotations

import io
from typing import Any

import pytest
from nanoagent.core.agent import (
    _COMPACT_PROMPT,
    Agent,
    AgentResult,
    compact_messages,
    needs_compaction,
    Reply,
    StopReason,
    ToolCall,
)
from nanoagent.cli.repl.app import InteractiveSession
from nanoagent.core.tool import JsonSchema, Tool
from rich.console import Console


class _NoopTool(Tool):
    """A no-op tool used only to give the agent loop something to dispatch."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _MockModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` with recorded calls.

    ``prompt_tokens`` is reported on every normal turn so a test can sit above or below the
    compaction threshold. The first ``tool_steps`` normal turns return ``calls_per_turn``
    ``noop`` tool calls; the next returns the final answer ``"DONE"``. A turn queried with no
    tools is treated as a compaction request and answered with ``summary``. ``compactions``
    records the message list of each such request; ``queries`` records the rest.
    """

    def __init__(
        self,
        *,
        prompt_tokens: int,
        tool_steps: int,
        calls_per_turn: int = 1,
        summary: str = "RECAP",
    ) -> None:
        self._prompt_tokens = prompt_tokens
        self._tool_steps = tool_steps
        self._calls_per_turn = calls_per_turn
        self._summary = summary
        self.queries: list[list[dict[str, Any]]] = []
        self.compactions: list[list[dict[str, Any]]] = []

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        snapshot = [dict(m) for m in messages]
        if not tools:  # compaction turn — model is queried without tools
            self.compactions.append(snapshot)
            return Reply(content=self._summary, usage={"prompt_tokens": 1})
        self.queries.append(snapshot)
        step = len(self.queries)
        if step <= self._tool_steps:
            return Reply(
                content=None,
                tool_calls=[
                    ToolCall(id=f"c{step}_{j}", name="noop", arguments="{}")
                    for j in range(self._calls_per_turn)
                ],
                usage={"prompt_tokens": self._prompt_tokens},
            )
        return Reply(content="DONE", usage={"prompt_tokens": self._prompt_tokens})


def _exchange(idx: str, n_calls: int = 1) -> list[dict[str, Any]]:
    """One assistant-with-tool-calls message followed by its matching tool results."""
    ids = [f"{idx}{j}" for j in range(n_calls)]
    assistant = {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": i,
                "type": "function",
                "function": {"name": "noop", "arguments": "{}"},
            }
            for i in ids
        ],
    }
    tools = [{"role": "tool", "tool_call_id": i, "content": f"result {i}"} for i in ids]
    return [assistant, *tools]


def _conversation(*, exchanges: int, calls_each: int = 1) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "the original task"},
    ]
    for k in range(exchanges):
        messages.extend(_exchange(f"e{k}_", calls_each))
    return messages


def _assert_tool_pairing(messages: list[dict[str, Any]]) -> None:
    """Every role="tool" message must answer a tool_call from the assistant that precedes it.

    Walks the list tracking the open tool_call ids of the most recent assistant; any tool
    message whose id is not among them (e.g. one orphaned by compaction) fails. The chat API
    enforces exactly this pairing, so it is the invariant compaction must never break.
    """
    expected: set[str] = set()
    for m in messages:
        role = m.get("role")
        if role == "assistant" and m.get("tool_calls"):
            expected = {tc["id"] for tc in m["tool_calls"]}
        elif role == "tool":
            assert m["tool_call_id"] in expected, f"orphaned tool message: {m}"
        else:
            expected = set()


def test_needs_compaction_disabled_below_and_above_threshold() -> None:
    assert needs_compaction(None, 10**9) is False  # disabled regardless of size
    assert needs_compaction(1000, 800) is False  # exactly 80% does not trip
    assert needs_compaction(1000, 801) is True
    assert needs_compaction(1000, 850) is True


async def test_compacted_messages_preserve_system_prompt() -> None:
    model = _MockModel(prompt_tokens=0, tool_steps=0)
    messages = _conversation(exchanges=2)
    out = await compact_messages(model, messages)
    assert out[0] == {"role": "system", "content": "SYS"}


async def test_compacted_messages_include_summary_and_recent_exchange() -> None:
    model = _MockModel(prompt_tokens=0, tool_steps=0, summary="RECAP")
    messages = _conversation(exchanges=3)
    out = await compact_messages(model, messages)
    # A single summary user message sits right after the system prompt...
    assert out[1]["role"] == "user"
    assert "RECAP" in out[1]["content"]
    # ...and the most recent exchange is preserved verbatim at the tail.
    assert out[-2:] == messages[-2:]
    # The model was asked to summarize the middle (everything but system + recent tail).
    assert model.compactions[-1] == [
        *messages[1:-2],
        {"role": "user", "content": _COMPACT_PROMPT},
    ]


async def test_compaction_keeps_tool_calls_with_their_results() -> None:
    # The last exchange issues two tool calls; compaction must keep the assistant message
    # glued to BOTH its tool results (the chat API rejects an orphaned tool message).
    model = _MockModel(prompt_tokens=0, tool_steps=0)
    messages = [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "task"},
        *_exchange("a_", 1),
        *_exchange("b_", 2),
    ]
    out = await compact_messages(model, messages)
    assert out[1]["role"] == "user"  # the summary
    assert out[2]["role"] != "tool"  # never an orphaned tool message after the summary
    assert out[-3]["role"] == "assistant"
    assert [tc["id"] for tc in out[-3]["tool_calls"]] == ["b_0", "b_1"]
    assert out[-2]["tool_call_id"] == "b_0"
    assert out[-1]["tool_call_id"] == "b_1"
    _assert_tool_pairing(out)


async def test_compact_messages_noop_when_nothing_to_summarize() -> None:
    model = _MockModel(prompt_tokens=0, tool_steps=0)
    messages = [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "task"},
    ]
    out = await compact_messages(model, messages)
    assert out == messages
    assert model.compactions == []  # model never called


async def test_compact_messages_noop_when_only_one_message_to_summarize() -> None:
    # One exchange leaves only the original task in the middle; replacing one message with one
    # summary cannot shrink the list, so compaction is skipped (no model call, task kept verbatim).
    model = _MockModel(prompt_tokens=0, tool_steps=0)
    messages = [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "task"},
        *_exchange("a_", 1),
    ]
    out = await compact_messages(model, messages)
    assert out == messages
    assert model.compactions == []


async def test_agent_run_hard_stops_at_context_window() -> None:
    # Agent.run no longer compacts when prompt_tokens crosses the configured context_window —
    # it hard-stops with StopReason.CONTEXT_WINDOW, so the rest of the saturated turn (and
    # any further tool dispatch) is skipped. ``compact_messages`` stays available for the
    # interactive session (see test_interactive_session_compacts below).
    model = _MockModel(prompt_tokens=1000, tool_steps=5)
    result = await Agent(
        model, [_NoopTool()], system_prompt="SYS", max_steps=10, context_window=1000
    ).run("go")
    assert result.stop_reason == StopReason.CONTEXT_WINDOW
    assert model.compactions == []  # Agent.run never asks for a summarization turn
    assert len(model.queries) == 1  # stopped on the very first saturated reply
    # The saturated reply is recorded as the final assistant message even though it carried
    # tool calls — generation stops, no tool dispatch happens.
    assert result.messages[-1]["role"] == "assistant"
    assert "tool" not in {m["role"] for m in result.messages}


async def test_agent_run_no_stop_below_context_window() -> None:
    # Below the window: the loop runs through every tool step and returns the final answer.
    model = _MockModel(prompt_tokens=999, tool_steps=2)
    result = await Agent(
        model, [_NoopTool()], system_prompt="SYS", max_steps=10, context_window=1000
    ).run("do the thing")
    assert model.compactions == []
    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == "DONE"


async def test_agent_run_no_stop_when_context_window_disabled() -> None:
    model = _MockModel(prompt_tokens=10**9, tool_steps=2)
    agent = Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=10)
    result = await agent.run("do the thing")
    assert model.compactions == []  # context_window None disables both compaction and hard-stop
    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == "DONE"


async def test_interactive_session_compacts() -> None:
    model = _MockModel(prompt_tokens=850, tool_steps=2)
    session = InteractiveSession(
        model,
        [_NoopTool()],
        system_prompt="SYS",
        mode="yolo",
        max_steps=10,
        context_window=1000,
        console=Console(file=io.StringIO()),
    )
    answer = await session.run_task("do the thing")
    assert answer == "DONE"
    assert model.compactions  # compaction fired during the session
    assert session.messages[0] == {"role": "system", "content": "SYS"}
    # The reshaped, persisted history actually carries the spliced summary.
    assert session.messages[1]["role"] == "user"
    assert session.messages[1]["content"].startswith("Summary of earlier conversation:")


async def test_interactive_session_keeps_tool_pairing_through_compaction() -> None:
    # The interactive session compacts right after appending the assistant message — which may
    # carry tool_calls whose results are not appended yet. With several tool calls per turn,
    # this is exactly where compaction could orphan a tool message; assert it never does.
    model = _MockModel(prompt_tokens=850, tool_steps=3, calls_per_turn=2)
    session = InteractiveSession(
        model,
        [_NoopTool()],
        system_prompt="SYS",
        mode="yolo",
        max_steps=10,
        context_window=1000,
        console=Console(file=io.StringIO()),
    )
    answer = await session.run_task("do the thing")
    assert answer == "DONE"
    assert model.compactions  # compaction fired during a multi-call turn
    _assert_tool_pairing(session.messages)
    assert session.messages[1]["content"].startswith("Summary of earlier conversation:")
    assert session.messages[2]["role"] != "tool"  # no orphan right after the summary


async def test_running_snapshot_skipped_without_on_step(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The per-step RUNNING AgentResult is built only when an on_step callback exists.

    Counts AgentResult constructions across a real 5-tool-step run (no server, compaction
    disabled). With no callback the only snapshot that must be built is the terminal ANSWER;
    the five intermediate RUNNING snapshots that used to be constructed and immediately
    discarded are gone. With a callback every snapshot still fires in order, proving the
    streaming path — and the returned result — is unchanged.
    """
    constructed = 0
    real_init = AgentResult.__init__

    def counting_init(self: AgentResult, *args: Any, **kwargs: Any) -> None:
        nonlocal constructed
        constructed += 1
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(AgentResult, "__init__", counting_init)

    # (1) No on_step: 5 tool steps then the final answer. Only the terminal ANSWER snapshot
    # is built — the 5 discarded RUNNING snapshots are skipped (pre-fix this is 6, not 1).
    model = _MockModel(prompt_tokens=10, tool_steps=5)
    result = await Agent(
        model, [_NoopTool()], system_prompt="SYS", max_steps=10
    ).run("go")
    assert result.answer == "DONE"
    assert result.stop_reason == StopReason.ANSWER
    assert constructed == 1

    # (2) With on_step: behavior preserved — every snapshot is still constructed and emitted,
    # in order, and the returned result is identical (answer, stop_reason, step count).
    constructed = 0
    fires: list[AgentResult] = []
    model = _MockModel(prompt_tokens=10, tool_steps=5)
    result = await Agent(
        model, [_NoopTool()], system_prompt="SYS", max_steps=10
    ).run("go", on_step=fires.append)
    assert [r.stop_reason for r in fires] == [StopReason.RUNNING] * 5 + [StopReason.ANSWER]
    assert result.answer == "DONE"
    assert result.stop_reason == StopReason.ANSWER
    assert len(result.step_durations) == 6
    assert constructed == 6
