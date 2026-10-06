"""Checks shared by the tool verifiers. Pure functions of their arguments and the files on disk."""

from pathlib import Path

from .schema import record_problem


def result(valid, message, *, score=None, **details):
    return {
        "valid": valid,
        "score": float(valid) if score is None else score,
        "message": message,
        "details": details,
    }


def path_problem(name, path):
    if not isinstance(path, str) or not path:
        return f"{name} must be a non-empty string"
    relative = Path(path)
    if relative.is_absolute() or ".." in relative.parts:
        return f"{name} must stay inside the plugin workspace"
    return None


def entries_problem(entries):
    """What is wrong with a list of parsed entries, or None."""
    if not isinstance(entries, list):
        return "entries must be a list"
    keys = [entry.get("key") for entry in entries]
    if len(set(keys)) != len(keys):
        return "a key is listed twice"
    for entry in entries:
        if entry["record"] is None:
            if not entry["error"]:
                return f"entry {entry['key']!r} has neither a record nor an error"
            continue
        if entry["error"] is not None:
            return f"entry {entry['key']!r} has both a record and an error"
        problem = record_problem(entry["record"])
        if problem:
            return f"entry {entry['key']!r}: {problem}"
    return None
