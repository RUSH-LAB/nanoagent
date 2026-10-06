from __future__ import annotations

from pathlib import Path


def resolve_destination(workspace: Path, destination: str) -> Path:
    """The path ``destination`` names inside ``workspace``; it may not leave the workspace."""
    relative = Path(destination)
    root = workspace.resolve()
    path = (root / relative).resolve()
    if relative.is_absolute() or ".." in relative.parts or not path.is_relative_to(root) or path == root:
        raise ValueError("destination must stay inside the plugin workspace")
    return path


def write_note(text: str, destination: str, *, workspace: Path) -> dict:
    path = resolve_destination(workspace, destination)
    if path.exists():
        raise FileExistsError(f"destination already exists: {destination}")
    path.parent.mkdir(parents=True, exist_ok=True)
    data = text.encode("utf-8")
    path.write_bytes(data)
    return {"ok": True, "path": str(path), "bytes": len(data)}
