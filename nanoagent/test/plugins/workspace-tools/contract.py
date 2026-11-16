"""Each tool's and task's typed input and output (see nanoagent.plugin.v0001.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    WRITE_NOTE = "write_note"
    READ_FIXTURE = "read_fixture"
    COPY_FIXTURE = "copy_fixture"
    INSPECT_SANDBOX = "inspect_sandbox"
    EXPECTED_NOTE = "expected_note"


class Task(Enum):
    NOTE = "note"


@dataclass
class WriteNoteInput(Output):
    name: Annotated[str, "The file to write, relative to the workspace"]
    text: Annotated[str, "What to write"]


@dataclass
class WriteNoteOutput(Output):
    path: Annotated[str, "The file written, relative to the workspace"]
    bytes: Annotated[int, "How many bytes were written"]


@dataclass
class ReadFixtureInput(Output):
    name: Annotated[str, "The fixture file to read"]


@dataclass
class ReadFixtureOutput(Output):
    text: Annotated[str, "The fixture's text"]


@dataclass
class CopyFixtureInput(Output):
    fixture: Annotated[str, "The fixture file to copy, relative to the fixtures folder"]
    name: Annotated[str, "The workspace file to write, relative to the workspace"]


@dataclass
class CopyFixtureOutput(Output):
    path: Annotated[str, "The file written, relative to the workspace"]
    bytes: Annotated[int, "How many bytes were written"]


@dataclass
class InspectSandboxInput(Output):
    pass


@dataclass
class InspectSandboxOutput(Output):
    readable: Annotated[list[str], "The attempt's private files this tool could read"]
    rush_env: Annotated[list[str], "The RUSH_* environment variables this tool could see"]
    fixtures: Annotated[list[str], "The fixture files this tool could see, relative to the fixtures folder"]
    fixtures_writable: Annotated[bool, "Whether this tool could write into the fixtures folder"]


@dataclass
class ExpectedNoteOutput(Output):
    path: Annotated[str, "The file the note task must write, relative to the workspace"]
    bytes: Annotated[int, "How many bytes the note holds"]


TOOLS = {
    Tool.WRITE_NOTE: (WriteNoteInput, WriteNoteOutput),
    Tool.READ_FIXTURE: (ReadFixtureInput, ReadFixtureOutput),
    Tool.COPY_FIXTURE: (CopyFixtureInput, CopyFixtureOutput),
    Tool.INSPECT_SANDBOX: (InspectSandboxInput, InspectSandboxOutput),
    Tool.EXPECTED_NOTE: (WriteNoteInput, ExpectedNoteOutput),
}
TASKS = {Task.NOTE: (WriteNoteInput, WriteNoteOutput)}
