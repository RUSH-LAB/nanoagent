"""Source ZIP validation before extraction and a link-safe, limit-enforcing extraction."""

from __future__ import annotations

import hashlib
import io
import os
import re
import stat
import unicodedata
import zipfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from nanoagent.uploaded.contract import ContractError, HarnessManifest, parse_manifest, path_problem

MANIFEST_NAME = "harness.yaml"
CHUNK = 1 << 16

_PREBUILT_SUFFIXES = frozenset(
    {".so", ".dylib", ".dll", ".exe", ".a", ".o", ".obj", ".lib", ".pyc", ".pyo", ".pyd", ".class", ".jar", ".war", ".ear", ".wasm", ".node"}
)
_VERSIONED_SO = re.compile(r"\.so(\.\d+)+$")
_MAGIC_PREFIXES = (
    b"\x7fELF",
    b"\xfe\xed\xfa\xce",
    b"\xfe\xed\xfa\xcf",
    b"\xce\xfa\xed\xfe",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",  # Mach-O fat and Java class share this magic
    b"\xca\xfe\xba\xbf",
    b"MZ",
    b"\x00asm",
)


class SourceError(ContractError):
    """A rejected source archive; `code` names the rule that was broken."""


@dataclass(frozen=True)
class SourceLimits:
    max_entries: int = 10_000
    max_file_bytes: int = 50 << 20
    max_total_bytes: int = 200 << 20
    max_compression_ratio: float = 100.0


@dataclass(frozen=True)
class SourceEntry:
    path: str
    member: str
    size: int
    is_directory: bool


@dataclass(frozen=True)
class SourceArchive:
    source_sha256: str
    manifest: HarnessManifest
    entries: tuple[SourceEntry, ...]
    limits: SourceLimits
    data: bytes = field(repr=False)


def _fold(path: str) -> str:
    return unicodedata.normalize("NFC", unicodedata.normalize("NFC", path).casefold())


def _is_prebuilt_name(path: str) -> bool:
    name = PurePosixPath(path).name.lower()
    return PurePosixPath(name).suffix in _PREBUILT_SUFFIXES or _VERSIONED_SO.search(name) is not None


def _is_prebuilt_magic(head: bytes) -> bool:
    if head.startswith(_MAGIC_PREFIXES):
        return True
    # A .pyc starts with a 2-byte little-endian magic number then CRLF; CPython 3.x numbers are
    # 3000-3999 and 2.x ones 62000-62999, whose bytes never begin ordinary text.
    if len(head) >= 4 and head[2:4] == b"\r\n":
        number = int.from_bytes(head[:2], "little")
        return 3000 <= number < 4000 or 62000 <= number < 63000
    return False


def _reject_special(info: zipfile.ZipInfo, path: str) -> None:
    kind = stat.S_IFMT(info.external_attr >> 16)
    if kind == stat.S_IFLNK:
        raise SourceError("link", f"{path} is a symbolic link")
    if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise SourceError("special_file", f"{path} is a special file")


def _entry_path(info: zipfile.ZipInfo) -> tuple[str, bool]:
    is_directory = info.filename.endswith("/")
    path = info.filename.removesuffix("/")
    problem = path_problem(path)
    if problem is not None:
        raise SourceError(problem, f"{info.filename!r} is not a canonical relative path")
    return path, is_directory


def _check_names(infos: list[zipfile.ZipInfo]) -> list[SourceEntry]:
    entries: list[SourceEntry] = []
    seen: dict[str, str] = {}
    files: set[str] = set()
    directories: set[str] = set()
    for info in infos:
        path, is_directory = _entry_path(info)
        key = _fold(path)
        if key in seen:
            code = "duplicate_path" if seen[key] == path else "colliding_path"
            raise SourceError(code, f"{path!r} collides with {seen[key]!r}")
        seen[key] = path
        parents = [_fold(str(parent)) for parent in PurePosixPath(path).parents if str(parent) != "."]
        directories.update(parents)
        (directories if is_directory else files).add(key)
        entries.append(SourceEntry(path, info.filename, info.file_size, is_directory))
    clash = files & directories
    if clash:
        raise SourceError("path_conflict", f"{seen[min(clash)]!r} is both a file and a directory")
    return entries


def _check_sizes(infos: list[zipfile.ZipInfo], archive_bytes: int, limits: SourceLimits) -> None:
    if len(infos) > limits.max_entries:
        raise SourceError("too_large", f"{len(infos)} entries exceed the limit of {limits.max_entries}")
    total = 0
    for info in infos:
        if info.file_size > limits.max_file_bytes:
            raise SourceError("too_large", f"{info.filename!r} is {info.file_size} bytes, over the {limits.max_file_bytes} byte limit")
        total += info.file_size
    if total > limits.max_total_bytes:
        raise SourceError("too_large", f"{total} uncompressed bytes exceed the limit of {limits.max_total_bytes}")
    if total > limits.max_compression_ratio * archive_bytes:
        raise SourceError("compression_ratio", f"{total} bytes from {archive_bytes} exceeds the ratio {limits.max_compression_ratio}")


def _read(archive: zipfile.ZipFile, info: zipfile.ZipInfo, size: int) -> bytes:
    try:
        with archive.open(info) as member:
            return member.read(size)
    except (zipfile.BadZipFile, zlib.error, NotImplementedError, EOFError) as error:
        raise SourceError("invalid_archive", f"{info.filename!r} cannot be read: {error}") from error


def inspect_zip(data: bytes, limits: SourceLimits) -> SourceArchive:
    """Validate a source ZIP from its directory and each entry's first bytes, before any extraction."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise SourceError("invalid_archive", str(error)) from error
    with archive:
        infos = archive.infolist()
        for info in infos:
            if info.flag_bits & 0x1:
                raise SourceError("encrypted", f"{info.filename!r} is encrypted")
        entries = _check_names(infos)
        for info, entry in zip(infos, entries, strict=True):
            _reject_special(info, entry.path)
        _check_sizes(infos, len(data), limits)
        for info, entry in zip(infos, entries, strict=True):
            if entry.is_directory:
                continue
            if _is_prebuilt_name(entry.path) or _is_prebuilt_magic(_read(archive, info, 8)):
                raise SourceError("prebuilt_binary", f"{entry.path} is a prebuilt executable, library or bytecode")
        manifest = _read_manifest(archive, infos, entries)
    paths = {entry.path for entry in entries if not entry.is_directory}
    for lockfile in manifest.lockfiles:
        if lockfile not in paths:
            raise SourceError("missing_lockfile", f"declared lockfile {lockfile} is not in the archive")
    return SourceArchive(hashlib.sha256(data).hexdigest(), manifest, tuple(entries), limits, data)


def _read_manifest(archive: zipfile.ZipFile, infos: list[zipfile.ZipInfo], entries: list[SourceEntry]) -> HarnessManifest:
    for info, entry in zip(infos, entries, strict=True):
        if entry.path == MANIFEST_NAME and not entry.is_directory:
            try:
                return parse_manifest(_read(archive, info, info.file_size))
            except ContractError as error:
                raise SourceError("invalid_manifest", error.message) from error
    raise SourceError("missing_manifest", f"{MANIFEST_NAME} is not at the archive root")


# ---------------------------------------------------------------------------------------------
# Extraction

_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def _open_directory(root_fd: int, parts: tuple[str, ...]) -> int:
    """Open (creating as needed) the directory `parts` below `root_fd`, never following a link."""
    current = os.dup(root_fd)
    try:
        for part in parts:
            try:
                os.mkdir(part, 0o755, dir_fd=current)
            except FileExistsError:
                pass
            next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=current)
            os.close(current)
            current = next_fd
        return current
    except BaseException:
        os.close(current)
        raise


def _write_file(root_fd: int, archive: zipfile.ZipFile, entry: SourceEntry, limits: SourceLimits, written_total: int) -> int:
    parts = PurePosixPath(entry.path).parts
    parent_fd = _open_directory(root_fd, parts[:-1])
    try:
        # O_EXCL|O_NOFOLLOW: never reuse or follow anything already at the path. 0o644 is applied
        # by fchmod so the umask cannot add bits and no setuid or executable bit is ever kept.
        fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)
    written = 0
    try:
        os.fchmod(fd, 0o644)
        try:
            with archive.open(entry.member) as member:
                while chunk := member.read(CHUNK):
                    written += len(chunk)
                    if written > limits.max_file_bytes or written_total + written > limits.max_total_bytes:
                        raise SourceError("too_large", f"{entry.path} expands beyond the extraction limits")
                    os.write(fd, chunk)
        except (zipfile.BadZipFile, zlib.error, EOFError) as error:
            raise SourceError("invalid_archive", f"{entry.path} cannot be read: {error}") from error
    finally:
        os.close(fd)
    if written != entry.size:
        raise SourceError("invalid_archive", f"{entry.path} is {written} bytes, its header declared {entry.size}")
    return written


def extract(archive: SourceArchive, dest: Path) -> None:
    """Extract into the existing empty directory `dest`, enforcing the limits on the bytes actually written."""
    if not dest.is_dir() or any(dest.iterdir()):
        raise SourceError("invalid_destination", f"{dest} is not an empty directory")
    root_fd = os.open(dest, _DIRECTORY_FLAGS)
    try:
        total = 0
        with zipfile.ZipFile(io.BytesIO(archive.data)) as source:
            for entry in archive.entries:
                if entry.is_directory:
                    os.close(_open_directory(root_fd, PurePosixPath(entry.path).parts))
                else:
                    total += _write_file(root_fd, source, entry, archive.limits, total)
    finally:
        os.close(root_fd)
