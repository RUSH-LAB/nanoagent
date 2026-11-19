"""The harness's terminals: each one's output sent to RUSH in order within their shared bound, then that it ended; and the session's
local link, which shows the member's page every terminal's output and passes what they send to the case, which opens and closes
terminals."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncIterator
from concurrent.futures import Future
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import anyio
import pytest

from microsandbox import ExecEventType

from nanoagent.uploaded.records import Fact, TerminalTurn
from nanoagent.uploaded.runner import AttemptRunner
from nanoagent.uploaded.rush_worker import Canceled, Lease
from nanoagent.uploaded.sandbox import Limits, MicrosandboxSupervisor, _Case
from nanoagent.uploaded.terminal import Terminal


class Rush:
    def __init__(self) -> None:
        self.screens: dict[int, bytes] = {}
        self.sent: list[tuple[str, int]] = []  # ("output" | "closed", terminal), in order

    async def terminal(self, attempt_id: str, fence: int, terminal: int, offset: int, data: bytes) -> None:
        assert (attempt_id, fence, offset) == ("a", 3, len(self.screens.get(terminal, b"")))
        self.screens[terminal] = self.screens.get(terminal, b"") + data
        self.sent.append(("output", terminal))

    async def terminal_closed(self, attempt_id: str, fence: int, terminal: int) -> None:
        self.sent.append(("closed", terminal))


async def discard(fact: Fact) -> None:
    pass


class Case:
    def __init__(self, ended: frozenset[int] = frozenset()) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.ended = ended
        self.outputs: dict[int, Any] = {}

    def terminal_input(self, terminal: int, data: bytes | None, rows: int | None = None, cols: int | None = None) -> None:
        self.calls.append(("input", terminal, data, rows, cols))

    def open_terminal(self, terminal: int, rows: int, cols: int, on_output: Any) -> None:
        self.calls.append(("open", terminal, rows, cols))
        self.outputs[terminal] = on_output

    def close_terminal(self, terminal: int) -> None:
        self.calls.append(("close", terminal))

    def ended_terminals(self) -> frozenset[int]:
        return self.ended


class Page:
    """The member's page at the session's link."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.reader, self.writer = reader, writer

    def send(self, **item: Any) -> None:
        self.writer.write(json.dumps(item).encode() + b"\n")

    def type(self, terminal: int, text: bytes) -> None:
        self.send(terminal=terminal, data=base64.b64encode(text).decode())

    async def hear(self) -> dict[str, Any]:
        with anyio.fail_after(2):
            return json.loads(await self.reader.readline())

    async def screen(self, terminal: int, until: bytes) -> bytes:
        seen = b""
        while until not in seen:
            item = await self.hear()
            assert item["terminal"] == terminal, item
            seen += base64.b64decode(item["data"])
        return seen


@asynccontextmanager
async def linked(terminal: Terminal, case: Any, token: str | None = None) -> AsyncIterator[Page]:
    async with anyio.create_task_group() as group:
        port = await group.start(terminal.serve, case)
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        page = Page(reader, writer)
        page.send(token=terminal.token if token is None else token)
        yield page
        writer.close()
        group.cancel_scope.cancel()


async def test_output_goes_to_rush_in_order_and_stops_at_its_bound() -> None:
    rush = Rush()
    terminal = Terminal(rush, "a", 3, discard, limit_bytes=10)  # type: ignore[arg-type]
    terminal.write(0, b"hello ")
    await terminal.flush(Case())
    terminal.write(0, b"world, again")
    terminal.write(1, b"never sent")
    await terminal.flush(Case())
    assert rush.screens[0].startswith(b"hello worl")
    assert b"passed its 10 byte bound" in rush.screens[0] and b"never" not in rush.screens[1]
    assert b"passed its 10 byte bound" in rush.screens[1]


async def test_a_terminal_that_ended_is_told_to_rush_once_after_its_output() -> None:
    rush = Rush()
    terminal = Terminal(rush, "a", 3, discard)  # type: ignore[arg-type]
    terminal.write(1, b"bye")
    await terminal.flush(Case(frozenset({1})))
    await terminal.flush(Case(frozenset({1})))
    assert rush.sent == [("output", 1), ("closed", 1)]


async def test_the_page_sees_output_from_its_first_byte_and_its_input_opens_types_at_and_closes_terminals_in_order() -> None:
    case = Case()
    terminal = Terminal(Rush(), "a", 3, discard, terminals=32)  # type: ignore[arg-type]
    terminal.write(0, b"$ ")  # before the page connected
    async with linked(terminal, case) as page:
        assert await page.screen(0, b"$ ") == b"$ "
        page.send(terminal=0, rows=30, cols=100)
        page.type(0, b"hi\r")
        page.send(terminal=1, rows=20, cols=80)
        page.send(terminal=1, rows=21, cols=81)
        page.send(terminal=1, close=True)
        await page.writer.drain()
        with anyio.fail_after(2):
            while len(case.calls) < 5:
                await anyio.sleep(0.01)
        assert case.calls == [
            ("input", 0, None, 30, 100),
            ("input", 0, b"hi\r", None, None),
            ("open", 1, 20, 80),
            ("input", 1, None, 21, 81),
            ("close", 1),
        ]
        case.outputs[1](b"one$ ")  # the opened terminal's output is its own, and comes as it is written
        assert await page.screen(1, b"one$ ") == b"one$ "
        case.ended = frozenset({1})
        assert await page.hear() == {"terminal": 1, "closed": True}


async def test_each_turn_runs_from_enter_to_the_last_output_before_the_member_types_again_leaving_out_the_wait() -> None:
    now = [100]
    turns: list[Fact] = []

    async def record(fact: Fact) -> None:
        turns.append(fact)

    case = Case()
    terminal = Terminal(Rush(), "a", 3, record, clock_ns=lambda: now[0])  # type: ignore[arg-type]
    async with linked(terminal, case) as page:
        now[0] = 150
        terminal.write(0, b"$ ")  # the shell's prompt: the turn its opening started is done
        for at, text, output in ((1000, b"aider\r", 1400), (5000, b"h", 5000), (5001, b"i\r", 5900)):  # a long wait before "h"
            now[0] = at
            page.type(0, text)
            await page.writer.drain()
            with anyio.fail_after(2):
                while case.calls[-1:] != [("input", 0, text, None, None)]:
                    await anyio.sleep(0.01)
            now[0] = output
            terminal.write(0, text)  # its echo, or the agent's answer
        await terminal.close()
    await terminal.flush(case)
    assert turns == [TerminalTurn(0, 100, 150, 1000), TerminalTurn(0, 1000, 1400, 5000), TerminalTurn(0, 5001, 5900, 5900)]


async def test_a_link_without_the_sessions_token_is_refused_and_one_naming_another_terminal_is_closed() -> None:
    async with linked(Terminal(Rush(), "a", 3, discard), Case(), token="guess") as page:  # type: ignore[arg-type]
        assert await page.hear() == {"error": "the link's token is not this session's"}
        assert await page.reader.read() == b""
    case = Case()
    async with linked(Terminal(Rush(), "a", 3, discard), case) as page:  # type: ignore[arg-type]
        page.send(terminal=1, rows=20, cols=80)  # a scored case has terminal 0 alone
        assert await page.hear() == {"error": "terminal is a terminal's id, 0 to 0"}
        assert await page.reader.read() == b"" and case.calls == []


async def test_a_closing_session_sends_the_page_what_is_left_then_ends_its_link() -> None:
    case = Case()
    terminal = Terminal(Rush(), "a", 3, discard)  # type: ignore[arg-type]
    async with linked(terminal, case) as page:
        await page.writer.drain()
        await anyio.sleep(0.1)
        terminal.write(0, b"bye\r\n")
        case.ended = frozenset({0})
        await terminal.close()
        assert await page.screen(0, b"bye") == b"bye\r\n"
        assert await page.hear() == {"terminal": 0, "closed": True}
        assert await page.reader.read() == b""


async def test_a_cancel_answered_to_the_watch_revokes_the_lease_at_once() -> None:
    class Canceling:
        async def watch(self, attempt_id: str, fence: int) -> None:
            raise Canceled(409, "canceled", "The run was canceled")

    lease = Lease("a", 3)
    with anyio.fail_after(1):
        await AttemptRunner._watch(SimpleNamespace(worker=Canceling()), lease)  # type: ignore[arg-type]
    assert lease.revoked.is_set() and lease.reason == "canceled"


class Sandbox:
    """A microsandbox VM whose calls, as microsandbox's own do, create their future as they are called: on the loop, or they fail."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    def _on_loop(self, call: tuple[Any, ...]) -> Any:
        asyncio.get_running_loop()  # RuntimeError: no running event loop, off the loop
        self.calls.append(call)
        return asyncio.sleep(0)

    def exec(self, cmd: str, args: list[str], *, user: str, timeout: int) -> Any:
        return self._on_loop(("exec", cmd, *args))

    def exec_stream(self, cmd: str, args: list[str], **kwargs: Any) -> Any:
        sandbox = self

        class Handle:
            def take_stdin(self) -> Any:
                return SimpleNamespace(write=lambda data: sandbox._on_loop(("write", data)))

            def resize(self, rows: int, cols: int) -> Any:
                return sandbox._on_loop(("resize", rows, cols))

            def __aiter__(self) -> Any:
                return self._events()

            async def _events(self) -> Any:
                yield SimpleNamespace(event_type=ExecEventType.STARTED, data=None)
                await asyncio.sleep(3600)

        async def stream() -> Handle:
            sandbox.calls.append(("exec_stream", kwargs["env"]["RUSH_TERMINAL"]))
            return Handle()

        asyncio.get_running_loop()
        return stream()


@pytest.mark.anyio
async def test_the_member_opens_a_second_terminal_in_the_case_from_the_link(tmp_path: Path) -> None:
    sandbox = Sandbox()
    case = _Case(
        MicrosandboxSupervisor(tools=tmp_path / "tools"),
        SimpleNamespace(limits=Limits(), run_argv=("bash",)),  # type: ignore[arg-type]
        "rush-case-x",
        sandbox,
        None,
        tmp_path,
        tmp_path / "out",
        {},  # type: ignore[arg-type]
    )
    case._future, case._env, case._deadline = Future(), {"RUSH_TERMINAL": "0"}, case._s._clock() + 3600
    async with linked(Terminal(Rush(), "a", 3, discard, terminals=32), case) as page:  # type: ignore[arg-type]
        page.send(terminal=1, rows=20, cols=80)
        with anyio.fail_after(2):
            while len(sandbox.calls) < 3:
                await anyio.sleep(0.01)
    assert sandbox.calls == [("exec", "mkdir", "-p", "-m", "0755", "/rush-trace/terminal-1"), ("exec_stream", "1"), ("resize", 20, 80)]
    assert case.ended_terminals() == frozenset()


async def test_a_terminal_that_cannot_open_ends_alone_with_why_printed_in_it() -> None:
    class Failing(Case):
        def open_terminal(self, terminal: int, rows: int, cols: int, on_output: Any) -> None:
            raise RuntimeError("no running event loop")

    rush, case = Rush(), Failing()
    terminal = Terminal(rush, "a", 3, discard, terminals=32)  # type: ignore[arg-type]
    async with linked(terminal, case) as page:
        page.send(terminal=1, rows=20, cols=80)
        page.type(0, b"ls\r")
        assert b"could not open: RuntimeError: no running event loop" in await page.screen(1, b"\r\n")
        assert await page.hear() == {"terminal": 1, "closed": True}
    await terminal.flush(case)
    assert case.calls == [("input", 0, b"ls\r", None, None)]
    assert rush.sent == [("output", 1), ("closed", 1)]



async def test_a_chat_clicked_while_the_session_is_live_opens_in_its_next_terminal_and_the_session_runs_on(tmp_path: Path) -> None:
    case = Case()
    case.workspace = tmp_path / "workspace"  # type: ignore[attr-defined]
    terminal = Terminal(Rush(), "a", 3, discard, terminals=32, scratch=tmp_path / "scratch")  # type: ignore[arg-type]
    why = "That session ran in a harness run, not a terminal, so it can't be reopened; started a new claude session"
    async with linked(terminal, case) as page:
        page.send(terminal=1, rows=20, cols=80)  # the member's own second terminal
        page.send(reopen={"start": "claude", "line": why}, rows=24, cols=90)
        page.send(reopen={"resume": "11111111-1111-4111-8111-000000000001", "chat": {"agent": "codex", "id": "c-1", "run": None}}, rows=24, cols=90)
        await page.writer.drain()
        with anyio.fail_after(2):
            while len(case.calls) < 3:
                await anyio.sleep(0.01)
        assert case.calls == [("open", 1, 20, 80), ("open", 2, 24, 90), ("open", 3, 24, 90)]  # new terminals; none closed
        assert json.loads((case.workspace / ".rush/resume-2.json").read_text()) == {"run": "claude", "line": why}
        gone = json.loads((case.workspace / ".rush/resume-3.json").read_text())  # this computer never kept that session
        assert gone["run"] == "codex" and gone["line"].startswith("That session's files are no longer on this computer")
        page.send(reopen={"start": "claude; rm -rf /", "line": "x"}, rows=24, cols=90)
        assert (await page.hear())["error"].startswith("reopen is")
