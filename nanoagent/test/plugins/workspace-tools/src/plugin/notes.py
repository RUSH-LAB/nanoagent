from __future__ import annotations

import os
from pathlib import Path

from contract import (
    CopyFixtureInput,
    CopyFixtureOutput,
    ExpectedNoteOutput,
    InspectSandboxInput,
    InspectSandboxOutput,
    ReadFixtureInput,
    ReadFixtureOutput,
    WriteNoteInput,
    WriteNoteOutput,
)

# What a brokered tool must not see: the attempt's request, its result folder and its credentials.
PRIVATE_PATHS = ("/rush/request.json", "/rush/out/result.json", "/rush/out", "/harness")


def write_note(given: WriteNoteInput) -> WriteNoteOutput:
    data = given.text.encode()
    (Path(os.environ["NANOAGENT_WORKSPACE"]) / given.name).write_bytes(data)
    return WriteNoteOutput(path=given.name, bytes=len(data))


def read_fixture(given: ReadFixtureInput) -> ReadFixtureOutput:
    return ReadFixtureOutput(text=(Path(os.environ["NANOAGENT_FIXTURES"]) / given.name).read_text())


def copy_fixture(given: CopyFixtureInput) -> CopyFixtureOutput:
    data = (Path(os.environ["NANOAGENT_FIXTURES"]) / given.fixture).read_bytes()
    (Path(os.environ["NANOAGENT_WORKSPACE"]) / given.name).write_bytes(data)
    return CopyFixtureOutput(path=given.name, bytes=len(data))


def readable(path: str) -> bool:
    target = Path(path)
    try:
        if target.is_dir():
            next(target.iterdir(), None)
        else:
            target.read_bytes()
    except OSError:
        return False
    return True


def rush_variables() -> set[str]:
    """The RUSH_* variable names in this process's environment and in any visible process's."""
    names = {key for key in os.environ if key.startswith("RUSH_")}
    for path in Path("/proc").glob("[0-9]*/environ"):
        try:
            names |= {entry.split(b"=", 1)[0].decode() for entry in path.read_bytes().split(b"\0") if entry.startswith(b"RUSH_")}
        except OSError:
            continue
    return names


def inspect_sandbox(given: InspectSandboxInput) -> InspectSandboxOutput:
    fixtures = Path(os.environ.get("NANOAGENT_FIXTURES", "/fixtures"))
    try:
        (fixtures / ".write-probe").write_text("x")
        writable = True
    except OSError:
        writable = False
    names = sorted(str(path.relative_to(fixtures)) for path in fixtures.rglob("*") if path.is_file()) if fixtures.is_dir() else []
    return InspectSandboxOutput(
        readable=[path for path in PRIVATE_PATHS if readable(path)],
        rush_env=sorted(rush_variables()),
        fixtures=names,
        fixtures_writable=writable,
    )


def expected_note(given: WriteNoteInput) -> ExpectedNoteOutput:
    return ExpectedNoteOutput(path=given.name, bytes=len(given.text.encode()))
