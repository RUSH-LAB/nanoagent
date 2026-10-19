"""Each tool's and task's typed input and output (see nanoagent.plugin.v0001.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    PARSE_WORDS = "parse_words"
    READ_WORDS = "read_words"


class Task(Enum):
    CHECK_WORDS = "check-words"


class Label(Enum):
    KNOWN = "known"
    CHANGED = "changed"
    NEW = "new"
    UNREADABLE = "unreadable"


class Case(Enum):
    FIRST = "first"
    REST = "rest"


@dataclass
class Word(Output):
    text: Annotated[str, "The word as written"]
    error: Annotated[str | None, "Why the word is unreadable, or null when it is all letters"]


@dataclass
class ParseInput(Output):
    reference: Annotated[str, "The trusted words, separated by spaces"]
    raw: Annotated[str, "The words to check, separated by spaces"]


@dataclass
class ParseOutput(Output):
    reference: Annotated[list[Word], "The reference text's words, in order"]
    raw: Annotated[list[Word], "The raw text's words, in order"]


@dataclass
class ReadInput(Output):
    text: Annotated[str, "Words separated by spaces: the task's reference or raw input, as given"]


@dataclass
class ReadOutput(Output):
    words: Annotated[list[Word], "The text's words, in order"]


@dataclass
class Verdict(Output):
    word: Annotated[str, "The checked word"]
    label: Annotated[
        Label,
        "known: a reference word equals it; changed: one equals it ignoring case; new: none does;"
        " unreadable: it is not all letters",
    ]
    closest: Annotated[str | None, "The reference word it equals, else the first it equals ignoring case, else null"]
    differs: Annotated[list[Case] | None, "Where a changed word's case differs from its closest word; null unless changed"]
    error: Annotated[str | None, "Why an unreadable word is unreadable, else null"]


@dataclass
class CheckOutput(Output):
    verdicts: Annotated[list[Verdict], "One verdict per raw word, in the raw text's order"]


TOOLS = {
    Tool.PARSE_WORDS: (ParseInput, ParseOutput),
    Tool.READ_WORDS: (ReadInput, ReadOutput),
}
TASKS = {Task.CHECK_WORDS: (ParseInput, CheckOutput)}
