"""pin_moves, the play-move task's reference: every legal move, where it leads and what it is worth."""

from __future__ import annotations

# Per move, on one thread: about a fifth of a second of Stockfish on a laptop core.
NODES = 200_000


def pin_moves(fen: str, *, engine, nodes: int = NODES) -> dict:
    """Score every legal move of ``fen`` for the side to move, and name the best of them."""
    echoed = engine.fen(fen)
    if echoed != fen:
        raise ValueError(f"Stockfish reads the position as {echoed!r}: give the fen exactly as it writes it")
    legal = sorted(engine.legal(fen))
    if not legal:
        raise ValueError("the side to move has no legal move: the game is over")
    moves = [
        # The search is from the opponent's side, after the move.
        {"move": move, "position": engine.fen(fen, [move]), "win_prob": 1.0 - engine.win_prob(fen, [move], nodes)}
        for move in legal
    ]
    best = max(moves, key=lambda entry: entry["win_prob"])["move"]
    return {"ok": True, "fen": fen, "nodes": nodes, "best": best, "moves": moves}
