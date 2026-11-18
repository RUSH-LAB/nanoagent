"""Source ZIP validation and extraction."""

from __future__ import annotations

import io
import os
import stat
import zipfile
from pathlib import Path

import pytest

from nanoagent.uploaded.source import SourceError, SourceLimits, extract, inspect_zip

LIMITS = SourceLimits()
MANIFEST = b"protocol: rush.harness.v1\nname: h\nversion: '1'\ndialects: [chat_completions]\ntoolchain: go-1\nlockfiles: [go.mod]\nbuild:\n  argv: [go, build]\n  outputs: [harness]\nrun:\n  argv: [/harness/harness]\n"
ELF = b"\x7fELF\x02\x01\x01" + b"\0" * 20


def build(extra: dict[str, bytes] | None = None, *, manifest: bytes | None = MANIFEST, lock: bool = True, compression: int = zipfile.ZIP_DEFLATED) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression) as archive:
        if manifest is not None:
            archive.writestr("harness.yaml", manifest)
        if lock:
            archive.writestr("go.mod", b"module x\n")
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
    return buffer.getvalue()


def raw_zip(entries: list[tuple[zipfile.ZipInfo | str, bytes]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("harness.yaml", MANIFEST)
        archive.writestr("go.mod", b"m")
        for info, content in entries:
            archive.writestr(info, content)
    return buffer.getvalue()


def mode_entry(name: str, mode: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name)
    info.create_system = 3
    info.external_attr = mode << 16
    return info


def rejected(data: bytes, code: str, limits: SourceLimits = LIMITS) -> None:
    with pytest.raises(SourceError) as raised:
        inspect_zip(data, limits)
    assert raised.value.code == code, raised.value


def test_valid_archive_is_inspected_and_digested() -> None:
    import hashlib

    data = build({"src/main.go": b"package main\n", "empty/": b""})
    archive = inspect_zip(data, LIMITS)
    assert archive.source_sha256 == hashlib.sha256(data).hexdigest()
    assert archive.manifest.toolchain == "go-1"
    assert {entry.path for entry in archive.entries} == {"harness.yaml", "go.mod", "src/main.go", "empty"}


def test_not_a_zip() -> None:
    rejected(b"not a zip", "invalid_archive")


def test_missing_manifest_and_nested_manifest() -> None:
    rejected(build(manifest=None), "missing_manifest")
    rejected(build({"sub/harness.yaml": MANIFEST}, manifest=None), "missing_manifest")


def test_invalid_manifest() -> None:
    rejected(build(manifest=b"- not a mapping\n"), "invalid_manifest")
    rejected(build(manifest=MANIFEST + b"toolchain: dup\n"), "invalid_manifest")


def test_missing_lockfile() -> None:
    rejected(build(lock=False), "missing_lockfile")
    rejected(build({"go.mod/x": b"x"}, lock=False), "missing_lockfile")


@pytest.mark.parametrize("name", ["../x", "a/../../x", "/abs", "C:/x", "a\\b", "a//b", "./a", "a/./b"])
def test_paths_must_be_canonical_relative(name: str) -> None:
    expected = "invalid_path" if name in {"a//b", "./a", "a/./b"} else "traversal"
    rejected(raw_zip([(zipfile.ZipInfo(name), b"x")]), expected)


def test_duplicate_entries() -> None:
    rejected(raw_zip([("a.txt", b"1"), ("a.txt", b"2")]), "duplicate_path")


@pytest.mark.parametrize("second", ["README.TXT", "readme.txt"])
def test_case_collisions(second: str) -> None:
    rejected(raw_zip([("README.txt", b"1"), (second, b"2")]), "colliding_path")


def test_unicode_normalization_collisions() -> None:
    rejected(raw_zip([("caf\u00e9.txt", b"1"), ("cafe\u0301.txt", b"2")]), "colliding_path")


def test_file_and_directory_collide() -> None:
    rejected(raw_zip([("a", b"1"), ("a/b", b"2")]), "path_conflict")
    rejected(raw_zip([("a/", b""), ("a/b", b"2"), ("A", b"")]), "colliding_path")
    rejected(raw_zip([("d/x", b"2"), ("d", b"1")]), "path_conflict")


def test_symlinks_are_rejected() -> None:
    rejected(raw_zip([(mode_entry("link", stat.S_IFLNK | 0o777), b"/etc/passwd")]), "link")
    rejected(raw_zip([(mode_entry("dir/link", stat.S_IFLNK | 0o777), b"../..")]), "link")


@pytest.mark.parametrize("kind", [stat.S_IFIFO, stat.S_IFCHR, stat.S_IFBLK, stat.S_IFSOCK])
def test_special_files_are_rejected(kind: int) -> None:
    rejected(raw_zip([(mode_entry("dev", kind | 0o644), b"")]), "special_file")


def test_encrypted_entries_are_rejected() -> None:
    data = bytearray(build({"s.txt": b"secret"}))
    # Set the encryption bit (general purpose flag bit 0) in every local and central header.
    for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        position = data.find(signature)
        while position != -1:
            data[position + offset] |= 1
            position = data.find(signature, position + 4)
    rejected(bytes(data), "encrypted")


@pytest.mark.parametrize("name", ["lib.so", "lib.so.1.2", "a.dylib", "a.dll", "a.exe", "a.a", "a.o", "a.obj", "a.lib", "x.pyc", "x.pyo", "A.Class", "a.jar", "a.war", "a.wasm", "a.node", "d/__pycache__/m.pyc"])
def test_prebuilt_extensions_are_rejected(name: str) -> None:
    rejected(build({name: b"plain text"}), "prebuilt_binary")


@pytest.mark.parametrize(
    "head",
    [
        ELF,
        b"\xfe\xed\xfa\xce" + b"\0" * 8,
        b"\xfe\xed\xfa\xcf" + b"\0" * 8,
        b"\xce\xfa\xed\xfe" + b"\0" * 8,
        b"\xcf\xfa\xed\xfe" + b"\0" * 8,
        b"\xca\xfe\xba\xbe" + b"\0" * 8,
        b"MZ\x90\x00" + b"\0" * 8,
        b"\x00asm\x01\x00\x00\x00",
        b"\xcb\x0d\x0d\x0a" + b"\0" * 12,
        b"\x03\xf3\x0d\x0a" + b"\0" * 12,
    ],
)
def test_prebuilt_magic_is_rejected_whatever_the_name(head: bytes) -> None:
    rejected(build({"tool.txt": head}), "prebuilt_binary")


def test_text_that_merely_looks_similar_is_accepted() -> None:
    inspect_zip(build({"a.txt": b"MX is fine", "b.txt": b"ab\r\ncd", "c.sh": b"#!/bin/sh\n"}), LIMITS)


def test_size_limits() -> None:
    data = build({"a": b"x" * 10, "b": b"y" * 10})
    rejected(data, "too_large", SourceLimits(max_entries=3))
    rejected(data, "too_large", SourceLimits(max_file_bytes=len(MANIFEST) - 1))
    rejected(data, "too_large", SourceLimits(max_total_bytes=len(MANIFEST) + 20))


def test_zip_bomb_by_ratio() -> None:
    bomb = build({"zeros.txt": b"\0" * 5_000_000})
    rejected(bomb, "compression_ratio")
    inspect_zip(bomb, SourceLimits(max_compression_ratio=1_000_000))


def test_extract_writes_regular_files_only(tmp_path: Path) -> None:
    info = mode_entry("run.sh", stat.S_IFREG | 0o4755)
    archive = inspect_zip(raw_zip([(info, b"#!/bin/sh\n"), ("src/deep/main.go", b"package main\n"), ("empty/", b"")]), LIMITS)
    dest = tmp_path / "out"
    dest.mkdir()
    extract(archive, dest)
    assert (dest / "src" / "deep" / "main.go").read_bytes() == b"package main\n"
    assert (dest / "empty").is_dir()
    assert (dest / "harness.yaml").read_bytes() == MANIFEST
    for path in dest.rglob("*"):
        if path.is_file():
            assert stat.S_IMODE(path.stat().st_mode) == 0o644, path


def test_extract_refuses_a_non_empty_or_missing_destination(tmp_path: Path) -> None:
    archive = inspect_zip(build(), LIMITS)
    (tmp_path / "full").mkdir()
    (tmp_path / "full" / "x").write_text("x")
    for dest in (tmp_path / "full", tmp_path / "missing"):
        with pytest.raises(SourceError) as raised:
            extract(archive, dest)
        assert raised.value.code == "invalid_destination"


def test_extract_enforces_limits_on_actual_bytes(tmp_path: Path) -> None:
    # Declare a tiny size in the headers, then ship more: the stream must be cut by the real count.
    data = bytearray(build({"big.txt": b"a" * 100}, compression=zipfile.ZIP_STORED))
    archive = inspect_zip(bytes(data), SourceLimits(max_file_bytes=1000))
    lying = SourceLimits(max_file_bytes=50)
    dest = tmp_path / "o"
    dest.mkdir()
    with pytest.raises(SourceError) as raised:
        extract(type(archive)(archive.source_sha256, archive.manifest, archive.entries, lying, archive.data), dest)
    assert raised.value.code == "too_large"


def test_extract_detects_a_size_that_disagrees_with_the_header(tmp_path: Path) -> None:
    archive = inspect_zip(build({"a.txt": b"abc"}), LIMITS)
    entries = tuple(type(entry)(entry.path, entry.size + 1, entry.is_directory) if entry.path == "a.txt" else entry for entry in archive.entries)
    dest = tmp_path / "o"
    dest.mkdir()
    with pytest.raises(SourceError) as raised:
        extract(type(archive)(archive.source_sha256, archive.manifest, entries, archive.limits, archive.data), dest)
    assert raised.value.code == "invalid_archive"


def test_extract_never_follows_a_link_planted_in_the_destination(tmp_path: Path) -> None:
    archive = inspect_zip(build({"src/a.txt": b"x"}), LIMITS)
    outside = tmp_path / "outside"
    outside.mkdir()
    dest = tmp_path / "dest"
    dest.mkdir()
    # A destination that is not empty is refused up front; plant the link after that check by racing the mkdir.
    real_mkdir = os.mkdir

    def planting_mkdir(path: str, mode: int = 0o777, *, dir_fd: int | None = None) -> None:
        if path == "src":
            os.symlink(outside, path, dir_fd=dir_fd)
            raise FileExistsError(path)
        real_mkdir(path, mode, dir_fd=dir_fd)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(os, "mkdir", planting_mkdir)
        with pytest.raises(OSError):
            extract(archive, dest)
    assert list(outside.iterdir()) == []
