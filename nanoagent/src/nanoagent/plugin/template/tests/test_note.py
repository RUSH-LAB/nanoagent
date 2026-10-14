from __future__ import annotations

from pathlib import Path

import pytest

from contract import NoteInput, NoteOutput
from plugin.note import write_note


def test_writes_the_note_inside_the_workspace(tmp_path: Path) -> None:
    output = write_note(NoteInput(text="hello", destination="notes/first.txt"), tmp_path)
    assert output == NoteOutput(path="notes/first.txt", bytes=5)
    assert (tmp_path / "notes" / "first.txt").read_text() == "hello"


def test_refuses_to_leave_the_workspace_or_overwrite(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="workspace"):
        write_note(NoteInput(text="x", destination="../outside.txt"), tmp_path)
    (tmp_path / "taken.txt").write_text("")
    with pytest.raises(FileExistsError):
        write_note(NoteInput(text="x", destination="taken.txt"), tmp_path)
