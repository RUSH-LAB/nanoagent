"""The live board: the game, a page that draws it, and a headless Chrome on the page.

The game starts from a FEN with the side to move as the player's seat. Stockfish keeps the rules:
the page (`page/`, chessgroundx) offers only the moves Stockfish lists, and the server takes only
those. A move is the player's only while it is their turn, so the first move is the only one the
board takes. The page is served on loopback by a server of the board's own, and Chrome
(`plugin.chrome`) shows it, takes the screenshots and works the mouse.
"""

from __future__ import annotations

import json
import mimetypes
import socket
import tempfile
import threading
import time
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from plugin.chrome import Chrome
from plugin.engine import Stockfish

PAGE = Path(__file__).with_name("page")
SIZE = (680, 680)
COLORS = {"w": "white", "b": "black"}


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Game:
    """The position from ``fen`` and the moves played since, kept legal by ``engine``."""

    def __init__(self, fen: str, engine: Stockfish) -> None:
        self.start, self.engine = fen, engine
        self.player = COLORS[fen.split()[1]]
        self.played: list[str] = []
        # The page's requests and the plugin's own calls share the one engine.
        self.lock = threading.Lock()

    def _fen(self) -> str:
        return self.engine.fen(self.start, self.played)

    def state(self) -> dict:
        with self.lock:
            fen = self._fen()
            turn = COLORS[fen.split()[1]]
            legal = self.engine.legal(fen) if turn == self.player else []
        return {
            "fen": fen,
            "player": self.player,
            "turn": turn,
            "legal": legal,
            "last": self.played[-1] if self.played else None,
        }

    def play(self, move: str) -> dict:
        with self.lock:
            fen = self._fen()
            if COLORS[fen.split()[1]] != self.player or move not in self.engine.legal(fen):
                raise ValueError(f"{move!r} is not a move the player can make")
            self.played.append(move)
        return self.state()

    def positions(self, moves: list[str]) -> list[str]:
        with self.lock:
            return [self.engine.fen(self.start, moves[: index + 1]) for index in range(len(moves))]


class Server(ThreadingHTTPServer):
    # Chrome asks for the page's modules all at once; the default backlog of 5 drops some of them.
    request_queue_size = 64


def handler(game: Game) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: bytes, kind: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, value: dict) -> None:
            self._send(200, json.dumps(value).encode(), "application/json")

        def do_GET(self) -> None:
            if self.path == "/state":
                return self._json(game.state())
            path = (PAGE / (self.path.lstrip("/") or "index.html")).resolve()
            if not path.is_file() or not path.is_relative_to(PAGE):
                return self._send(404, b"not found", "text/plain")
            kind = "text/javascript" if path.suffix == ".js" else mimetypes.guess_type(path.name)[0]
            self._send(200, path.read_bytes(), kind or "application/octet-stream")

        def do_POST(self) -> None:
            if self.path != "/move":
                return self._send(404, b"not found", "text/plain")
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            try:
                self._json(game.play(body.get("move") or ""))
            except ValueError as error:
                self._send(400, str(error).encode(), "text/plain")

        def log_message(self, format: str, *args: object) -> None:
            pass

    return Handler


class LiveBoard:
    """The board on ``fen``, until :meth:`close`; its scratch files live in a temporary folder."""

    def __init__(self, fen: str) -> None:
        self._stack = ExitStack()
        try:
            scratch = Path(self._stack.enter_context(tempfile.TemporaryDirectory(prefix="chess-move-")))
            self.game = Game(fen, self._stack.enter_context(Stockfish()))
            server = Server(("127.0.0.1", 0), handler(self.game))
            self._stack.callback(server.server_close)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self._stack.callback(server.shutdown)
            self.chrome = self._stack.enter_context(Chrome(free_port(), SIZE, scratch / "chrome"))
            self.chrome.navigate(f"http://127.0.0.1:{server.server_address[1]}/")
            self._settle()
        except BaseException:
            self._stack.close()
            raise

    def _settle(self) -> None:
        """Wait until the page shows the game as it is: a move's request is on its way or answered."""
        time.sleep(0.1)
        self.chrome.wait_for("document.body.dataset.busy === 'false'", 30.0)

    def shot(self) -> tuple[bytes, int, int]:
        """A PNG of the board alone, and its width and height in pixels."""
        rect = self.chrome.rect("#board")
        return self.chrome.shot(rect), round(rect["width"]), round(rect["height"])

    def mouse(self, points: list[list[float]]) -> None:
        """Press at the first point of the board picture, move through the rest, release at the last."""
        rect = self.chrome.rect("#board")
        self.chrome.drag([(rect["x"] + x, rect["y"] + y) for x, y in points])
        self._settle()

    def moves(self) -> list[str]:
        """The moves played since the start, in UCI."""
        return list(self.game.played)

    def positions(self, moves: list[str]) -> list[str]:
        """The FEN after each of ``moves``."""
        return self.game.positions(moves)

    def close(self) -> None:
        self._stack.close()
