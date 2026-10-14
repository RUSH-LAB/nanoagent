from __future__ import annotations

from slimconfig import build_output, plain_output

import verifier
from contract import CheckOutput, ParseInput, ParseOutput
from plugin.words import parse_words

ARGUMENTS = {"reference": "Cat dog bird", "raw": "Cat cat DOG fish b1rd"}
VERDICTS = [
    {"word": "Cat", "label": "known", "closest": "Cat", "differs": None, "error": None},
    {"word": "cat", "label": "changed", "closest": "Cat", "differs": ["first"], "error": None},
    {"word": "DOG", "label": "changed", "closest": "dog", "differs": ["first", "rest"], "error": None},
    {"word": "fish", "label": "new", "closest": None, "differs": None, "error": None},
    {"word": "b1rd", "label": "unreadable", "closest": None, "differs": None, "error": "'b1rd' is not all letters"},
]


# The verifier gets contract instances, as NanoAgent's sandbox builds them from JSON.
def _check(verdicts):
    given = build_output(ARGUMENTS, ParseInput)
    reference = build_output(plain_output(parse_words(given)), ParseOutput)
    return verifier.verify_task("check-words", given, build_output({"verdicts": verdicts}, CheckOutput), reference, ".")


def test_approves_the_parsed_words_and_right_verdicts() -> None:
    given = build_output(ARGUMENTS, ParseInput)
    parsed = build_output(plain_output(parse_words(given)), ParseOutput)
    assert verifier.verify_input("parse_words", given)["valid"] is True
    assert verifier.verify_output("parse_words", given, parsed, ".")["valid"] is True
    assert _check(VERDICTS)["valid"] is True


def test_refuses_a_wrong_or_missing_verdict() -> None:
    wrong = [{**VERDICTS[0], "label": "changed"}, *VERDICTS[1:]]
    assert _check(wrong) == {"valid": False, "score": 0.8, "message": "4 of 5 verdicts are right, for 5 given", "details": {}}
    assert _check(VERDICTS[:4])["valid"] is False
