from __future__ import annotations

from pathlib import Path

from slimconfig import build_output

import verifier
from contract import CopyFixtureInput, ExpectedNoteOutput, WriteNoteInput, WriteNoteOutput
from plugin.notes import copy_fixture, write_note


def test_the_written_note_is_the_one_verified(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("NANOAGENT_WORKSPACE", str(tmp_path))
    given = WriteNoteInput(name="n.txt", text="hello")
    made = write_note(given)
    assert verifier.verify_output("write_note", given, made, str(tmp_path))["valid"] is True
    (tmp_path / "n.txt").write_text("other")
    assert verifier.verify_output("write_note", given, made, str(tmp_path))["valid"] is False


def test_a_name_outside_the_workspace_is_invalid() -> None:
    bad = build_output({"name": "../x", "text": "t"}, WriteNoteInput)
    assert verifier.verify_input("write_note", bad)["valid"] is False
    assert isinstance(build_output({"path": "x", "bytes": 1}, WriteNoteOutput), WriteNoteOutput)


def test_a_benchmark_note_must_match_the_case_text_and_the_reference(tmp_path: Path) -> None:
    given = build_output({"name": "n.txt", "text": "hello"}, WriteNoteInput)
    (tmp_path / "n.txt").write_text("hello")
    made = build_output({"path": "n.txt", "bytes": 5}, WriteNoteOutput)
    reference = build_output({"path": "n.txt", "bytes": 5}, ExpectedNoteOutput)
    assert verifier.verify_task("note", given, made, reference, str(tmp_path))["valid"] is True
    (tmp_path / "n.txt").write_text("other")
    assert verifier.verify_task("note", given, made, reference, str(tmp_path))["valid"] is False
    (tmp_path / "n.txt").write_text("hello")
    assert verifier.verify_task("note", given, build_output({"path": "../n.txt", "bytes": 5}, WriteNoteOutput), reference, str(tmp_path))["valid"] is False


def test_a_copied_fixture_is_verified_in_the_workspace(tmp_path: Path, monkeypatch) -> None:
    fixtures = tmp_path / "fx"
    fixtures.mkdir()
    (fixtures / "a.txt").write_text("fixture")
    workspace = tmp_path / "ws"
    workspace.mkdir()
    monkeypatch.setenv("NANOAGENT_FIXTURES", str(fixtures))
    monkeypatch.setenv("NANOAGENT_WORKSPACE", str(workspace))
    given = build_output({"fixture": "a.txt", "name": "copy.txt"}, CopyFixtureInput)
    made = copy_fixture(given)
    assert (made.path, made.bytes) == ("copy.txt", 7)
    assert verifier.verify_output("copy_fixture", given, made, str(workspace))["valid"] is True
