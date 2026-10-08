"""Each tool's and task's typed input and output (see nanoagent.plugin.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    PIN_MOVES = "pin_moves"
    OPEN_BOARD = "open_board"
    SCREENSHOT = "screenshot"
    DRAG = "drag"
    CLICK = "click"


class Task(Enum):
    PLAY_MOVE = "play-move"


class MediaType(Enum):
    PNG = "image/png"


POINT = "[x, y] in pixels of the board screenshot, from its top-left corner"


@dataclass
class Position(Output):
    fen: Annotated[str, "A chess position in FEN, as Stockfish writes it; the side to move is the one that plays"]


@dataclass
class PinnedMove(Output):
    move: Annotated[str, "A legal move, in UCI"]
    position: Annotated[str, "The FEN after the move"]
    win_prob: Annotated[float, "The mover's win probability after the move"]


@dataclass
class PinOutput(Output):
    fen: str
    nodes: Annotated[int, "Stockfish's search per move, in nodes, on one thread"]
    best: Annotated[str, "The legal move with the highest win probability for the mover"]
    moves: list[PinnedMove]


@dataclass
class Image(Output):
    media_type: MediaType
    data: Annotated[str, "The PNG, base64"]


@dataclass
class Screenshot(Output):
    width: int
    height: int
    images: list[Image]


@dataclass
class ScreenshotInput(Output):
    """Nothing: the screenshot is of the live board."""


@dataclass
class DragInput(Output):
    from_xy: Annotated[list[float], POINT]
    to_xy: Annotated[list[float], POINT]


@dataclass
class ClickInput(Output):
    xy: Annotated[list[float], POINT]


@dataclass
class Acted(Output):
    """Nothing: what the action did is in board.json."""


TOOLS = {
    Tool.PIN_MOVES: (Position, PinOutput),
    Tool.OPEN_BOARD: (Position, Screenshot),
    Tool.SCREENSHOT: (ScreenshotInput, Screenshot),
    Tool.DRAG: (DragInput, Acted),
    Tool.CLICK: (ClickInput, Acted),
}
TASKS = {Task.PLAY_MOVE: Position}
