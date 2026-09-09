"""Offline pin: a SUCCESSFUL multi-turn Agent run's SAVED trajectory captures the
agent's LLM calls as the trajectory, faithfully, when read back from disk.

This pins the capture seam — nanoagent transparently captures the agent's LLM calls as
the trajectory — on the SUCCESSFUL multi-turn path (>=2 tool steps,
``stop_reason="answer"``) — the path no existing test reads back from disk and checks
the captured structure of: ``test_trajectory.py`` asserts only byte-identity + the
answer; ``test_run_and_save.py`` is single-turn; ``test_run_batch_timeout_traj_stop_reason.py``
is the cancelled/error path and never asserts ``traj["steps"]`` nor the assistant message's
embedded ``tool_calls``; ``test_agent_message_helpers`` is in-memory only.

What it consumes (read-only): the REAL :meth:`nanoagent.core.agent.Agent.run` loop, plus
:class:`nanoagent.core.agent.Reply` / :class:`~nanoagent.core.agent.ToolCall` and
:class:`nanoagent.core.tool.Tool` to script the model and the one echo tool, and
:func:`nanoagent.runtime.trajectory.save` / :func:`~nanoagent.runtime.trajectory.load` for the on-disk
round-trip. No model server / network / GPU / native extension — the ``ChatModel`` is an
in-process scripted stand-in and the tool is pure Python.

What it produces: nothing persistent — the trajectory is written under pytest's
``tmp_path`` and discarded with it.

How to run it (from the repo root)::

    python3 -m pytest tests/runtime/test_trajectory_multi_turn_capture.py -x -q
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from nanoagent.runtime import trajectory
from nanoagent.core.agent import Agent, Reply, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _EchoTool(Tool):
    """Echoes back its ``text`` argument, so each dispatched call's output is a
    deterministic function of the arguments the model sent — letting the test pin the
    per-call log output AND its matching ``role="tool"`` message content independently."""

    NAME = "echo"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    }

    def run(self, text: str) -> str:
        return f"echo: {text}"


class _TwoToolsThenAnswerModel:
    """Scripted :class:`~nanoagent.core.agent.ChatModel`: two DISTINCT echo tool calls on two
    SEPARATE turns, then the final answer — no model server is contacted.

    Turn 1 -> ``ToolCall(id="c1")`` echo ``{"text": "alpha"}``; turn 2 ->
    ``ToolCall(id="c2")`` echo ``{"text": "beta"}``; turn 3 -> ``Reply(content="DONE")``
    with no tool call, which the loop reads as the final answer (``StopReason.ANSWER``).
    Mirrors ``test_trajectory._ScriptedModel``'s shape (the ``on_delta`` kwarg the
    interactive session passes is accepted and ignored; the agent loop never sends it).
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
                tool_calls=[ToolCall(id="c1", name="echo", arguments='{"text": "alpha"}')],
                usage={"prompt_tokens": 1},
            )
        if self._turn == 2:
            return Reply(
                content=None,
                tool_calls=[ToolCall(id="c2", name="echo", arguments='{"text": "beta"}')],
                usage={"prompt_tokens": 1},
            )
        return Reply(content="DONE", usage={"prompt_tokens": 1})


async def test_multi_turn_success_trajectory_capture_round_trips(tmp_path: Path) -> None:
    """A successful >=2-tool-step run, saved then loaded, captures the calls faithfully.

    Drives the REAL ``Agent.run`` with the scripted two-tool-then-answer model + echo
    tool, saves the terminal ``AgentResult`` via ``trajectory.save``, loads it back, and
    asserts the on-disk dict carries the full multi-turn capture: stop reason + answer,
    the real step count, the role sequence incl. both tool messages, each assistant turn's
    embedded ``tool_calls`` (c1/c2) plus its inlined ``durations``, and the ``tool_call_id``-keyed
    tool messages with their inlined ``is_error`` (nanoagent-2: no separate tool_calls /
    step_durations arrays).
    """
    agent = Agent(
        _TwoToolsThenAnswerModel(),
        [_EchoTool()],
        system_prompt="SYS",
        max_steps=20,
        # No context_window -> compaction disabled (as the batch path builds it), so the
        # transcript only grows by appending and the role sequence below is exact.
    )

    result = await agent.run("do the multi-turn thing")

    path = trajectory.save(result, tmp_path / "run.traj.json")
    data = trajectory.load(path)

    # Faithful round-trip (nanoagent-2): the saved transcript is the in-memory one with per-step
    # observability INLINED — assistant turns gain `durations`, tool results gain `is_error` —
    # and the redundant top-level `tool_calls` / `step_durations` arrays are gone (the transcript
    # already carries everything). Stripping the inlined keys recovers the exact in-memory messages.
    assert data["trajectory_format"] == "nanoagent-2"
    assert "tool_calls" not in data
    assert "step_durations" not in data
    assert [
        {k: v for k, v in m.items() if k not in ("durations", "is_error")} for m in data["messages"]
    ] == result.messages

    # (1) terminal state: the no-tool-call final turn is the answer.
    assert data["stop_reason"] == "answer"
    assert data["answer"] == "DONE"

    # (2) the ACTUAL step count the real run yields (2 tool turns c1/c2 + 1 answer turn),
    # pinned to the in-memory result so it is the real value, not a guess.
    assert result.steps == 3
    assert data["steps"] == result.steps

    # (3) the full multi-turn role sequence, including BOTH role="tool" results.
    roles = [m["role"] for m in data["messages"]]
    assert roles == ["system", "user", "assistant", "tool", "assistant", "tool", "assistant"]
    assert roles.count("tool") == 2

    # (4) each assistant tool-call turn carries the embedded tool_calls with the exact
    # {id, type, function:{name, arguments}} shape (arguments = the RAW JSON string the
    # model emitted) and ids c1 then c2, in order.
    assistant_tool_turns = [m for m in data["messages"] if m["role"] == "assistant" and m.get("tool_calls")]
    assert len(assistant_tool_turns) == 2
    assert assistant_tool_turns[0]["tool_calls"] == [{"id": "c1", "type": "function", "function": {"name": "echo", "arguments": '{"text": "alpha"}'}}]
    assert assistant_tool_turns[1]["tool_calls"] == [{"id": "c2", "type": "function", "function": {"name": "echo", "arguments": '{"text": "beta"}'}}]
    # The final answer turn carries NO embedded tool_calls (assistant_message omits the key
    # when the reply made no call) — this is the assertion the non-vacuity proof flips RED.
    final_turn = data["messages"][-1]
    assert final_turn["role"] == "assistant"
    assert final_turn["content"] == "DONE"
    assert "tool_calls" not in final_turn

    # (5) each step's timing is inlined onto its assistant turn as `durations` {"model","tools"}
    # (one per step: the 2 tool turns + the answer turn), replacing the old top-level
    # step_durations array. model time is real (>= 0); the answer turn did no tool dispatch.
    assistant_turns = [m for m in data["messages"] if m["role"] == "assistant"]
    assert len(assistant_turns) == 3
    for turn in assistant_turns:
        assert set(turn["durations"]) == {"model", "tools"}
        assert turn["durations"]["model"] >= 0.0 and turn["durations"]["tools"] >= 0.0
    assert assistant_turns[-1]["durations"]["tools"] == 0.0  # answer turn: no tool dispatch

    # (6) the two role="tool" messages are keyed by their originating call ids c1/c2, their
    # content is the matching tool output, and each carries the inlined `is_error` flag (the one
    # field the dropped tool_calls array used to hold that the transcript otherwise lacked).
    tool_msgs = [m for m in data["messages"] if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == ["c1", "c2"]
    assert [m["content"] for m in tool_msgs] == ["echo: alpha", "echo: beta"]
    assert [m["is_error"] for m in tool_msgs] == [False, False]
