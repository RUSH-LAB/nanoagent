from __future__ import annotations

from pathlib import Path

from slimconfig import build_output, plain_output

import verifier
from contract import NoteInput, NoteOutput
from plugin.note import write_note

NOTE = {"text": "hello", "destination": "notes/first.txt"}


# The verifier gets contract instances, as NanoAgent's sandbox builds them from JSON.
def test_approves_a_written_note(tmp_path: Path) -> None:
    given = build_output(NOTE, NoteInput)
    made = build_output(plain_output(write_note(given, tmp_path)), NoteOutput)
    assert verifier.verify_input("write_note", given)["valid"] is True
    assert verifier.verify_output("write_note", given, made, str(tmp_path))["valid"] is True
    assert verifier.verify_task("write-note", given, made, None, str(tmp_path))["valid"] is True


def test_refuses_a_destination_outside_the_workspace() -> None:
    verdict = verifier.verify_input("write_note", build_output({**NOTE, "destination": "../outside.txt"}, NoteInput))
    assert verdict["valid"] is False and "workspace" in verdict["message"]


def test_refuses_a_missing_or_changed_note(tmp_path: Path) -> None:
    given = build_output(NOTE, NoteInput)
    made = build_output({"path": str(tmp_path / "notes" / "first.txt"), "bytes": 7}, NoteOutput)
    assert verifier.verify_task("write-note", given, made, None, str(tmp_path))["valid"] is False
    (tmp_path / "notes").mkdir()
    (tmp_path / "notes" / "first.txt").write_text("changed")
    assert verifier.verify_output("write_note", given, made, str(tmp_path))["valid"] is False
    assert verifier.verify_task("write-note", given, made, None, str(tmp_path))["valid"] is False
