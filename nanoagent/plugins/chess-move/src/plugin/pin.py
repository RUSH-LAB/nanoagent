"""pin_moves, the play-move task's reference: every legal move, where it leads and what it is worth."""

from __future__ import annotations

from contract import PinnedMove, PinOutput
from plugin.engine import position_after

# Per move, on one thread: about a fifth of a second of Stockfish on a laptop core.
NODES = 200_000


def pin_moves(fen: str, moves: list[str], *, engine, nodes: int = NODES) -> PinOutput:
    """Score every legal move for the side to move after ``moves`` from ``fen``, and name the best of them."""
    echoed = engine.fen(fen)
    if echoed != fen:
        raise ValueError(f"Stockfish reads the position as {echoed!r}: give the fen exactly as it writes it")
    position = position_after(engine, fen, moves)
    legal = sorted(engine.legal(position))
    if not legal:
        raise ValueError("the side to move has no legal move: the game is over")
    pinned = [
        # The search is from the opponent's side, after the move.
        PinnedMove(
            move=move, position=engine.fen(position, [move]), win_prob=1.0 - engine.win_prob(position, [move], nodes)
        )
        for move in legal
    ]
    best = max(pinned, key=lambda entry: entry.win_prob).move
    return PinOutput(position=position, nodes=nodes, best=best, moves=pinned)
