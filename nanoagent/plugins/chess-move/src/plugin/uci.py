"""Reading Stockfish's UCI replies: its position, its legal moves and its score."""

from __future__ import annotations

BOUNDS = ("lowerbound", "upperbound")


def parse_fen(lines: list[str]) -> str:
    """The position from the reply to `d`."""
    for line in lines:
        if line.startswith("Fen: "):
            return line[len("Fen: ") :].strip()
    raise ValueError("Stockfish printed no Fen: line")


def parse_perft(lines: list[str]) -> list[str]:
    """Every legal move, from the reply to `go perft 1`: one `<move>: 1` line each."""
    moves = []
    for line in lines:
        move, _, count = line.partition(":")
        if count.strip() == "1" and len(move) in (4, 5) and move.isalnum():
            moves.append(move)
    return moves


def parse_score(lines: list[str]) -> tuple[str, int]:
    """The search's last exact score for the side to move, from the reply to `go`: ("cp" or "mate", value)."""
    for line in reversed(lines):
        fields = line.split()
        if fields[:1] == ["info"] and "score" in fields and not any(bound in fields for bound in BOUNDS):
            at = fields.index("score")
            return fields[at + 1], int(fields[at + 2])
    raise ValueError("Stockfish reported no score")
