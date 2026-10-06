"""Persistent caller workspaces: the folders plugin runs write into and their owners browse.

The caller names a workspace with an opaque id (Mochi derives one per user per workspace) and
NanoAgent keeps it under one configured root. Every path that reaches a file is resolved and
checked to stay inside its workspace, so neither a request nor a symlink a plugin left behind
can reach anything else on the host.
"""

from __future__ import annotations

import re
from pathlib import Path, PurePosixPath
from typing import Any

WORKSPACE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
# A listing is a browsing aid, not an archive: past this many files it is cut short and says so.
MAX_LISTED = 5000


class Workspaces:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def folder(self, workspace_id: str, *, create: bool = False) -> Path:
        if not WORKSPACE_ID.fullmatch(workspace_id):
            raise ValueError("workspace ids are 1-128 letters, digits, '_' or '-'")
        folder = self.root / workspace_id
        if create:
            folder.mkdir(exist_ok=True)
        return folder

    def files(self, workspace_id: str) -> dict[str, Any]:
        """Every regular file in the workspace, by path relative to it."""
        folder = self.folder(workspace_id)
        if not folder.is_dir():
            return {"files": [], "truncated": False}
        files: list[dict[str, Any]] = []
        for path in sorted(folder.rglob("*")):
            if path.is_symlink() or not path.is_file():
                continue
            if len(files) == MAX_LISTED:
                return {"files": files, "truncated": True}
            stat = path.stat()
            files.append(
                {
                    "path": path.relative_to(folder).as_posix(),
                    "size": stat.st_size,
                    "modified": stat.st_mtime,
                }
            )
        return {"files": files, "truncated": False}

    def file(self, workspace_id: str, relative: str) -> Path:
        """The regular file at ``relative`` inside the workspace; raises if there is none."""
        folder = self.folder(workspace_id).resolve()
        parts = PurePosixPath(relative).parts
        if not parts or PurePosixPath(relative).is_absolute() or ".." in parts:
            raise ValueError("file paths are relative to the workspace and stay inside it")
        path = folder.joinpath(*parts)
        if path.is_symlink() or not path.resolve().is_relative_to(folder) or not path.is_file():
            raise FileNotFoundError(relative)
        return path
