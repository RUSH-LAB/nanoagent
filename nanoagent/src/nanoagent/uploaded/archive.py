"""Link-safe, bounded reading of the tar streams `docker cp` produces from a sandbox.

The sandbox is untrusted, so nothing in a stream is trusted: paths are validated, links and special
files are never created (they are reported), and file count and byte totals are bounded while reading.
"""

from __future__ import annotations

import hashlib
import io
import os
import stat
import tarfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from nanoagent.uploaded.contract import ContractError


class ArchiveError(ContractError):
    """A stream that breaks a bound (`snapshot_too_large`) or a path rule (`unsafe_path`)."""


@dataclass(frozen=True)
class Extracted:
    files: dict[str, str]  # relative path to sha256, regular files only
    directories: tuple[str, ...]
    skipped: dict[str, str]  # relative path to the kind that was not extracted (symlink, hardlink, device, ...)
    total_bytes: int


def extract_tar(data: bytes, destination: Path, *, root_name: str, max_files: int, max_bytes: int) -> Extracted:
    """Extracts the tree `root_name` of a `docker cp` stream beneath `destination` (created if needed)."""
    destination.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}
    directories: list[str] = []
    skipped: dict[str, str] = {}
    total = 0
    try:
        archive = tarfile.open(fileobj=io.BytesIO(data), mode="r:")
    except tarfile.TarError as error:
        raise ArchiveError("unsafe_path", f"unreadable archive: {error}") from error
    with archive:
        for member in archive:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != root_name or ".." in parts or member.name.startswith("/"):
                raise ArchiveError("unsafe_path", f"archive entry {member.name!r} is outside {root_name!r}")
            relative = "/".join(parts[1:])
            if not relative:
                continue
            if member.isdir():
                (destination / relative).mkdir(parents=True, exist_ok=True)
                os.chmod(destination / relative, 0o755)
                directories.append(relative)
            elif member.isreg():
                if len(files) >= max_files:
                    raise ArchiveError("snapshot_too_large", f"more than {max_files} files")
                total += member.size
                if total > max_bytes:
                    raise ArchiveError("snapshot_too_large", f"more than {max_bytes} bytes")
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                source = archive.extractfile(member)
                assert source is not None
                with open(target, "wb") as out:
                    while chunk := source.read(1 << 16):
                        digest.update(chunk)
                        out.write(chunk)
                os.chmod(target, 0o755 if member.mode & stat.S_IXUSR else 0o644)
                files[relative] = digest.hexdigest()
            else:
                skipped[relative] = (
                    "symlink" if member.issym() else "hardlink" if member.islnk() else "special"
                )
    return Extracted(files, tuple(directories), skipped, total)


def first_entry_is_link(data: bytes) -> bool:
    """True when the first tar header is a symlink (`docker cp` of a link path returns the link itself)."""
    return len(data) >= 512 and data[156:157] == b"2"


def tar_of_tree(root: Path) -> bytes:
    """A tar of a host directory's contents, for `docker cp - container:/dir` (merged into the existing dir).

    `docker cp` creates the files as root, so modes are widened for the unprivileged case user to modify
    them. Links and special files are refused.
    """
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for path in sorted(root.rglob("*")):
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                raise ArchiveError("unsafe_path", f"{relative} is a link")
            entry = tarfile.TarInfo(relative)
            if path.is_dir():
                entry.type = tarfile.DIRTYPE
                entry.mode = 0o777
                archive.addfile(entry)
            elif path.is_file():
                entry.size = path.stat().st_size
                entry.mode = 0o777 if path.stat().st_mode & stat.S_IXUSR else 0o666
                with open(path, "rb") as handle:
                    archive.addfile(entry, handle)
            else:
                raise ArchiveError("unsafe_path", f"{relative} is not a regular file or directory")
    return buffer.getvalue()
