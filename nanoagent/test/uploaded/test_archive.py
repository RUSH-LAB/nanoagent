"""copy_tree: a sandbox's directory copied without following links, within its bounds."""

from __future__ import annotations

import os
import struct
import subprocess

import pytest

from nanoagent.uploaded.archive import GUEST_STAT, ArchiveError, copy_tree


def test_regular_files_and_directories_are_copied_and_links_and_specials_only_listed(tmp_path):
    source = tmp_path / "workspace"
    (source / "sub").mkdir(parents=True)
    (source / "a.txt").write_text("a")
    (source / "sub" / "run.sh").write_text("#!/bin/sh\n")
    (source / "sub" / "run.sh").chmod(0o700)
    (source / "evil").symlink_to("/etc")
    os.mkfifo(source / "pipe")
    extracted = copy_tree(source, tmp_path / "out", max_files=10, max_bytes=1 << 20)
    assert set(extracted.files) == {"a.txt", "sub/run.sh"} and extracted.directories == ("sub",)
    assert extracted.skipped == {"evil": "symlink", "pipe": "special"}
    assert extracted.total_bytes == 11
    assert (tmp_path / "out" / "a.txt").read_text() == "a"
    assert not (tmp_path / "out" / "evil").exists(), "a link is never materialized"
    assert (tmp_path / "out" / "sub" / "run.sh").stat().st_mode & 0o777 == 0o755


def test_a_tree_past_its_bounds_is_refused(tmp_path):
    source = tmp_path / "workspace"
    source.mkdir()
    for index in range(3):
        (source / f"{index}.txt").write_text("x" * 10)
    with pytest.raises(ArchiveError) as files:
        copy_tree(source, tmp_path / "a", max_files=2, max_bytes=1 << 20)
    assert files.value.code == "snapshot_too_large"
    with pytest.raises(ArchiveError) as size:
        copy_tree(source, tmp_path / "b", max_files=10, max_bytes=25)
    assert size.value.code == "snapshot_too_large"


def test_a_root_that_is_a_link_is_refused(tmp_path):
    (tmp_path / "real").mkdir()
    (tmp_path / "link").symlink_to(tmp_path / "real")
    with pytest.raises(OSError):
        copy_tree(tmp_path / "link", tmp_path / "out", max_files=10, max_bytes=1 << 20)


def _keep_guest_mode(path, mode):
    """Give ``path`` the stat microsandbox keeps for a file its guest wrote, as it does where the host cannot hold it."""
    value = struct.pack("<5I", 1, 10001, 10001, mode, 0)
    if hasattr(os, "setxattr"):
        os.setxattr(path, GUEST_STAT, value)
    else:
        subprocess.run(["xattr", "-wx", GUEST_STAT, value.hex(), str(path)], check=True)


def test_a_file_keeps_the_mode_its_sandbox_gave_it_not_the_host_files(tmp_path):
    source = tmp_path / "build-out"
    source.mkdir()
    for name, mode in (("claude", 0o100755), ("main.mjs", 0o100644)):
        (source / name).write_text(name)
        (source / name).chmod(0o600)
        _keep_guest_mode(source / name, mode)
    copy_tree(source, tmp_path / "out", max_files=10, max_bytes=1 << 20)
    assert (tmp_path / "out" / "claude").stat().st_mode & 0o777 == 0o755
    assert (tmp_path / "out" / "main.mjs").stat().st_mode & 0o777 == 0o644
