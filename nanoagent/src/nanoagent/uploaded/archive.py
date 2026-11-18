"""Link-safe, bounded copying of a directory a sandbox wrote into.

A case's workspace and output are host directories its microVM mounts, so their contents are untrusted: nothing is
followed, links and special files are never copied (they are reported), and file count and byte totals are bounded
while copying.
"""

from __future__ import annotations

import ctypes
import errno
import hashlib
import os
import stat
import struct
from dataclasses import dataclass
from pathlib import Path

from nanoagent.uploaded.contract import ContractError


class ArchiveError(ContractError):
    """A tree that breaks a bound (`snapshot_too_large`) or a path rule (`unsafe_path`)."""


# Where microsandbox keeps the stat a guest gave a file it wrote through a bind mount when the host cannot (macOS): version 1,
# then uid, gid, mode and rdev, each a little-endian u32. The host file's own mode is not the guest's.
GUEST_STAT = "user.msb.override_stat"
_NO_ATTRIBUTE = (getattr(errno, "ENOATTR", errno.ENODATA), errno.ENODATA, errno.ENOTSUP)


def _guest_stat(fd: int) -> bytes | None:
    """The GUEST_STAT attribute of the open file ``fd``, or None when the file has none."""
    if hasattr(os, "getxattr"):
        try:
            return os.getxattr(fd, GUEST_STAT)
        except OSError as error:
            if error.errno in _NO_ATTRIBUTE:
                return None
            raise
    buffer = ctypes.create_string_buffer(64)
    size = ctypes.CDLL(None, use_errno=True).fgetxattr(fd, GUEST_STAT.encode(), buffer, len(buffer), 0, 0)
    if size < 0:
        code = ctypes.get_errno()
        if code in _NO_ATTRIBUTE:
            return None
        raise OSError(code, os.strerror(code))
    return buffer.raw[:size]


def file_mode(fd: int) -> int:
    """The mode of the open file ``fd`` as the sandbox that wrote it sees it: microsandbox's GUEST_STAT where it keeps one."""
    kept = _guest_stat(fd)
    if kept is None:
        return os.fstat(fd).st_mode
    version, _uid, _gid, mode = struct.unpack_from("<4I", kept)
    if version != 1:
        raise ArchiveError("unsafe_path", f"{GUEST_STAT} is version {version}, not 1")
    return mode


@dataclass(frozen=True)
class Extracted:
    files: dict[str, str]  # relative path to sha256, regular files only
    directories: tuple[str, ...]
    skipped: dict[str, str]  # relative path to the kind that was not copied (symlink, special, invalid_name)
    total_bytes: int


def copy_tree(source: Path, destination: Path, *, max_files: int, max_bytes: int) -> Extracted:
    """Copies the regular files and directories beneath ``source`` into ``destination`` (created if needed), never
    following a link: each directory is opened relative to its parent's descriptor with O_NOFOLLOW."""
    destination.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}
    directories: list[str] = []
    skipped: dict[str, str] = {}
    total = 0

    def walk(fd: int, relative: str) -> None:
        nonlocal total
        for name in sorted(os.listdir(fd)):
            path = f"{relative}/{name}" if relative else name
            try:
                path.encode("utf-8")
            except UnicodeEncodeError:  # a name written in another encoding cannot be copied on every host or journaled
                skipped[path.encode("utf-8", "surrogateescape").decode("utf-8", "backslashreplace")] = "invalid_name"
                continue
            mode = os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode
            if stat.S_ISDIR(mode):
                (destination / path).mkdir(exist_ok=True)
                os.chmod(destination / path, 0o755)
                directories.append(path)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    walk(child, path)
                finally:
                    os.close(child)
            elif stat.S_ISREG(mode):
                if len(files) >= max_files:
                    raise ArchiveError("snapshot_too_large", f"more than {max_files} files")
                handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                digest = hashlib.sha256()
                try:
                    mode = file_mode(handle)
                    with os.fdopen(handle, "rb", closefd=False) as reader, open(destination / path, "wb") as out:
                        while chunk := reader.read(1 << 16):
                            total += len(chunk)
                            if total > max_bytes:
                                raise ArchiveError("snapshot_too_large", f"more than {max_bytes} bytes")
                            digest.update(chunk)
                            out.write(chunk)
                finally:
                    os.close(handle)
                os.chmod(destination / path, 0o755 if mode & stat.S_IXUSR else 0o644)
                files[path] = digest.hexdigest()
            else:
                skipped[path] = "symlink" if stat.S_ISLNK(mode) else "special"

    root = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        walk(root, "")
    finally:
        os.close(root)
    return Extracted(files, tuple(directories), skipped, total)
