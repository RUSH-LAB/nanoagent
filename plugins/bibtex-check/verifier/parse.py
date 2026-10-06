"""parse_bibtex (the check-bibtex reference) and the check-bibtex task's outcome check."""

import json
from pathlib import Path

from .checks import entries_problem, path_problem, result
from .schema import match_key
from .verdicts import LABELS, VERDICTS


def verify_input(value):
    problem = path_problem("reference", value.get("reference")) or path_problem("raw", value.get("raw"))
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    for name in ("reference", "raw"):
        problem = entries_problem(output_value.get(name))
        if problem:
            return result(False, f"{name}: {problem}")
    if any(entry["record"] is None for entry in output_value["reference"]):
        return result(False, "a reference entry does not parse into the schema")
    return result(
        True, "entries are well formed", reference=len(output_value["reference"]), raw=len(output_value["raw"])
    )


def verify_task(arguments, reference, workspace):
    """Approve the verdicts only when every raw entry has one, and each is right: `real` for an exact
    match of a pinned reference record, `hallucinated` for no match. An unparseable entry is no match."""
    raw = reference["raw"]
    path = Path(workspace) / VERDICTS
    if not path.is_file():
        return result(False, f"no verdicts at {VERDICTS}", score=0.0)
    verdicts = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(verdicts, dict):
        return result(False, f"{VERDICTS} does not map raw entry keys to verdicts", score=0.0)

    known = {match_key(entry["record"]) for entry in reference["reference"]}
    expected = {
        entry["key"]: "real" if entry["record"] is not None and match_key(entry["record"]) in known else "hallucinated"
        for entry in raw
    }
    problems = {}
    for key, label in expected.items():
        if key not in verdicts:
            problems[key] = "no verdict"
        elif verdicts[key] not in LABELS:
            problems[key] = f"verdict {verdicts[key]!r} is not real or hallucinated"
        elif verdicts[key] != label:
            problems[key] = f"verdict {verdicts[key]} is wrong: the entry is {label}"
    for key in verdicts:
        if key not in expected:
            problems[key] = "not a raw entry"

    correct = [key for key in expected if key not in problems]
    score = len(correct) / len(expected) if expected else float(not problems)
    if problems:
        return result(False, f"{len(problems)} verdict(s) fail the check", score=score, problems=problems)
    return result(True, f"all {len(expected)} verdict(s) are right", score=score, expected=expected)
