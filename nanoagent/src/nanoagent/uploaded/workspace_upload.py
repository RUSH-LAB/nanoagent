"""A Terminal session's workspace, uploaded to RUSH when the session ends, so its files are not only on the member's computer.

The worker packs the ended session's workspace into one tar.zst (``pack``), leaving out what an agent or a tool rebuilds: the agent
CLIs' homes (``.rush/`` at its root), dependency and bytecode caches (any ``node_modules``, ``.venv`` or ``__pycache__`` folder) and git
objects over GIT_OBJECT_BYTES. An archive over the worker's ``workspace_upload_bytes`` is not uploaded at all, and finalize says why.
Otherwise it goes to RUSH as the attempt's payloads (``upload``), in pieces RUSH takes one at a time, which finalize names in order
(its ``workspace``); RUSH serves them joined as the session's archive (GET /api/traces/workspaces/<attempt id>).
"""

from __future__ import annotations

import hashlib
import os
import stat
import tarfile
from pathlib import Path
from typing import BinaryIO

import zstandard

from nanoagent.uploaded.evidence import MAX_PAYLOAD_BYTES
from nanoagent.uploaded.rush_worker import RushWorkerClient

SKIPPED_FOLDERS = frozenset({"node_modules", ".venv", "__pycache__"})  # left out wherever they are
AGENT_HOMES = ".rush"  # at the workspace's root: the agent CLIs' own state (nanoagent.uploaded.resume)
GIT_OBJECT_BYTES = 1 << 20  # a file under a .git/objects folder larger than this is left out
CONTENT_TYPE = "application/zstd"


class TooLarge(Exception):
    pass


class _Capped:
    """A file that raises [TooLarge] once more than ``max_bytes`` are written to it."""

    def __init__(self, file: BinaryIO, max_bytes: int) -> None:
        self._file, self._max_bytes, self.written = file, max_bytes, 0

    def write(self, data: bytes) -> int:
        self.written += len(data)
        if self.written > self._max_bytes:
            raise TooLarge
        return self._file.write(data)


def _left_out(relative: Path, path: Path) -> bool:
    parts = relative.parts
    if parts[0] == AGENT_HOMES or SKIPPED_FOLDERS.intersection(parts):
        return True
    in_objects = any(parts[i : i + 2] == (".git", "objects") for i in range(len(parts) - 1))
    return in_objects and stat.S_ISREG(path.lstat().st_mode) and path.lstat().st_size > GIT_OBJECT_BYTES


def pack(workspace: Path, archive: Path, max_bytes: int) -> int:
    """Writes ``workspace`` to ``archive`` as a tar.zst: its folders, regular files and links (as links), less what is left out
    (_left_out); sockets and pipes are not files to keep. Raises [TooLarge] once the archive passes ``max_bytes``, leaving no
    ``archive``. Returns its bytes."""
    try:
        with archive.open("wb") as file:
            capped = _Capped(file, max_bytes)
            with zstandard.ZstdCompressor().stream_writer(capped, closefd=False) as zstd, tarfile.open(fileobj=zstd, mode="w|") as tar:
                for root, folders, files in os.walk(workspace):
                    here = Path(root)
                    for name in sorted([*folders, *files]):
                        path = here / name
                        relative = path.relative_to(workspace)
                        if _left_out(relative, path):
                            if name in folders:
                                folders.remove(name)
                            continue
                        mode = path.lstat().st_mode
                        if stat.S_ISDIR(mode) or stat.S_ISREG(mode) or stat.S_ISLNK(mode):
                            tar.add(path, arcname=relative.as_posix(), recursive=False)
                    folders.sort()
        return capped.written
    except BaseException:
        archive.unlink(missing_ok=True)
        raise


async def upload(client: RushWorkerClient, attempt_id: str, fence: int, archive: Path) -> dict:
    """Uploads ``archive`` as the attempt's payloads, in pieces of at most MAX_PAYLOAD_BYTES, and returns what finalize says of it:
    ``{sha256, bytes, chunks}``, the whole archive's digest and size and its pieces' digests in order."""
    whole = hashlib.sha256()
    chunks = []
    with archive.open("rb") as file:
        while data := file.read(MAX_PAYLOAD_BYTES):
            whole.update(data)
            sha = hashlib.sha256(data).hexdigest()
            await client.put_payload(attempt_id, fence, sha, data, "none", CONTENT_TYPE)
            chunks.append(sha)
    return {"sha256": whole.hexdigest(), "bytes": archive.stat().st_size, "chunks": chunks}
