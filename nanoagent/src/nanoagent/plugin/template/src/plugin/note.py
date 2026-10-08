from __future__ import annotations

from pathlib import Path

from contract import NoteInput, NoteOutput


def resolve_destination(workspace: Path, destination: str) -> Path:
    """The path ``destination`` names inside ``workspace``; it may not leave the workspace."""
    relative = Path(destination)
    root = workspace.resolve()
    path = (root / relative).resolve()
    if relative.is_absolute() or ".." in relative.parts or not path.is_relative_to(root) or path == root:
        raise ValueError("destination must stay inside the plugin workspace")
    return path


def write_note(note: NoteInput, workspace: Path) -> NoteOutput:
    path = resolve_destination(workspace, note.destination)
    if path.exists():
        raise FileExistsError(f"destination already exists: {note.destination}")
    path.parent.mkdir(parents=True, exist_ok=True)
    data = note.text.encode("utf-8")
    path.write_bytes(data)
    return NoteOutput(path=str(path), bytes=len(data))
