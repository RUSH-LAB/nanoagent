"""pin_moves, the play-move task's reference: every legal move, where it leads and what it is worth."""

from .checks import MOVE, fen_problem, result


def verify_input(value):
    problem = fen_problem(value.fen)
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    if output_value.fen != input_value.fen:
        return result(False, "the pinned moves are for another position")
    moves = output_value.moves
    if not moves:
        return result(False, "a position with no pinned move cannot be played")
    named = [entry.move for entry in moves]
    if len(set(named)) != len(named):
        return result(False, "a move is pinned twice")
    for entry in moves:
        if not MOVE.fullmatch(entry.move):
            return result(False, f"{entry.move!r} is not a move in UCI")
        problem = fen_problem(entry.position)
        if problem:
            return result(False, f"{entry.move} leads nowhere: {problem}")
        if entry.position.split()[1] == input_value.fen.split()[1]:
            return result(False, f"{entry.move} leaves the same side to move")
        if not 0.0 <= entry.win_prob <= 1.0:
            return result(False, f"{entry.move}'s win probability is not between 0 and 1")
    if output_value.best not in named:
        return result(False, "the best move is not one of the pinned moves")
    best = max(entry.win_prob for entry in moves)
    if output_value.best != next(entry.move for entry in moves if entry.win_prob == best):
        return result(False, "the best move is not the pinned move with the highest win probability")
    return result(True, f"{len(moves)} legal move(s) are pinned", best=output_value.best, win_prob=best)
