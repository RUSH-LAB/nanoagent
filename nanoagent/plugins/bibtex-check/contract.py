"""Each tool's and task's typed input and output (see nanoagent.plugin.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    PARSE_BIBTEX = "parse_bibtex"
    READ_BIBTEX = "read_bibtex"


class Task(Enum):
    CHECK_BIBTEX = "check-bibtex"


class Label(Enum):
    REAL = "real"
    FIXABLE = "fixable"
    INVENTED = "invented"
    UNREADABLE = "unreadable"


class Field(Enum):
    ENTRY_TYPE = "entry_type"
    TITLE = "title"
    AUTHORS = "authors"
    YEAR = "year"
    VENUE = "venue"
    DOI = "doi"


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
    reference: Annotated[str, "The trusted BibTeX entries, as text: the bibliography the checked entries must match"]
    raw: Annotated[str, "The BibTeX entries to check, as text, e.g. a bibliography an AI model wrote"]


@dataclass
class ParseOutput(Output):
    reference: list[Entry]
    raw: list[Entry]


@dataclass
class ReadInput(Output):
    bibtex: Annotated[str, "BibTeX text: the task's reference or raw input, as given"]


@dataclass
class ReadOutput(Output):
    entries: list[Entry]


@dataclass
class Verdict(Output):
    key: Annotated[str, "The checked entry's citation key"]
    title: Annotated[str | None, "Its title, or null when it is unreadable"]
    label: Annotated[
        Label,
        "real: equals a reference in every field; fixable: close to a reference but differs in some fields;"
        " invented: close to no reference; unreadable: does not parse into the schema",
    ]
    closest: Annotated[str | None, "The closest reference's citation key for a real or fixable entry, else null"]
    differs: Annotated[list[Field], "The fields that differ from the closest reference; empty unless fixable"]
    error: Annotated[str | None, "Why an unreadable entry does not parse, else null"]


@dataclass
class CheckOutput(Output):
    verdicts: Annotated[list[Verdict], "One verdict per checked entry, in the order of the raw BibTeX"]


TOOLS = {
    Tool.PARSE_BIBTEX: (ParseInput, ParseOutput),
    Tool.READ_BIBTEX: (ReadInput, ReadOutput),
}
TASKS = {Task.CHECK_BIBTEX: (ParseInput, CheckOutput)}
