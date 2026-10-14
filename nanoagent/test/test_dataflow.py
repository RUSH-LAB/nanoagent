import asyncio
import dataclasses
import enum
from typing import Annotated

import pytest

from nanoagent.plugin.dataflow import Answers, DecisionError, Question, answer_schema, check, fill, unfillable, values

QUESTIONS = [
    Question("next", "one", "Which tool runs next?", ("read_bibtex", "submit")),
    Question("differs", "some", "Which fields differ?", ("title", "year", "venue")),
]


def test_the_answer_schema_is_one_flat_strict_object() -> None:
    assert answer_schema(QUESTIONS) == {
        "type": "object",
        "properties": {
            "next": {"type": "string", "enum": ["read_bibtex", "submit"], "description": "Which tool runs next?"},
            "differs": {
                "type": "array",
                "items": {"type": "string", "enum": ["title", "year", "venue"]},
                "description": "Which fields differ?",
            },
        },
        "required": ["next", "differs"],
        "additionalProperties": False,
    }


def test_check_takes_an_answer_from_the_options() -> None:
    check(QUESTIONS, Answers({"next": "submit", "differs": ["year", "title"]}))
    check(QUESTIONS, Answers({"next": "submit", "differs": []}))


@pytest.mark.parametrize(
    ("values", "message"),
    [
        ({"next": "write", "differs": []}, "next: 'write' is not one of"),
        ({"next": ["submit"], "differs": []}, "next: \\['submit'\\] is not one of"),
        ({"next": "submit", "differs": ["author"]}, "differs: \\['author'\\] is not a list of"),
        ({"next": "submit", "differs": "title"}, "differs: 'title' is not a list of"),
        ({"next": "submit", "differs": ["year", "year"]}, "names an option twice"),
        ({"next": "submit"}, "do not match the questions"),
        ({"next": "submit", "differs": [], "why": "x"}, "do not match the questions"),
    ],
)
def test_check_refuses_an_answer_outside_its_questions(values: dict, message: str) -> None:
    with pytest.raises(DecisionError, match=message):
        check(QUESTIONS, Answers(values))


class Tag(enum.Enum):
    A = "a"
    B = "b"


@dataclasses.dataclass
class Source:
    name: str


@dataclasses.dataclass
class Target:
    tags: list[Tag]
    maybe_tags: list[Tag] | None
    name: Annotated[str, "the name"] | None


def test_fill_builds_what_unfillable_accepts() -> None:
    assert unfillable({"output": Target}, [Source]) == []
    pool = values({"name": "x"}, Source, "input")
    script = [
        {"tags": ["b", "a"], "maybe_tags": "build", "name": "input.name"},
        {"value": ["b", "a"]},
    ]
    asked: list[list[Question]] = []

    async def ask(questions: list[Question], forced: dict[str, str]) -> dict[str, str | list[str]]:
        asked.append(questions)
        return script[len(asked) - 1]

    # A list of choices keeps declaration order, whatever order the answer named them in.
    assert asyncio.run(fill(Target, "output", pool, ask)) == {"tags": ["a", "b"], "maybe_tags": ["a", "b"], "name": "x"}
    assert [question.options for question in asked[0]] == [("a", "b"), ("build", "null"), ("input.name", "null")]
    assert [question.kind for question in asked[1]] == ["some"]
