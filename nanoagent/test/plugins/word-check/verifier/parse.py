"""parse_words (the check-words reference) and the check-words task's output check."""

from contract import Case, Label

from .checks import result, words_problem


def verify_input(value):
    if not value.reference.split() or not value.raw.split():
        return result(False, "reference and raw must each hold a word")
    return result(True, "input is valid")


def verify_output(input_value, output_value, workspace):
    problem = words_problem(input_value.reference, output_value.reference) or words_problem(input_value.raw, output_value.raw)
    if problem:
        return result(False, problem)
    if any(word.error is not None for word in output_value.reference):
        return result(False, "a reference word is not all letters")
    return result(True, "words are read", reference=len(output_value.reference), raw=len(output_value.raw))


def expected_verdict(word, references):
    """(label, closest, differs, error) for the raw ``word`` against the reference words."""
    if word.error is not None:
        return Label.UNREADABLE, None, None, word.error
    exact = [reference for reference in references if reference == word.text]
    folded = [reference for reference in references if reference.lower() == word.text.lower()]
    if exact:
        return Label.KNOWN, exact[0], None, None
    if not folded:
        return Label.NEW, None, None, None
    closest = folded[0]
    differs = [case for case, ours, theirs in ((Case.FIRST, word.text[:1], closest[:1]), (Case.REST, word.text[1:], closest[1:])) if ours != theirs]
    return Label.CHANGED, closest, differs, None


def verify_task(arguments, output, reference, workspace):
    references = [word.text for word in reference.reference]
    expected = [(word.text, *expected_verdict(word, references)) for word in reference.raw]
    given = [(verdict.word, verdict.label, verdict.closest, verdict.differs, verdict.error) for verdict in output.verdicts]
    right = sum(ours == theirs for ours, theirs in zip(given, expected))
    valid = given == expected
    message = "every verdict is right" if valid else f"{right} of {len(expected)} verdicts are right, for {len(given)} given"
    return result(valid, message, score=right / max(len(expected), len(given)))
