from __future__ import annotations

import gzip
import io
import re
import tarfile
import urllib.request
from pathlib import Path, PurePosixPath
from typing import BinaryIO

ARXIV_ID = re.compile(r"^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?$", re.IGNORECASE)
MAX_DOWNLOAD = 100 * 1024 * 1024
MAX_EXTRACTED = 500 * 1024 * 1024
MAX_FILES = 10_000
HEADERS = {"User-Agent": "nanoagent-arxiv-source/0.1"}


def read_limited(stream: BinaryIO, limit: int = MAX_DOWNLOAD) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while chunk := stream.read(1024 * 1024):
        size += len(chunk)
        if size > limit:
            raise ValueError("arXiv response exceeds the download limit")
        chunks.append(chunk)
    return b"".join(chunks)


def resolve_destination(workspace: Path, destination: str) -> Path:
    """The folder ``destination`` names inside ``workspace``; it may not leave the workspace."""
    relative = Path(destination)
    root = workspace.resolve()
    folder = (root / relative).resolve()
    if relative.is_absolute() or ".." in relative.parts or not folder.is_relative_to(root) or folder == root:
        raise ValueError("destination must stay inside the plugin workspace")
    return folder


def _safe_name(name: str) -> Path:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"unsafe archive path: {name}")
    return Path(*path.parts)


def _extract_tar(data: bytes, destination: Path) -> list[str]:
    files: list[str] = []
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
        members = archive.getmembers()
        if len(members) > MAX_FILES:
            raise ValueError("arXiv source archive contains too many files")
        for member in members:
            relative = _safe_name(member.name)
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise ValueError(f"unsupported archive entry: {member.name}")
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            total += member.size
            if total > MAX_EXTRACTED:
                raise ValueError("arXiv source archive exceeds the extraction limit")
            source = archive.extractfile(member)
            if source is None:
                raise ValueError(f"could not read archive entry: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read())
            files.append(relative.as_posix())
    return sorted(files)


def unpack_source(data: bytes, destination: Path) -> list[str]:
    try:
        return _extract_tar(data, destination)
    except tarfile.ReadError:
        try:
            content = gzip.decompress(data)
        except gzip.BadGzipFile:
            content = data
        if len(content) > MAX_EXTRACTED:
            raise ValueError("arXiv source file exceeds the extraction limit")
        (destination / "main.tex").write_bytes(content)
        return ["main.tex"]


def download_source(
    arxiv_id: str,
    destination: str,
    *,
    workspace: Path,
    opener=urllib.request.urlopen,
) -> dict:
    paper = str(arxiv_id).strip()
    if not ARXIV_ID.fullmatch(paper):
        raise ValueError("invalid arXiv id")
    folder = resolve_destination(workspace, destination)
    folder.mkdir(parents=True, exist_ok=False)
    url = f"https://export.arxiv.org/e-print/{paper}"
    try:
        with opener(urllib.request.Request(url, headers=HEADERS)) as response:
            data = read_limited(response)
        files = unpack_source(data, folder)
    except Exception:
        if folder.exists() and not any(folder.iterdir()):
            folder.rmdir()
        raise
    return {"ok": True, "arxiv_id": paper, "source_url": url, "folder": str(folder), "files": files}
