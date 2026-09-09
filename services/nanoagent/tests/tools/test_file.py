"""Offline unit tests for :mod:`nanoagent.tools.file` and the workspace it resolves against.

Pins the four properties the file tools are worth having for:

* round-trip — ``write`` then ``read`` returns the content back, 1-numbered.
* unambiguous edit — ``edit`` replaces a unique ``old`` and REFUSES a non-unique or absent one,
  which is the whole reason for a structured edit over a ``sed`` through ``bash``.
* provenance — a configured JSONL gets exactly one row per byte-changing call and none for reads.
* confinement — every path resolves under :func:`nanoagent.core.workspace.current`, so a rollout given
  its own checkout cannot read or write outside it, and a ``..`` escape is rejected.

Fully offline: tmp_path only, no model, network or GPU.

Run (from the repo root)::

    python3 -m pytest tests/tools/test_file.py -x -q
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.core import workspace
from nanoagent.tools.file import Edit, Read, Write


def test_write_then_read_round_trips_with_line_numbers(tmp_path: Path) -> None:
    with workspace.use(tmp_path):
        Write().run("a/b.txt", "one\ntwo\n")
        assert (tmp_path / "a/b.txt").read_text() == "one\ntwo\n"  # parents created
        assert Read().run("a/b.txt") == "1\tone\n2\ttwo"


def test_read_offset_and_limit_page_the_file(tmp_path: Path) -> None:
    with workspace.use(tmp_path):
        Write().run("f.txt", "\n".join(str(i) for i in range(1, 11)))
        out = Read().run("f.txt", offset=3, limit=2)
        assert out.startswith("3\t3\n4\t4")
        assert "more line(s)" in out  # the tail is announced, not silently dropped


def test_edit_replaces_unique_and_rejects_ambiguous(tmp_path: Path) -> None:
    with workspace.use(tmp_path):
        Write().run("f.txt", "alpha\nbeta\nalpha\n")
        with pytest.raises(ValueError, match="found 2 times"):
            Edit().run("f.txt", "alpha", "gamma")
        with pytest.raises(ValueError, match="not found"):
            Edit().run("f.txt", "delta", "gamma")
        assert (tmp_path / "f.txt").read_text() == "alpha\nbeta\nalpha\n"  # neither touched it
        Edit().run("f.txt", "beta", "gamma")
        assert (tmp_path / "f.txt").read_text() == "alpha\ngamma\nalpha\n"


def test_provenance_records_writes_and_edits_only(tmp_path: Path) -> None:
    log = tmp_path / "logs" / "provenance.jsonl"
    with workspace.use(tmp_path):
        kwargs = {"provenance": str(log)}
        Write(**kwargs).run("f.txt", "x\n")
        Edit(**kwargs).run("f.txt", "x", "y")
        Read(**kwargs).run("f.txt")  # reads change nothing, so they are not provenance
    rows = [json.loads(line) for line in log.read_text().splitlines()]
    assert [r["tool"] for r in rows] == ["write", "edit"]
    assert all(r["path"] == str(tmp_path / "f.txt") for r in rows)


def test_paths_are_confined_to_the_workspace(tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_text("secret\n")
    inner = tmp_path / "inner"
    inner.mkdir()
    with workspace.use(inner):
        for call in (
            lambda: Read().run("../outside.txt"),
            lambda: Write().run("../escaped.txt", "x"),
        ):
            with pytest.raises(ValueError, match="outside the workspace"):
                call()
    assert not (tmp_path / "escaped.txt").exists()


def test_workspace_defaults_to_cwd_and_restores(tmp_path: Path) -> None:
    before = workspace.current()
    with workspace.use(tmp_path):
        assert workspace.current() == tmp_path.resolve()
    assert workspace.current() == before  # the ContextVar token is reset on exit
