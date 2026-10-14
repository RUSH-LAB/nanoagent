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
class Game(Output):
    fen: Annotated[
        str,
        "The position the game is played from, in FEN as Stockfish writes it; for a game from the start,"
        " rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    ]
    moves: Annotated[
        list[str],
        "The moves played since that position, oldest first, in UCI: the from and to squares (e2e4), a promotion"
        " adds the piece (e7e8q); [] to play from the position itself. The side to move after them plays",
    ]


@dataclass
class PinnedMove(Output):
    move: Annotated[str, "A legal move, in UCI"]
    position: Annotated[str, "The FEN after the move"]
    win_prob: Annotated[float, "The mover's win probability after the move"]


@dataclass
class PinOutput(Output):
    position: Annotated[str, "The FEN the game's moves lead to, whose legal moves are pinned"]
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
    moves: Annotated[list[str], "The moves played on the board since it opened, in UCI"]
    position: Annotated[str, "The FEN on the board now"]


@dataclass
class PlayedMove(Output):
    move: Annotated[str, "The move played, in UCI"]
    position: Annotated[str, "The FEN after the move"]
    moves: Annotated[list[str], "The game's moves from its starting position, in UCI, ending with the move played"]


TOOLS = {
    Tool.PIN_MOVES: (Game, PinOutput),
    Tool.OPEN_BOARD: (Game, Screenshot),
    Tool.SCREENSHOT: (ScreenshotInput, Screenshot),
    Tool.DRAG: (DragInput, Acted),
    Tool.CLICK: (ClickInput, Acted),
}
TASKS = {Task.PLAY_MOVE: (Game, PlayedMove)}
