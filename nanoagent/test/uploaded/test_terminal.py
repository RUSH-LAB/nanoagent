"""The harness's terminal between the case and RUSH: output sent in order within its bound, the member's input typed at the case."""

from __future__ import annotations

import base64
from typing import Any

import anyio
import pytest

from nanoagent.uploaded.terminal import Terminal


class Rush:
    def __init__(self, inputs: list[dict[str, Any]]) -> None:
        self.screen = b""
        self.inputs = inputs
        self.reads: list[int] = []

    async def terminal(self, attempt_id: str, fence: int, offset: int, data: bytes) -> None:
        assert (attempt_id, fence, offset) == ("a", 3, len(self.screen))
        self.screen += data

    async def terminal_input(self, attempt_id: str, fence: int, after: int) -> list[dict[str, Any]]:
        self.reads.append(after)
        if len(self.reads) > 1:
            await anyio.sleep_forever()
        return self.inputs


class Case:
    def __init__(self) -> None:
        self.typed: list[tuple[bytes | None, int | None, int | None]] = []

    def terminal_input(self, data: bytes | None, rows: int | None = None, cols: int | None = None) -> None:
        self.typed.append((data, rows, cols))


@pytest.mark.anyio
async def test_output_goes_in_order_and_stops_at_its_bound() -> None:
    rush = Rush([])
    terminal = Terminal(rush, "a", 3, limit_bytes=10)  # type: ignore[arg-type]
    terminal.write(b"hello ")
    await terminal.flush()
    terminal.write(b"world, again")
    terminal.write(b"never sent")
    await terminal.flush()
    assert rush.screen.startswith(b"hello worl")
    assert b"passed its 10 byte bound" in rush.screen and b"never" not in rush.screen


@pytest.mark.anyio
async def test_the_members_input_is_typed_at_the_case_in_order() -> None:
    rush = Rush([
        {"seq": 1, "data": None, "rows": 30, "cols": 100},
        {"seq": 2, "data": base64.b64encode(b"hi\r").decode(), "rows": None, "cols": None},
    ])
    case = Case()
    with anyio.move_on_after(1):
        await Terminal(rush, "a", 3).feed(case)  # type: ignore[arg-type]
    assert case.typed == [(None, 30, 100), (b"hi\r", None, None)]
    assert rush.reads == [0, 2]
