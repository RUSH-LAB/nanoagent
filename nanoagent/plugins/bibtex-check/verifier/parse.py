"""parse_bibtex (the check-bibtex reference) and the check-bibtex task's output check."""

from contract import Field, Label

from .checks import entries_problem, result, text_problem
from .schema import closest_reference

# The Verdict fields a verdict is judged on, besides its key.
FIELDS = ("title", "label", "closest", "differs", "error")


def verify_input(value):
    problem = text_problem("reference", value.reference) or text_problem("raw", value.raw)
    if problem:
        return result(False, problem)
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    for name, entries in (("reference", output_value.reference), ("raw", output_value.raw)):
        problem = entries_problem(entries)
        if problem:
            return result(False, f"{name}: {problem}")
    if any(entry.record is None for entry in output_value.reference):
        return result(False, "a reference entry does not parse into the schema")
    return result(
        True, "entries are well formed", reference=len(output_value.reference), raw=len(output_value.raw)
    )


def expected_verdict(entry, references):
    """The right verdict for one raw entry, as (title, label, closest, differs, error)."""
    if entry.record is None:
        return None, Label.UNREADABLE, None, [], entry.error
    closest = closest_reference(entry.record, references)
    if closest is None:
        return entry.record.title, Label.INVENTED, None, [], None
    reference, shared = closest
    differs = [field for field in Field if field.value not in shared]
    return entry.record.title, Label.FIXABLE if differs else Label.REAL, reference.key, differs, None


def verify_task(arguments, output, reference, workspace):
    """Approve the verdicts only when every raw entry has exactly one, in order, and each is right in
    every field, recomputed from the pinned records."""
    expected = {entry.key: expected_verdict(entry, reference.reference) for entry in reference.raw}
    problems = {}
    keys = [verdict.key for verdict in output.verdicts]
    for verdict in output.verdicts:
        given = (verdict.title, verdict.label, verdict.closest, verdict.differs, verdict.error)
        if verdict.key not in expected:
            problems[verdict.key] = "not a raw entry"
        elif keys.count(verdict.key) > 1:
            problems[verdict.key] = "more than one verdict"
        elif given != expected[verdict.key]:
            wrong = [name for name, mine, right in zip(FIELDS, given, expected[verdict.key]) if mine != right]
            problems[verdict.key] = f"wrong {', '.join(wrong)}: the entry is {expected[verdict.key][1].value}"
    for key in expected:
        if key not in keys:
            problems[key] = "no verdict"
    if not problems and keys != list(expected):
        problems["order"] = "the verdicts are not in the order of the raw BibTeX"

    correct = [key for key in expected if key not in problems]
    score = len(correct) / len(expected) if expected else float(not problems)
    if problems:
        return result(False, f"{len(problems)} verdict(s) fail the check", score=score, problems=problems)
    return result(True, f"all {len(expected)} verdict(s) are right", score=score)
