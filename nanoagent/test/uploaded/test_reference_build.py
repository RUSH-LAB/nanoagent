"""The reference harnesses NanoAgent ships: their names, the deterministic build, the version derived from content."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
import yaml

from nanoagent.uploaded.reference import FOLDER, LOCKS, NAMES, build_reference, content_version
from nanoagent.uploaded.source_zip import FIXED_TIME


def manifest_of(data: bytes) -> dict:
    return yaml.safe_load(zipfile.ZipFile(io.BytesIO(data)).read("harness.yaml"))


def test_the_references_are_the_shell_and_its_clis_locks_and_each_manifest_carries_its_folders_name() -> None:
    assert NAMES == ("claude-code", "codex", "dsh", "hermes", "nanoagent", "pi", "shell")
    for name in NAMES:
        assert yaml.safe_load(((FOLDER if name == "shell" else LOCKS) / name / "harness.yaml").read_text())["name"] == name


def test_the_shell_reference_holds_the_terminal_and_not_the_clis_locks() -> None:
    with zipfile.ZipFile(io.BytesIO(build_reference("shell"))) as archive:
        names = archive.namelist()
    assert {"harness.yaml", "shell.py", "harnesses.yaml", "nanoagent_tools.py", "bin/claude"} <= set(names)
    assert not any(name.startswith("locks/") for name in names)


def test_a_reference_builds_to_the_same_zip_under_a_version_derived_from_its_content() -> None:
    first = build_reference("claude-code")
    assert build_reference("claude-code") == first
    manifest = manifest_of(first)
    assert manifest["name"] == "claude-code" and len(manifest["version"]) == 12
    with zipfile.ZipFile(io.BytesIO(first)) as archive:
        assert {info.date_time for info in archive.infolist()} == {FIXED_TIME}
    assert manifest_of(build_reference("codex"))["version"] != manifest["version"]


def test_the_version_follows_the_content(tmp_path: Path) -> None:
    (tmp_path / "harness.yaml").write_text("name: x\n")
    before = content_version(tmp_path)
    assert content_version(tmp_path) == before
    (tmp_path / "main.py").write_text("print(1)\n")
    assert content_version(tmp_path) != before


def test_the_nanoagent_reference_holds_the_working_tree_and_never_a_bytecode_cache() -> None:
    with zipfile.ZipFile(io.BytesIO(build_reference("nanoagent"))) as archive:
        names = archive.namelist()
    assert "nanoagent/core/__init__.py" in names and "nanoagent/cli/mgen.py" in names and "requirements.txt" in names
    assert not any(name.startswith("taskharness/") or name == "main.py" for name in names)
    assert not any("__pycache__" in name or name.endswith("assemble.py") for name in names)


def test_an_unknown_reference_is_refused() -> None:
    with pytest.raises(ValueError, match="not a reference harness"):
        build_reference("mine")
