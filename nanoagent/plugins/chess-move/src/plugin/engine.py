"""Stockfish over UCI, deterministic: one thread, a cleared hash and a fixed node count per search."""

from __future__ import annotations

import math
import subprocess
from collections.abc import Sequence
from typing import Self

from chess_move_stockfish import BINARY

from plugin.uci import parse_fen, parse_perft, parse_score

HASH_MB = 16
# Centipawns to the side to move's win probability: the logistic lichess fits to its games.
CP_SCALE = 0.00368208
CP_CLAMP = 4000.0
# A forced mate is a win, short of certain.
MATE_WIN = 0.999


def wp_from_cp(cp: float) -> float:
    return 1.0 / (1.0 + math.exp(-CP_SCALE * max(-CP_CLAMP, min(CP_CLAMP, cp))))


def wp_from_mate(moves: int) -> float:
    """A `score mate N` for the side to move: positive N mates, negative N gets mated."""
    return MATE_WIN if moves > 0 else 1.0 - MATE_WIN


class Stockfish:
    """One Stockfish process. Every search starts from `ucinewgame`, so none depends on the last."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [str(BINARY)],
            cwd=BINARY.parent,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self._send("uci")
        self._read_until("uciok")
        self._send("setoption name Threads value 1")
        self._send(f"setoption name Hash value {HASH_MB}")
        self._ready()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _send(self, line: str) -> None:
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def _read_until(self, prefix: str) -> list[str]:
        lines = []
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"Stockfish exited before answering {prefix!r}")
            lines.append(line.strip())
            if lines[-1].startswith(prefix):
                return lines

    def _ready(self) -> None:
        self._send("isready")
        self._read_until("readyok")

    def _position(self, fen: str, moves: Sequence[str]) -> None:
        self._send(f"position fen {fen}" + (" moves " + " ".join(moves) if moves else ""))

    def fen(self, fen: str, moves: Sequence[str] = ()) -> str:
        """The position after ``moves`` from ``fen``, as Stockfish writes it."""
        self._position(fen, moves)
        self._send("d")
        return parse_fen(self._read_until("Checkers:"))

    def legal(self, fen: str) -> list[str]:
        self._position(fen, ())
        self._send("go perft 1")
        return parse_perft(self._read_until("Nodes searched:"))

    def win_prob(self, fen: str, moves: Sequence[str], nodes: int) -> float:
        """The side to move's win probability after ``moves``, from the score of a ``nodes`` search."""
        self._send("ucinewgame")
        self._ready()
        self._position(fen, moves)
        self._send(f"go nodes {nodes}")
        kind, value = parse_score(self._read_until("bestmove"))
        return wp_from_mate(value) if kind == "mate" else wp_from_cp(value)

    def close(self) -> None:
        try:
            self._send("quit")
            self.proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()
