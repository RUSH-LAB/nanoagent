"""Offline unit tests for the chat-mode REPL loop (:meth:`InteractiveSession.chat`).

What it consumes: :class:`~nanoagent.cli.repl.app.InteractiveSession` and the
:class:`~nanoagent.core.agent.Reply` / ``StopReason`` shapes — all imported read-only. No model
server / network / GPU: the loop is driven through the session's injectable ``reader`` and
``console`` plus a scripted in-process model (the ``_ScriptedReader`` / ``_ScriptedModel``
harness proven in ``test_app_modes.py`` + ``test_context.py``, extended so a scripted
turn may *raise* instead of returning a :class:`Reply`). No side effects — pure assertions.

Covers the ``chat()`` follow-up loop that ``test_app_modes.py`` (which drives only
``run_task``) and ``test_context.py`` (compaction) never exercise: a transient model failure
maps to ``StopReason.ERROR`` and the session stays alive to run the next task; an interrupt
maps to ``StopReason.INTERRUPTED`` — both via the genuine Ctrl-C mechanism (a cancelled query
raises ``asyncio.CancelledError``, which ``_query`` converts to ``KeyboardInterrupt``; injected
directly, no real signal) and via a query raising ``KeyboardInterrupt`` directly under the
``asyncio.run`` entry ``run_and_save`` uses; an empty follow-up line quits; and
``confirm_exit=False`` breaks after one task.

Run (from the repo root)::

    python3 -m pytest tests/cli/repl/test_app_chat_loop.py -x -q
"""

from __future__ import annotations

import asyncio
import io
from typing import Any

from nanoagent.core.agent import Reply, StopReason
from nanoagent.cli.repl.app import InteractiveSession
from rich.console import Console


class _ScriptedReader:
    """A ``reader`` returning queued input lines in order (the prompt argument is ignored).

    Raises ``AssertionError`` if the loop asks for more input than scripted, so an over-driven
    test fails loudly instead of hanging or reading real stdin.
    """

    def __init__(self, lines: list[str]) -> None:
        self._lines = list(lines)

    def __call__(self, _prompt: str) -> str:
        if not self._lines:
            raise AssertionError("scripted reader exhausted")
        return self._lines.pop(0)


class _ScriptedModel:
    """A scripted ``ChatModel``: each queued item is either a :class:`Reply` to return or a
    ``BaseException`` to raise, consumed in order (the last item repeats for any further turn).

    Records the messages of every query so a test can confirm the loop continued past a failure
    and what the model saw on each turn.
    """

    def __init__(self, script: list[Any]) -> None:
        self._script = script
        self.queries: list[list[dict[str, Any]]] = []

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.queries.append([dict(m) for m in messages])
        item = self._script[min(len(self.queries) - 1, len(self._script) - 1)]
        if isinstance(item, BaseException):
            raise item
        return item


def _session(
    model: Any, reader: _ScriptedReader, *, confirm_exit: bool = True
) -> tuple[InteractiveSession, io.StringIO]:
    """A yolo-mode session (no tools) writing to an in-memory buffer (wide, no wrapping)."""
    buf = io.StringIO()
    session = InteractiveSession(
        model,
        [],
        system_prompt="SYS",
        mode="yolo",
        confirm_exit=confirm_exit,
        reader=reader,
        console=Console(file=buf, width=200, highlight=False),
    )
    return session, buf


# --- error branch: a failed turn records ERROR and the session stays alive ----------------


async def test_chat_error_records_error_stop_reason() -> None:
    # The model raises on its only turn; chat() must catch it, record ERROR, and reach the
    # follow-up prompt (the empty line quits) rather than letting the exception kill the session.
    model = _ScriptedModel([RuntimeError("boom")])
    session, buf = _session(model, _ScriptedReader([""]))
    await session.chat("do the thing")  # must not raise
    assert session.to_result().stop_reason == StopReason.ERROR
    out = buf.getvalue()
    assert "error:" in out and "boom" in out  # the except-Exception branch reported it
    assert "bye" in out  # the empty follow-up drove the quit path


async def test_chat_survives_error_and_runs_followup() -> None:
    # A transient failure on turn 1 must not end the session: the follow-up prompt drives a
    # second task that succeeds. Proves the loop continues (the model is queried twice).
    model = _ScriptedModel([RuntimeError("server down"), Reply(content="recovered")])
    session, _buf = _session(model, _ScriptedReader(["try again", ""]))
    await session.chat("first task")
    assert len(model.queries) == 2  # the loop continued past the error to a second task
    # The second turn actually carried the follow-up task to the model...
    assert any(
        m.get("role") == "user" and m.get("content") == "try again"
        for m in model.queries[1]
    )
    # ...and the session recovered to a clean answer.
    result = session.to_result()
    assert result.answer == "recovered"
    assert result.stop_reason == StopReason.ANSWER


# --- interrupt branch: Ctrl-C records INTERRUPTED -----------------------------------------


async def test_chat_records_interrupted_via_cancelled_query() -> None:
    # A real Ctrl-C during a streamed turn fires the SIGINT handler -> task.cancel(), so the
    # in-flight query raises asyncio.CancelledError, which _query converts to KeyboardInterrupt;
    # chat() maps that to INTERRUPTED. This drives that genuine mechanism (no real signal).
    model = _ScriptedModel([asyncio.CancelledError()])
    session, buf = _session(model, _ScriptedReader([""]))
    await session.chat("long task")  # must not raise
    assert session.to_result().stop_reason == StopReason.INTERRUPTED
    assert "interrupted" in buf.getvalue()


def test_chat_records_interrupted_via_keyboardinterrupt() -> None:
    # The query raising KeyboardInterrupt directly: asyncio's Task re-raises it through the
    # event loop, so it leaks out of asyncio.run exactly as run_and_save absorbs it
    # (try: asyncio.run(session.chat(...)) except KeyboardInterrupt: pass). chat() still records
    # INTERRUPTED before the leak. Sync test: it owns the event loop via asyncio.run.
    model = _ScriptedModel([KeyboardInterrupt()])
    session, _buf = _session(model, _ScriptedReader([""]))
    try:
        asyncio.run(session.chat("long task"))
    except KeyboardInterrupt:
        pass
    assert session.to_result().stop_reason == StopReason.INTERRUPTED


# --- quit / confirm_exit branches ---------------------------------------------------------


async def test_chat_confirm_exit_false_breaks_after_one_task() -> None:
    # confirm_exit=False (the single-task `run` driver) takes the early break after one task: it
    # must NOT prompt for a follow-up. The reader is empty, so any follow-up read would raise.
    model = _ScriptedModel([Reply(content="done")])
    session, buf = _session(model, _ScriptedReader([]), confirm_exit=False)
    await session.chat("only task")  # no follow-up read -> the empty reader is never consulted
    assert len(model.queries) == 1
    result = session.to_result()
    assert result.answer == "done"
    assert result.stop_reason == StopReason.ANSWER
    assert "bye" in buf.getvalue()
