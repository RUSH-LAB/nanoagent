"""copy_tree: a sandbox's directory copied without following links, within its bounds."""

from __future__ import annotations

import os

import pytest

from nanoagent.uploaded.archive import ArchiveError, copy_tree


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
