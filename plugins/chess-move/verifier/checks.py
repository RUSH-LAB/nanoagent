"""Checks shared by the tool verifiers. Pure functions of their arguments and the files on disk."""

import json
import re
from pathlib import Path

FEN = re.compile(r"^([pnbrqkPNBRQK1-8]{1,8}/){7}[pnbrqkPNBRQK1-8]{1,8} [wb] (-|K?Q?k?q?) (-|[a-h][36]) \d+ \d+$")
MOVE = re.compile(r"^[a-h][1-8][a-h][1-8][nbrq]?$")
RECORD = "board.json"


def result(valid, message, *, score=None, **details):
    return {
        "valid": valid,
        "score": float(valid) if score is None else score,
        "message": message,
        "details": details,
    }


def fen_problem(fen):
    if not isinstance(fen, str) or not FEN.fullmatch(fen):
        return f"{fen!r} is not a chess position in FEN"
    return None


def point_problem(name, point):
    if len(point) != 2:
        return f"{name} must be [x, y]"
    if any(value < 0 for value in point):
        return f"{name} must be two pixel counts, neither negative"
    return None


def record(workspace):
    """The game as the plugin last recorded it, or None when there is no record yet."""
    path = Path(workspace) / RECORD
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def record_problem(value):
    """What is wrong with a recorded game, or None. Each move must have the position it led to."""
    if not isinstance(value, dict):
        return f"{RECORD} must hold an object"
    problem = fen_problem(value.get("fen"))
    if problem:
        return f"{RECORD} records no starting position: {problem}"
    moves, positions = value.get("moves"), value.get("positions")
    if not isinstance(moves, list) or any(not isinstance(move, str) or not MOVE.fullmatch(move) for move in moves):
        return f"{RECORD} must record the moves played, each in UCI"
    if not isinstance(positions, list) or len(positions) != len(moves):
        return f"{RECORD} must record one position per move played"
    if any(fen_problem(position) for position in positions):
        return f"{RECORD} records a position that is not a FEN"
    return None
