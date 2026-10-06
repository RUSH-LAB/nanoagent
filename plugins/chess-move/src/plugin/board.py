"""mind-sports-arena's chess app, live: its web server, a headless Chrome on the page, and the game.

Started the way msa's arena starts a match (`msa.arena.session`): the server from `msa.web.build`
with chess alone and the page `driven`, so the page never asks the engine for a reply; msa's own
headless Chrome (`msa.cdp.Headless`, at $CHROME_BIN); and `msa.arena.Page`, which crops the board
out of the page and works it with the real mouse over CDP. The game is set up from the FEN with
the side to move as the player's seat.
"""

from __future__ import annotations

import os
import socket
import sys
import tempfile
import threading
from contextlib import ExitStack
from pathlib import Path

sys.path.insert(0, str(Path(os.environ["MSA_ROOT"]) / "src"))

from msa import web
from msa.arena import Page
from msa.cdp import Headless
from msa.config import GamesCfg, UciCfg, UciOption, WebCfg

from plugin.engine import Stockfish

SIZE = (900, 900)


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class LiveBoard:
    """The chess app on ``fen``, until :meth:`close`; its scratch files live in a temporary folder."""

    def __init__(self, fen: str) -> None:
        self._stack = ExitStack()
        try:
            scratch = Path(self._stack.enter_context(tempfile.TemporaryDirectory(prefix="chess-move-")))
            cfg = WebCfg(
                port=0,
                view=None,
                analysis=False,
                driven=True,
                expdir=str(scratch / "runs"),
                games=GamesCfg(go=None, xiangqi=None, chess=UciCfg(options={UciOption.threads: 1})),
            )
            httpd, self.games = web.build(cfg, str(scratch))
            self._stack.callback(self.games.close)
            self._stack.callback(httpd.server_close)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            self._stack.callback(httpd.shutdown)
            with self.games.locks["chess"]:
                self.game = self.games.get("chess")
                self.game.fen, self.game.you = fen, 0 if fen.split()[1] == "w" else 1
                self.game.new()
            tab = self._stack.enter_context(Headless(free_port(), SIZE, profile=scratch / "chrome"))
            host, port = httpd.server_address[:2]
            self.page = Page(tab, f"http://{host}:{port}", "chess", keep_shots=False)
            self.engine = self._stack.enter_context(Stockfish())
        except BaseException:
            self._stack.close()
            raise

    def shot(self) -> tuple[bytes, int, int]:
        """A PNG of the board alone, and its width and height in pixels."""
        png, rect = self.page.shot()
        return png, round(rect["width"]), round(rect["height"])

    def mouse(self, points: list[list[float]]) -> None:
        """Press at the first point of the board picture, move through the rest, release at the last."""
        self.page.mouse(points)
        self.page.settle()

    def moves(self) -> list[str]:
        """The moves the engine has played since the start, in UCI."""
        return self.games.act("chess", "state", {})["moves"]

    def positions(self, moves: list[str]) -> list[str]:
        """The FEN after each of ``moves``."""
        return [self.engine.fen(self.game.fen, moves[: index + 1]) for index in range(len(moves))]

    def close(self) -> None:
        self._stack.close()
