"""Scratch workspaces: the folder one plugin run reads and writes, removed by the caller after it.

The caller names a workspace with an opaque id (RUSH Lab's relay is given a new one for every
run, fills it before the run from the member's files, reads it back after, then removes it:
helpinghands/src/runner/run-files.mjs) and NanoAgent keeps it under one configured
root, so NanoAgent holds no file that matters between runs. Every path that reaches a file or
folder is checked to stay inside its workspace and to cross no symlink, so neither a request nor a
symlink a plugin left behind can reach anything else on the host.

Failures are exceptions the web layer turns into statuses: ``ValueError`` for a malformed request,
``FileNotFoundError`` for nothing there, ``FileExistsError`` for something already there.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path, PurePosixPath
from typing import Any

WORKSPACE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
# A listing is a browsing aid, not an archive: past this many entries it is cut short and says so.
MAX_LISTED = 5000


def _entry(folder: Path, path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": path.relative_to(folder).as_posix(),
        "size": stat.st_size,
        "modified": stat.st_mtime,
    }


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

    def _path(self, workspace_id: str, relative: str, *, create: bool = False) -> tuple[Path, Path]:
        """The workspace and the path ``relative`` names inside it, which may not exist yet."""
        folder = self.folder(workspace_id, create=create).resolve()
        pure = PurePosixPath(relative)
        if pure.is_absolute() or not pure.parts or any(part in {".", ".."} for part in pure.parts):
            raise ValueError("paths are relative to the workspace and stay inside it")
        current = folder
        for part in pure.parts:
            current = current / part
            if current.is_symlink():
                raise FileNotFoundError(relative)
        return folder, folder.joinpath(*pure.parts)

    def files(self, workspace_id: str) -> dict[str, Any]:
        """Every regular file and folder in the workspace, by path relative to it."""
        folder = self.folder(workspace_id)
        if not folder.is_dir():
            return {"files": [], "folders": [], "truncated": False}
        files: list[dict[str, Any]] = []
        folders: list[str] = []
        for parent, directories, names in os.walk(folder):
            here = Path(parent)
            # Symlinked folders are neither listed nor entered.
            directories[:] = sorted(name for name in directories if not (here / name).is_symlink())
            folders += [(here / name).relative_to(folder).as_posix() for name in directories]
            for name in sorted(names):
                path = here / name
                if path.is_symlink() or not path.is_file():
                    continue
                if len(files) + len(folders) >= MAX_LISTED:
                    return {"files": files, "folders": sorted(folders), "truncated": True}
                files.append(_entry(folder, path))
        return {"files": sorted(files, key=lambda item: item["path"]), "folders": sorted(folders), "truncated": False}

    def file(self, workspace_id: str, relative: str) -> Path:
        """The regular file at ``relative`` inside the workspace."""
        _, path = self._path(workspace_id, relative)
        if not path.is_file():
            raise FileNotFoundError(relative)
        return path

    def write(self, workspace_id: str, relative: str, data: bytes, *, create: bool) -> dict[str, Any]:
        """Save ``data`` at ``relative``, making its folders; ``create`` refuses to replace a file."""
        folder, path = self._path(workspace_id, relative, create=True)
        if path.is_dir():
            raise ValueError(f"{relative} is a folder")
        if create and path.exists():
            raise FileExistsError(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return _entry(folder, path)

    # COMPAT(mochi-workspace-edits): what RUSH on production asks of a workspace besides saving
    # files. Remove with the routes in nanoagent.web.app.
    def delete_file(self, workspace_id: str, relative: str) -> dict[str, Any]:
        self.file(workspace_id, relative).unlink()
        return {"deleted": True}

    def make_folder(self, workspace_id: str, relative: str) -> dict[str, Any]:
        _, path = self._path(workspace_id, relative, create=True)
        if path.exists():
            raise FileExistsError(relative)
        path.mkdir(parents=True)
        return {"created": True}

    def delete_folder(self, workspace_id: str, relative: str) -> dict[str, Any]:
        """Remove the folder at ``relative`` and everything in it."""
        _, path = self._path(workspace_id, relative)
        if not path.is_dir():
            raise FileNotFoundError(relative)
        shutil.rmtree(path)
        return {"deleted": True}

    def move(self, workspace_id: str, source: str, target: str) -> dict[str, Any]:
        """Rename or move a file or folder; nothing may already be at ``target``."""
        _, origin = self._path(workspace_id, source)
        _, destination = self._path(workspace_id, target)
        if not origin.exists():
            raise FileNotFoundError(source)
        if destination.exists():
            raise FileExistsError(target)
        if origin.is_dir() and destination.is_relative_to(origin):
            raise ValueError("a folder cannot move inside itself")
        destination.parent.mkdir(parents=True, exist_ok=True)
        origin.rename(destination)
        return {"moved": True}

    def remove(self, workspace_id: str) -> dict[str, Any]:
        """Remove the workspace and everything in it; one that was never made has nothing to remove."""
        folder = self.folder(workspace_id)
        if folder.is_symlink():
            raise FileNotFoundError(workspace_id)
        if not folder.exists():
            return {"deleted": False}
        shutil.rmtree(folder)
        return {"deleted": True}
