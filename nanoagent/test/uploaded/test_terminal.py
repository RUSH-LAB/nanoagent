"""The harness's terminals between the case and RUSH: each one's output sent in order within their shared bound, then that it ended;
the member's input passed to the case, which opens and closes terminals."""

from __future__ import annotations

import asyncio
import base64
from concurrent.futures import Future
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import anyio
import pytest

from microsandbox import ExecEventType

from nanoagent.uploaded.rush_worker import Canceled, Lease
from nanoagent.uploaded.sandbox import Limits, MicrosandboxSupervisor, _Case
from nanoagent.uploaded.terminal import Terminal


class Rush:
    def __init__(self, inputs: list[dict[str, Any]]) -> None:
        self.screens: dict[int, bytes] = {}
        self.sent: list[tuple[str, int]] = []  # ("output" | "closed", terminal), in order
        self.inputs = inputs
        self.reads: list[int] = []

    async def terminal(self, attempt_id: str, fence: int, terminal: int, offset: int, data: bytes) -> None:
        assert (attempt_id, fence, offset) == ("a", 3, len(self.screens.get(terminal, b"")))
        self.screens[terminal] = self.screens.get(terminal, b"") + data
        self.sent.append(("output", terminal))

    async def terminal_closed(self, attempt_id: str, fence: int, terminal: int) -> None:
        self.sent.append(("closed", terminal))

    async def terminal_input(self, attempt_id: str, fence: int, after: int) -> list[dict[str, Any]]:
        self.reads.append(after)
        if len(self.reads) > 1:
            await anyio.sleep_forever()
        return self.inputs


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


@pytest.mark.anyio
async def test_output_goes_in_order_and_stops_at_its_bound() -> None:
    rush = Rush([])
    terminal = Terminal(rush, "a", 3, limit_bytes=10)  # type: ignore[arg-type]
    terminal.write(0, b"hello ")
    await terminal.flush(Case())
    terminal.write(0, b"world, again")
    terminal.write(1, b"never sent")
    await terminal.flush(Case())
    assert rush.screens[0].startswith(b"hello worl")
    assert b"passed its 10 byte bound" in rush.screens[0] and b"never" not in rush.screens[1]
    assert b"passed its 10 byte bound" in rush.screens[1]


@pytest.mark.anyio
async def test_a_terminal_that_ended_is_told_once_after_its_output() -> None:
    rush = Rush([])
    terminal = Terminal(rush, "a", 3)  # type: ignore[arg-type]
    terminal.write(1, b"bye")
    await terminal.flush(Case(frozenset({1})))
    await terminal.flush(Case(frozenset({1})))
    assert rush.sent == [("output", 1), ("closed", 1)]


@pytest.mark.anyio
async def test_the_members_input_opens_types_at_and_closes_terminals_in_order() -> None:
    rush = Rush([
        {"seq": 1, "terminal": 0, "data": None, "rows": 30, "cols": 100, "close": False},
        {"seq": 2, "terminal": 0, "data": base64.b64encode(b"hi\r").decode(), "rows": None, "cols": None, "close": False},
        {"seq": 3, "terminal": 1, "data": None, "rows": 20, "cols": 80, "close": False},
        {"seq": 4, "terminal": 1, "data": None, "rows": 21, "cols": 81, "close": False},
        {"seq": 5, "terminal": 1, "data": None, "rows": None, "cols": None, "close": True},
    ])
    case = Case()
    terminal = Terminal(rush, "a", 3)  # type: ignore[arg-type]
    with anyio.move_on_after(1):
        await terminal.feed(case, Lease("a", 3))  # type: ignore[arg-type]
    assert case.calls == [
        ("input", 0, None, 30, 100), ("input", 0, b"hi\r", None, None), ("open", 1, 20, 80), ("input", 1, None, 21, 81), ("close", 1),
    ]
    assert rush.reads == [0, 5]
    case.outputs[1](b"$ ")  # the opened terminal's output is its own
    await terminal.flush(case)
    assert rush.screens == {1: b"$ "}


@pytest.mark.anyio
async def test_a_cancel_answered_to_the_input_read_revokes_the_lease_at_once() -> None:
    class Canceling(Rush):
        async def terminal_input(self, attempt_id: str, fence: int, after: int) -> list[dict[str, Any]]:
            raise Canceled(409, "canceled", "The run was canceled")

    lease = Lease("a", 3)
    with anyio.fail_after(1):
        await Terminal(Canceling([]), "a", 3).feed(Case(), lease)  # type: ignore[arg-type]
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
async def test_the_member_opens_a_second_terminal_in_the_case_from_the_input_reader(tmp_path: Path) -> None:
    sandbox = Sandbox()
    case = _Case(
        MicrosandboxSupervisor(tools=tmp_path / "tools"), SimpleNamespace(limits=Limits(), run_argv=("bash",)),  # type: ignore[arg-type]
        "rush-case-x", sandbox, None, tmp_path, tmp_path / "out", {},  # type: ignore[arg-type]
    )
    case._future, case._env, case._deadline = Future(), {"RUSH_TERMINAL": "0"}, case._s._clock() + 3600
    rush = Rush([{"seq": 1, "terminal": 1, "data": None, "rows": 20, "cols": 80, "close": False}])
    terminal = Terminal(rush, "a", 3)  # type: ignore[arg-type]
    with anyio.move_on_after(1):
        await terminal.feed(case, Lease("a", 3))  # type: ignore[arg-type]
    assert sandbox.calls == [("exec", "mkdir", "-p", "-m", "0755", "/rush-trace/terminal-1"), ("exec_stream", "1"), ("resize", 20, 80)]
    assert case.ended_terminals() == frozenset()


@pytest.mark.anyio
async def test_a_terminal_that_cannot_open_ends_alone_with_why_printed_in_it() -> None:
    class Failing(Case):
        def open_terminal(self, terminal: int, rows: int, cols: int, on_output: Any) -> None:
            raise RuntimeError("no running event loop")

    rush = Rush([
        {"seq": 1, "terminal": 1, "data": None, "rows": 20, "cols": 80, "close": False},
        {"seq": 2, "terminal": 0, "data": base64.b64encode(b"ls\r").decode(), "rows": None, "cols": None, "close": False},
    ])
    case, lease = Failing(), Lease("a", 3)
    terminal = Terminal(rush, "a", 3)  # type: ignore[arg-type]
    with anyio.move_on_after(1):
        await terminal.feed(case, lease)  # type: ignore[arg-type]
    await terminal.flush(case)
    assert case.calls == [("input", 0, b"ls\r", None, None)] and not lease.revoked.is_set()
    assert b"could not open: RuntimeError: no running event loop" in rush.screens[1]
    assert rush.sent == [("output", 1), ("closed", 1)]
