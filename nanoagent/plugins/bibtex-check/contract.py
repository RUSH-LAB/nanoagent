"""Each tool's and task's typed input and output (see nanoagent.plugin.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    PARSE_BIBTEX = "parse_bibtex"
    READ_BIBTEX = "read_bibtex"
    SUBMIT_VERDICTS = "submit_verdicts"


class Task(Enum):
    CHECK_BIBTEX = "check-bibtex"


class Label(Enum):
    REAL = "real"
    HALLUCINATED = "hallucinated"


@dataclass
class Record(Output):
    entry_type: str
    title: str
    authors: list[str]
    year: str
    venue: Annotated[str | None, "The journal or booktitle, or null"]
    doi: str | None


@dataclass
class Entry(Output):
    key: Annotated[str, "The citation key"]
    record: Annotated[Record | None, "The entry in the registered schema, or null when it does not parse into it"]
    error: Annotated[str | None, "Why the record is null"]


@dataclass
class ParseInput(Output):
    reference: Annotated[str, "The verified BibTeX file, relative to the workspace"]
    raw: Annotated[str, "The LLM-generated BibTeX file, relative to the workspace"]


@dataclass
class ParseOutput(Output):
    reference: list[Entry]
    raw: list[Entry]


@dataclass
class ReadInput(Output):
    path: Annotated[str, "A BibTeX file, relative to the workspace"]


@dataclass
class ReadOutput(Output):
    path: str
    entries: list[Entry]


@dataclass
class VerdictsInput(Output):
    verdicts: Annotated[dict[str, Label], "Raw entry citation key -> real or hallucinated, one per raw entry"]


@dataclass
class VerdictsOutput(Output):
    path: str
    verdicts: int


TOOLS = {
    Tool.PARSE_BIBTEX: (ParseInput, ParseOutput),
    Tool.READ_BIBTEX: (ReadInput, ReadOutput),
    Tool.SUBMIT_VERDICTS: (VerdictsInput, VerdictsOutput),
}
TASKS = {Task.CHECK_BIBTEX: ParseInput}
