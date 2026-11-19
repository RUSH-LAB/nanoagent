"""A Terminal session's workspace, packed and uploaded to RUSH when it ends (nanoagent.uploaded.workspace_upload)."""

from __future__ import annotations

import asyncio
import hashlib
import io
import os
import tarfile
from pathlib import Path

import pytest
import zstandard

from nanoagent.uploaded import workspace_upload
from nanoagent.uploaded.workspace_upload import GIT_OBJECT_BYTES, TooLarge, pack, upload


def workspace(root: Path, files: dict[str, bytes]) -> Path:
    for name, data in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(data)
    return root


def members(archive: Path) -> dict[str, tarfile.TarInfo]:
    data = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(archive.read_bytes())).read()
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        return {member.name: member for member in tar.getmembers()}


def test_it_packs_the_members_files_and_leaves_out_agent_homes_and_caches(tmp_path: Path) -> None:
    made = workspace(tmp_path / "w", {
        "answer.json": b"{}", "app/main.py": b"print(1)", "app/__pycache__/main.pyc": b"x", "web/node_modules/a/index.js": b"x",
        ".venv/bin/python": b"x", ".rush/claude/state.json": b"x", "app/.rush/kept.txt": b"kept, not at the root",
        ".git/HEAD": b"ref", ".git/objects/ab/small": b"s", ".git/objects/cd/big": b"b" * (GIT_OBJECT_BYTES + 1),
    })  # fmt: skip
    os.symlink("app/main.py", made / "link")
    os.mkfifo(made / "pipe")
    archive = tmp_path / "w.tar.zst"
    size = pack(made, archive, 1 << 20)
    assert size == archive.stat().st_size
    found = members(archive)
    assert set(found) == {"answer.json", "app", "app/main.py", "app/.rush", "app/.rush/kept.txt", "web", "link", ".git", ".git/HEAD", ".git/objects", ".git/objects/ab", ".git/objects/ab/small", ".git/objects/cd"}  # fmt: skip
    assert found["link"].issym() and found["link"].linkname == "app/main.py"


def test_an_archive_over_the_cap_is_not_written(tmp_path: Path) -> None:
    made = workspace(tmp_path / "w", {"noise.bin": os.urandom(256 << 10)})
    archive = tmp_path / "w.tar.zst"
    with pytest.raises(TooLarge):
        pack(made, archive, 64 << 10)
    assert not archive.exists()


class Rush:
    def __init__(self) -> None:
        self.payloads: list[tuple[str, bytes, str, str]] = []

    async def put_payload(self, attempt_id: str, fence: int, sha256: str, data: bytes, redaction: str, content_type: str) -> None:
        assert (attempt_id, fence) == ("a1", 3) and hashlib.sha256(data).hexdigest() == sha256
        self.payloads.append((sha256, data, redaction, content_type))


def test_it_uploads_the_archive_in_pieces_finalize_names_in_order(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workspace_upload, "MAX_PAYLOAD_BYTES", 4)
    archive = tmp_path / "w.tar.zst"
    archive.write_bytes(b"0123456789")
    rush = Rush()
    said = asyncio.run(upload(rush, "a1", 3, archive))  # type: ignore[arg-type]
    assert [data for _, data, _, _ in rush.payloads] == [b"0123", b"4567", b"89"]
    assert {(redaction, kind) for _, _, redaction, kind in rush.payloads} == {("none", "application/zstd")}
    assert said == {"sha256": hashlib.sha256(b"0123456789").hexdigest(), "bytes": 10, "chunks": [sha for sha, _, _, _ in rush.payloads]}
