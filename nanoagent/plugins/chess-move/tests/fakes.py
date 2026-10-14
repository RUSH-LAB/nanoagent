from __future__ import annotations

# A quiet middlegame: the fake engine below knows these three moves and nothing else.
FEN = "r1b2rk1/ppp2ppp/2n2n2/3qp3/1b6/2NP1N2/PPP1BPPP/R1BQ1RK1 w - - 0 8"
AFTER = {
    "c3d5": "r1b2rk1/ppp2ppp/2n2n2/3Np3/1b6/3P1N2/PPP1BPPP/R1BQ1RK1 b - - 0 8",
    "f1e1": "r1b2rk1/ppp2ppp/2n2n2/3qp3/1b6/2NP1N2/PPP1BPPP/R1BQR1K1 b - - 1 8",
    "a2a3": "r1b2rk1/ppp2ppp/2n2n2/3qp3/1b6/P1NP1N2/1PP1BPPP/R1BQ1RK1 b - - 0 8",
}
# What each move is worth to the mover: winning the queen, nothing much, nothing much.
WIN_PROB = {"c3d5": 0.92, "f1e1": 0.51, "a2a3": 0.49}


class FakeEngine:
    """Stockfish's answers for the one position above, without a process."""

    def __init__(self) -> None:
        self.searched: list[tuple[str, int]] = []

    def fen(self, fen: str, moves: tuple[str, ...] = ()) -> str:
        return AFTER[moves[0]] if moves else fen

    def legal(self, fen: str) -> list[str]:
        return list(AFTER)

    def win_prob(self, fen: str, moves: list[str], nodes: int) -> float:
        self.searched.append((moves[0], nodes))
        # The search after the move is the opponent's own view of it.
        return 1.0 - WIN_PROB[moves[0]]


class FakeBoard:
    """A live board that draws nothing: it remembers the drags and clicks it was given."""

    def __init__(self, fen: str, moves: list[str]) -> None:
        self.start = AFTER[moves[-1]] if moves else fen
        self.points: list[list[list[float]]] = []
        self.played: list[str] = []
        self.closed = False

    def shot(self) -> tuple[bytes, int, int]:
        return b"PNG", 676, 676

    def mouse(self, points: list[list[float]]) -> None:
        self.points.append(points)
        if len(points) == 2:
            self.played.append("c3d5")

    def moves(self) -> list[str]:
        return list(self.played)

    def positions(self, moves: list[str]) -> list[str]:
        return [AFTER[move] for move in moves]

    def close(self) -> None:
        self.closed = True
