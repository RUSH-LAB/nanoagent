"""Pin Agent.run's tool-arg-malformation retry (:mod:`nanoagent.core.agent`).

When EVERY tool call in a model reply comes back with an arg-shape error (bad JSON, non-
object args, unknown tool name, or a Python ``TypeError`` raised when ``tool.run(**args)``
is called with the wrong kwargs — e.g. ``Search.run() got an unexpected keyword argument
'"query"'``), Agent.run silently drops that turn and re-queries the model with the same
context, up to ``_MAX_TOOL_ARG_RETRIES`` times within the same step. The malformed assistant
message and its tool results are NOT appended (the model gets a clean second try); the
retried model.query is real work and its tokens / cost ARE accumulated. Once the cap is
exhausted, the bad results are kept and fed back as normal role="tool" messages so the next
step can still correct.

This is the in-loop counterpart of test_invoke_tool_call_non_dict_args.py's end-to-end test
(that one pins the recovery *exists*; this one pins the retry *mechanism* — how many extra
model.query calls, what stays in the trajectory, when the cap kicks in).

Non-vacuity (inline mutation, not coverage): set ``_MAX_TOOL_ARG_RETRIES = 0`` in
``nanoagent/harness/core/agent.py`` and ``test_arg_malformed_turn_is_silently_retried`` FAILS (the
malformed assistant + tool messages are appended and trajectories are no longer empty);
restore it and the test PASSES. ``test_retry_cap_then_keep_errors`` mutates the cap in the
opposite direction — at the cap the bad tool results are kept.

What it consumes: :class:`nanoagent.core.agent.Agent`, :class:`~nanoagent.core.agent.Reply`,
:class:`~nanoagent.core.agent.ToolCall`, :class:`~nanoagent.core.agent.StopReason` and one
:class:`~nanoagent.core.tool.Tool` subclass — all in-process. No model server, network, or GPU.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_tool_arg_retry.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall, _MAX_TOOL_ARG_RETRIES
from nanoagent.core.tool import JsonSchema, Tool


class _EchoTool(Tool):
    """A tool with a single explicit ``query`` kwarg — so a tool call with kwargs of any
    other shape raises ``TypeError`` from ``tool.run(**args)``, exactly like the real
    Search.run() unexpected-kwarg failure observed in saved trajectories.
    """

    NAME = "echo"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    }

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def run(self, query: str) -> str:
        self.calls.append({"query": query})
        return f"got {query!r}"


def _bad_call(idx: int) -> ToolCall:
    """A tool call the EchoTool rejects with TypeError — an UNKNOWN kwarg (not a quote-wrapped
    real one, so invoke_tool_call's key-unquoting can't silently recover it; that recovery path
    is covered by test_invoke_tool_call_quoted_keys). This keeps the retry behavior under test."""
    return ToolCall(id=f"bad{idx}", name="echo", arguments='{"bogus": "hi"}')


def _good_call(idx: int) -> ToolCall:
    return ToolCall(id=f"ok{idx}", name="echo", arguments='{"query": "hi"}')


class _Model:
    """Scripted model: emits the next ``Reply`` from a queue per ``query`` call."""

    def __init__(self, replies: list[Reply]) -> None:
        self._replies = list(replies)
        self.calls = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.calls += 1
        return self._replies.pop(0)


async def test_arg_malformed_turn_is_silently_retried() -> None:
    """One bad reply -> 1 retry -> next reply is the answer; only the answer is in the trajectory."""
    model = _Model(
        [
            Reply(content=None, tool_calls=[_bad_call(1)], usage={"prompt_tokens": 1}),
            Reply(content="DONE", usage={"prompt_tokens": 2}),
        ]
    )
    tool = _EchoTool()
    result = await Agent(model, [tool], system_prompt="SYS", max_steps=5).run("go")

    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == "DONE"
    assert tool.calls == []  # the malformed call never reached the tool
    # Model was queried twice (one bad attempt + one recovery) but only ONE step was charged:
    # the retry happens within the same step, never appending the bad turn.
    assert model.calls == 2
    assert result.steps == 1
    # The trajectory carries only the recovery answer — no tool message, no bad assistant.
    assert [m["role"] for m in result.messages] == ["system", "user", "assistant"]
    assert result.messages[-1]["content"] == "DONE"
    assert result.tool_calls == []
    # Token accounting includes BOTH model.query attempts (real work, real tokens).
    assert result.usage["prompt_tokens"] == 1 + 2


async def test_retry_cap_then_keep_errors() -> None:
    """Past the cap the bad tool results are committed so the next step can still recover."""
    # Emit one bad reply for each retry slot, plus one more that the loop must KEEP, then a
    # final answer turn. With _MAX_TOOL_ARG_RETRIES=N: N+1 bad replies are queried (1 initial
    # + N retries); the (N+1)th is committed because retries are exhausted; the model then
    # answers on step 2.
    bad_replies = [
        Reply(
            content=None,
            tool_calls=[_bad_call(i)],
            usage={"prompt_tokens": 1},
        )
        for i in range(_MAX_TOOL_ARG_RETRIES + 1)
    ]
    model = _Model([*bad_replies, Reply(content="DONE", usage={"prompt_tokens": 1})])
    tool = _EchoTool()
    result = await Agent(model, [tool], system_prompt="SYS", max_steps=5).run("go")

    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == "DONE"
    assert tool.calls == []  # every malformed call short-circuited before the tool
    # All bad attempts plus the final answer turn were queried.
    assert model.calls == _MAX_TOOL_ARG_RETRIES + 2
    # Step 1 = the committed bad turn (post-cap); step 2 = the answer.
    assert result.steps == 2
    # Exactly one role="tool" message survives — the LAST bad attempt that was committed.
    tool_msgs = [m for m in result.messages if m.get("role") == "tool"]
    assert len(tool_msgs) == 1
    assert tool_msgs[0]["content"].startswith("Error: ")
    # Its corresponding call_log row is marked as an error.
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0]["is_error"] is True


async def test_partial_malformed_turn_does_not_retry() -> None:
    """A reply mixing a bad call with a good one is NOT retried (the good call is real work)."""
    model = _Model(
        [
            Reply(
                content=None,
                tool_calls=[_bad_call(1), _good_call(2)],
                usage={"prompt_tokens": 1},
            ),
            Reply(content="DONE", usage={"prompt_tokens": 1}),
        ]
    )
    tool = _EchoTool()
    result = await Agent(model, [tool], system_prompt="SYS", max_steps=5).run("go")

    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == "DONE"
    # The good call ran; the bad one short-circuited. No retry happened (only 2 queries).
    assert tool.calls == [{"query": "hi"}]
    assert model.calls == 2
    # Both tool results are in the trajectory (the bad one as an error, the good one as its result).
    tool_msgs = [m for m in result.messages if m.get("role") == "tool"]
    assert len(tool_msgs) == 2
    assert tool_msgs[0]["content"].startswith("Error: ")
    assert tool_msgs[1]["content"] == "got 'hi'"
