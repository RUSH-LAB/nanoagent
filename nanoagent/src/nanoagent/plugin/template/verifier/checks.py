"""Checks shared by the tool verifiers. Pure functions of their arguments and the files on disk."""

from pathlib import Path


def result(valid, message, *, score=None, **details):
    return {
        "valid": valid,
        "score": float(valid) if score is None else score,
        "message": message,
        "details": details,
    }


def destination_problem(destination):
    path = Path(destination)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        return "destination must stay inside the plugin workspace"
    return None
