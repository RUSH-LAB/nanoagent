"""Splitting a thinking model's inline `<think>` trace out of the answer."""

from __future__ import annotations

import pytest

from nanoagent.inference.backend import token_cost
from nanoagent.inference.fast_json import dumps, loads
from nanoagent.inference.thinking import split_thinking


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("<think>weighing it</think>the answer", ("weighing it", "the answer")),
        # Some server templates inject the opening tag, so only the close tag is generated.
        ("weighing it</think>the answer", ("weighing it", "the answer")),
        ("  \n<think> spaced </think>\n answer \n", ("spaced", "answer")),
        ("no trace at all", (None, "no trace at all")),  # no close tag -> it is all answer
        ("<think>only thought</think>", ("only thought", None)),  # an empty half becomes None
        ("", (None, "")),
        (None, (None, None)),
    ],
)
def test_split_thinking(text, expected) -> None:
    assert split_thinking(text) == expected


def test_only_a_leading_block_is_split() -> None:
    """The model thinks first, so a `</think>` later in the answer is content, not a second split."""
    reasoning, answer = split_thinking("<think>a</think>answer mentioning </think> inline")
    assert reasoning == "a"
    assert answer == "answer mentioning </think> inline"


def test_token_cost_is_per_million_tokens() -> None:
    usage = {"prompt_tokens": 1_000_000, "completion_tokens": 500_000}
    assert token_cost(usage, input_price=2.0, output_price=4.0) == pytest.approx(4.0)


def test_token_cost_of_a_missing_usage_field_is_zero() -> None:
    assert token_cost({}, input_price=2.0, output_price=4.0) == 0.0


def test_fast_json_round_trips_regardless_of_which_backend_is_installed() -> None:
    """orjson and the stdlib fallback differ only in insignificant whitespace."""
    value = {"name": "tool", "args": {"q": "café", "n": 3}}
    assert loads(dumps(value)) == value
    assert "café" in dumps(value)  # non-ASCII stays raw UTF-8, not \u escapes
