"""The harness's terminals between the case and RUSH: each one's output sent in order within their shared bound, then that it ended;
the member's input passed to the case, which opens and closes terminals."""

from __future__ import annotations

import base64
from typing import Any

import anyio
import pytest

from nanoagent.uploaded.rush_worker import Canceled, Lease
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
