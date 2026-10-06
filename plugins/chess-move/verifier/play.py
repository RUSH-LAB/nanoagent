"""The play-move task's outcome: which move the agent played, and what it cost against the best one."""

from .checks import RECORD, record, record_problem, result


def agent_moves(moves):
    """The moves the agent played. It moves first from the position, so those are the even ones;
    anything in between is the opponent's reply and not the agent's to answer for."""
    return moves[0::2]


def verify_task(arguments, reference, workspace):
    """Approve exactly one legal move, and score it by the win probability it gave away.

    The move is read off the recorded game and matched against the pinned legal moves — by its UCI
    spelling and by the position it led to, so a record that disagrees with the engine fails rather
    than scores. No move, a move the position does not have, or a second move of the agent's own
    all fail; the score is 1 minus the win probability lost against the pinned best move.
    """
    game = record(workspace)
    if game is None:
        return result(False, f"the agent played no move: there is no {RECORD}", score=0.0)
    problem = record_problem(game)
    if problem:
        return result(False, problem, score=0.0)
    if game["fen"] != arguments["fen"]:
        return result(False, "the game was played from another position", score=0.0, fen=game["fen"])

    played = agent_moves(game["moves"])
    if not played:
        return result(False, "the agent played no move", score=0.0)
    if len(played) > 1:
        return result(False, f"the agent played {len(played)} moves: {', '.join(played)}", score=0.0)
    move = played[0]
    pinned = {entry["move"]: entry for entry in reference["moves"]}
    if move not in pinned:
        return result(False, f"{move} is not a legal move in this position", score=0.0, legal=sorted(pinned))
    if game["positions"][0] != pinned[move]["position"]:
        return result(False, f"the position recorded after {move} is not the one {move} leads to", score=0.0)

    best = pinned[reference["best"]]
    lost = max(0.0, best["win_prob"] - pinned[move]["win_prob"])
    return result(
        True,
        f"played {move}, giving away {lost:.3f} win probability against {best['move']}",
        score=1.0 - lost,
        move=move,
        win_prob=pinned[move]["win_prob"],
        best=best["move"],
        best_win_prob=best["win_prob"],
        loss=lost,
    )
