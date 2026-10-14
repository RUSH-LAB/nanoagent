"""Each tool's and task's typed input and output (see nanoagent.plugin.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    WRITE_NOTE = "write_note"


class Task(Enum):
    WRITE_NOTE = "write-note"


@dataclass
class NoteInput(Output):
    text: Annotated[str, "The note's text"]
    destination: Annotated[str, "A new file path relative to the plugin workspace"]


@dataclass
class NoteOutput(Output):
    path: Annotated[str, "The note's file, relative to the plugin workspace"]
    bytes: Annotated[int, "The note's size in bytes"]


TOOLS = {Tool.WRITE_NOTE: (NoteInput, NoteOutput)}
TASKS = {Task.WRITE_NOTE: (NoteInput, NoteOutput)}
