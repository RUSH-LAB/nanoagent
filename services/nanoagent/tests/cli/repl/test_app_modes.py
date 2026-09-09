"""Offline unit tests for nanoagent's chat-mode REPL (:class:`nanoagent.cli.repl.app.InteractiveSession`).

What it consumes: :class:`~nanoagent.cli.repl.app.InteractiveSession`, the
:class:`~nanoagent.core.agent.Reply` / ``ToolCall`` / ``StopReason`` shapes, and
:class:`nanoagent.core.tool.Tool` — all imported read-only. No model server / network / GPU: the
session is driven entirely through its injectable ``reader`` and ``console`` parameters plus a
scripted in-process mock model (the ``_MockModel`` -> :class:`Reply` pattern proven in
``test_context.py``). No side effects — pure assertions.

Covers the REPL contract that ``test_context.py`` (which only drives ``yolo`` mode, for
compaction) does not: confirm-mode tool-call gating (a typed comment rejects, Enter runs),
human-mode direct bash execution (and the missing-``bash`` branch), the ``_read``
slash-command dispatch (``/y`` ``/c`` ``/u`` switches incl. the already-in-mode no-op, ``/h``
re-prompt, ``/m`` multiline), and ``to_result()`` stop-reason mapping.

Run (from the repo root)::

    python3 -m pytest tests/cli/repl/test_app_modes.py -x -q
"""

from __future__ import annotations

import io
from typing import Any

from nanoagent.core.agent import Reply, StopReason, ToolCall
from nanoagent.cli.repl.app import InteractiveSession
from nanoagent.core.tool import JsonSchema, Tool
from rich.console import Console


class _ScriptedReader:
    """A ``reader`` returning queued input lines in order (the prompt argument is ignored).

    Raises ``AssertionError`` if the session asks for more input than scripted, so an
    over-driven test fails loudly instead of hanging or reading real stdin.
    """

    def __init__(self, lines: list[str]) -> None:
        self._lines = list(lines)

    def __call__(self, _prompt: str) -> str:
        if not self._lines:
            raise AssertionError("scripted reader exhausted")
        return self._lines.pop(0)


class _NoopTool(Tool):
    """A do-nothing tool the model can dispatch; counts how often it actually ran."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def __init__(self) -> None:
        self.calls = 0

    def run(self) -> str:
        self.calls += 1
        return "ok"


class _RecordingBash(Tool):
    """Stand-in for the ``bash`` tool human mode runs: records commands, echoes them back."""

    NAME = "bash"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"],
    }

    def __init__(self) -> None:
        self.commands: list[str] = []

    def run(self, command: str) -> str:
        self.commands.append(command)
        return f"ran: {command}"


class _ScriptedModel:
    """A scripted ``ChatModel``: returns queued :class:`Reply` objects in order, repeating the
    last for any further turns, and records the messages of every query it is handed."""

    def __init__(self, replies: list[Reply]) -> None:
        self._replies = replies
        self.queries: list[list[dict[str, Any]]] = []

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.queries.append([dict(m) for m in messages])
        return self._replies[min(len(self.queries) - 1, len(self._replies) - 1)]


def _make_console() -> tuple[Console, io.StringIO]:
    """A Rich console writing to an in-memory buffer (wide enough that no assertion line wraps)."""
    buf = io.StringIO()
    return Console(file=buf, width=200, highlight=False), buf


def _tool_call(call_id: str = "c1", *, cost: float = 0.0) -> Reply:
    """A reply asking to run the ``noop`` tool once (never an answer)."""
    return Reply(
        content=None,
        tool_calls=[ToolCall(id=call_id, name="noop", arguments="{}")],
        cost=cost,
    )


# --- confirm-mode tool-call gating --------------------------------------------------------


async def test_confirm_mode_rejects_pending_tool_call() -> None:
    model = _ScriptedModel([_tool_call(), Reply(content="DONE")])
    tool = _NoopTool()
    console, _buf = _make_console()
    session = InteractiveSession(
        model,
        [tool],
        system_prompt="SYS",
        mode="confirm",
        reader=_ScriptedReader(["change of plan: stop"]),  # a comment rejects
        console=console,
    )
    answer = await session.run_task("do the thing")
    assert answer == "DONE"
    assert tool.calls == 0  # the rejected call never executed
    # The rejection is fed back to the model verbatim as the tool result for that call id...
    assert [m for m in session.messages if m.get("role") == "tool"] == [
        {"role": "tool", "tool_call_id": "c1", "content": "Rejected by user: change of plan: stop"}
    ]
    # ...and the model actually saw it on the next turn.
    assert any(
        m.get("role") == "tool" and "Rejected by user" in (m.get("content") or "")
        for m in model.queries[1]
    )
    # A rejected call IS logged, flagged is_error, so the trajectory shows what you turned down.
    assert session.to_result().tool_calls == [
        {
            "id": "c1",
            "name": "noop",
            "arguments": {},
            "output": "Rejected by user: change of plan: stop",
            "is_error": True,
        }
    ]


async def test_confirm_mode_accepts_on_empty_line() -> None:
    model = _ScriptedModel([_tool_call(), Reply(content="DONE")])
    tool = _NoopTool()
    console, _buf = _make_console()
    session = InteractiveSession(
        model,
        [tool],
        system_prompt="SYS",
        mode="confirm",
        reader=_ScriptedReader([""]),  # Enter == run
        console=console,
    )
    answer = await session.run_task("do the thing")
    assert answer == "DONE"
    assert tool.calls == 1  # Enter ran the pending call
    assert session.to_result().tool_calls == [
        {"id": "c1", "name": "noop", "arguments": {}, "output": "ok", "is_error": False}
    ]
    # The real tool output (not a rejection) is fed back under the call id.
    assert {"role": "tool", "tool_call_id": "c1", "content": "ok"} in session.messages


# --- human mode ---------------------------------------------------------------------------


async def test_human_mode_runs_bash_directly() -> None:
    model = _ScriptedModel([])  # human mode must never query the model
    bash = _RecordingBash()
    console, _buf = _make_console()
    session = InteractiveSession(
        model,
        [bash],
        system_prompt="SYS",
        mode="human",
        max_steps=1,
        reader=_ScriptedReader(["ls -la"]),
        console=console,
    )
    answer = await session.run_task("(ignored in human mode)")
    assert answer == ""  # the single step was consumed by the human turn
    assert model.queries == []  # the model was never asked
    assert bash.commands == ["ls -la"]  # the command ran via the bash tool
    assert session.to_result().tool_calls == [
        {"name": "bash", "arguments": {"command": "ls -la"}, "output": "ran: ls -la", "is_error": False}
    ]
    # The command + its output are appended as a user turn so the model sees what was run.
    assert any(
        m.get("role") == "user"
        and "I ran this command myself" in (m.get("content") or "")
        and "ls -la" in (m.get("content") or "")
        for m in session.messages
    )


async def test_human_mode_without_bash_tool() -> None:
    session_tools = [_NoopTool()]  # a toolset that has no tool named "bash"
    console, buf = _make_console()
    session = InteractiveSession(
        _ScriptedModel([]),
        session_tools,
        system_prompt="SYS",
        mode="human",
        max_steps=1,
        reader=_ScriptedReader(["ls -la"]),
        console=console,
    )
    answer = await session.run_task("(ignored)")
    assert answer == ""
    assert "no 'bash' tool available" in buf.getvalue()
    assert session.to_result().tool_calls == []  # nothing ran
    assert not any(
        "I ran this command myself" in (m.get("content") or "") for m in session.messages
    )


# --- _read slash-command dispatch (the documented slash handler) --------------------------


async def test_read_switches_modes_via_slash_commands() -> None:
    console, buf = _make_console()
    session = InteractiveSession(
        _ScriptedModel([]),
        [],
        system_prompt="SYS",
        mode="confirm",
        reader=_ScriptedReader(["/y", "first", "/c", "second", "/u", "third"]),
        console=console,
    )
    assert session._read("> ") == "first"
    assert session.mode == "yolo"
    assert session._read("> ") == "second"
    assert session.mode == "confirm"
    assert session._read("> ") == "third"
    assert session.mode == "human"
    assert "switched to yolo mode" in buf.getvalue()


async def test_read_already_in_mode_is_noop() -> None:
    console, buf = _make_console()
    session = InteractiveSession(
        _ScriptedModel([]),
        [],
        system_prompt="SYS",
        mode="yolo",
        reader=_ScriptedReader(["/y", "go"]),  # already yolo: switch is a no-op, then re-prompt
        console=console,
    )
    assert session._read("> ") == "go"
    assert session.mode == "yolo"  # unchanged
    assert "already in yolo mode" in buf.getvalue()


async def test_read_help_reprompts() -> None:
    console, buf = _make_console()
    session = InteractiveSession(
        _ScriptedModel([]),
        [],
        system_prompt="SYS",
        mode="confirm",
        reader=_ScriptedReader(["/h", "after help"]),
        console=console,
    )
    assert session._read("> ") == "after help"  # /h prints help then re-prompts
    out = buf.getvalue()
    assert "yolo" in out and "confirm" in out and "multiline" in out


async def test_read_multiline_until_dot() -> None:
    console, _buf = _make_console()
    session = InteractiveSession(
        _ScriptedModel([]),
        [],
        system_prompt="SYS",
        mode="confirm",
        reader=_ScriptedReader(["/m", "line one", "line two", "."]),  # '.' ends multiline
        console=console,
    )
    assert session._read("> ") == "line one\nline two"


async def test_read_returns_on_switch_when_requested() -> None:
    console, _buf = _make_console()
    session = InteractiveSession(
        _ScriptedModel([]),
        [],
        system_prompt="SYS",
        mode="confirm",
        reader=_ScriptedReader(["/u"]),
        console=console,
    )
    # Human mode reads with return_on_switch=True so a mode switch hands control straight back.
    assert session._read("> ", return_on_switch=True) == ""
    assert session.mode == "human"


# --- to_result() stop-reason mapping ------------------------------------------------------


async def test_to_result_reports_answer_stop_reason() -> None:
    console, _buf = _make_console()
    session = InteractiveSession(
        _ScriptedModel([Reply(content="the answer")]),
        [],
        system_prompt="SYS",
        mode="yolo",
        reader=_ScriptedReader([]),
        console=console,
    )
    assert await session.run_task("q") == "the answer"
    result = session.to_result()
    assert result.stop_reason == StopReason.ANSWER
    assert result.answer == "the answer"


async def test_to_result_reports_max_steps_stop_reason() -> None:
    model = _ScriptedModel([_tool_call()])  # always asks for a tool call, never answers
    console, _buf = _make_console()
    session = InteractiveSession(
        model,
        [_NoopTool()],
        system_prompt="SYS",
        mode="yolo",
        max_steps=2,
        reader=_ScriptedReader([]),
        console=console,
    )
    assert await session.run_task("q") == ""
    result = session.to_result()
    assert result.stop_reason == StopReason.MAX_STEPS
    assert result.steps == 2  # both turns ran before the cap


async def test_to_result_reports_cost_limit_stop_reason() -> None:
    model = _ScriptedModel([_tool_call(cost=1.0)])  # each turn accrues $1, never answers
    console, _buf = _make_console()
    session = InteractiveSession(
        model,
        [_NoopTool()],
        system_prompt="SYS",
        mode="yolo",
        max_steps=5,
        cost_limit=0.5,
        reader=_ScriptedReader([]),
        console=console,
    )
    assert await session.run_task("q") == ""
    result = session.to_result()
    assert result.stop_reason == StopReason.COST_LIMIT
    assert result.cost == 1.0  # one turn ran (cost accrued) before the cap tripped next turn
