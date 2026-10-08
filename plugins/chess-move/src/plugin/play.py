"""The agent's tools on one live board, and the record of the game they leave in `board.json`.

The board (see `plugin.board.LiveBoard`) is opened by the first `open_board` and kept for the
whole task: NanoAgent runs one plugin process per task, so every later call works the same page.
After every action, `board.json` holds what the engine reports: the moves played since the start
and the position after each one.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from pathlib import Path

from contract import Acted, ClickInput, DragInput, Image, MediaType, Position, Screenshot, ScreenshotInput

RECORD = "board.json"


class Play:
    """The tools, over the board ``open_live(fen)`` opens."""

    def __init__(self, open_live: Callable[[str], object]) -> None:
        self._open_live = open_live
        self.live = None
        self.fen = None

    def open_board(self, given: Position, workspace: Path) -> Screenshot:
        if self.live is not None:
            raise ValueError("the board is already open")
        self.live = self._open_live(given.fen)
        self.fen = given.fen
        self._record(workspace)
        return self.screenshot(ScreenshotInput(), workspace)

    def screenshot(self, given: ScreenshotInput, workspace: Path) -> Screenshot:
        png, width, height = self._board().shot()
        image = Image(media_type=MediaType.PNG, data=base64.b64encode(png).decode("ascii"))
        return Screenshot(width=width, height=height, images=[image])

    def drag(self, given: DragInput, workspace: Path) -> Acted:
        self._board().mouse([given.from_xy, given.to_xy])
        return self._record(workspace)

    def click(self, given: ClickInput, workspace: Path) -> Acted:
        self._board().mouse([given.xy])
        return self._record(workspace)

    def close(self) -> None:
        if self.live is not None:
            self.live.close()
            self.live = None

    def _board(self):
        if self.live is None:
            raise ValueError("the board is not open: call open_board first")
        return self.live

    def _record(self, workspace: Path) -> Acted:
        moves = self.live.moves()
        record = {"fen": self.fen, "moves": moves, "positions": self.live.positions(moves)}
        (workspace / RECORD).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        return Acted()
