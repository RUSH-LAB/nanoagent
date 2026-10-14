from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from packaging.tags import sys_tags

from nanoagent import helpers
from nanoagent.plugin import load_manifest, sandbox, verify_input
from nanoagent.plugin.package import inspect_package, pack
from nanoagent.plugin.python import plugin_python
from nanoagent.tools.code import CodeExec
from test_plugin import write_plugin


@pytest.fixture
def compiled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """NanoAgent as a compiled binary would be: one executable that takes NanoAgent's arguments."""
    binary = tmp_path / "nanoagent.dist" / "nanoagent"
    binary.parent.mkdir()
    binary.write_text(f'#!/bin/sh\nexec "{sys.executable}" -I -m nanoagent "$@"\n', encoding="utf-8")
    binary.chmod(0o755)
    monkeypatch.setattr(helpers, "COMPILED", True)
    monkeypatch.setattr(sys, "executable", str(binary))
    return binary


def test_from_source_a_helper_runs_on_this_python() -> None:
    assert helpers.command("package", "x") == [sys.executable, "-I", "-m", "nanoagent", "helper", "package", "x"]
    assert helpers.python("this") == sys.executable
    with pytest.raises(ValueError, match="no NanoAgent helper 'nope'"):
        helpers.command("nope")


def test_compiled_a_helper_runs_on_the_binary(compiled: Path) -> None:
    assert helpers.command("verifier") == [str(compiled), "helper", "verifier"]
    assert helpers.readable() == [compiled.parent.resolve()]
    with pytest.raises(RuntimeError, match="the python tool needs NanoAgent's own Python"):
        CodeExec()


def test_compiled_inspects_packages_and_verifies_through_the_binary(compiled: Path, tmp_path: Path) -> None:
    root = write_plugin(tmp_path / "echo").parent
    assert inspect_package(pack(root))["id"] == "echo"
    assert verify_input(load_manifest(root), "echo", {"value": "yes"}).score == 1


def test_an_unknown_helper_is_refused() -> None:
    completed = subprocess.run(helpers.command("package")[:-1] + ["nope"], capture_output=True, text=True, check=False)
    assert completed.returncode == 2 and "usage: nanoagent helper {package|verifier|egress-bridge}" in completed.stderr


def test_a_helper_starts_without_the_cli() -> None:
    script = (
        "import runpy, sys\n"
        "sys.argv = ['nanoagent', 'helper']\n"
        "try:\n"
        "    runpy.run_module('nanoagent', run_name='__main__')\n"
        "except SystemExit:\n"
        "    print('nanoagent.cli' in sys.modules)\n"
    )
    assert subprocess.run([sys.executable, "-I", "-c", script], capture_output=True, text=True, check=True).stdout == "False\n"


def test_the_plugin_python_is_the_installation_behind_the_interpreter() -> None:
    python = plugin_python(sys.executable)
    assert python.executable == Path(sys._base_executable).resolve()
    assert python.prefix == Path(sys.base_prefix).resolve()
    assert python.tags == frozenset(sys_tags())
    assert python.marker == f"{python.executable}\n{sys.version}\n"


def test_refuses_a_plugin_python_that_is_not_one(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="is not an executable"):
        plugin_python(str(tmp_path / "python"))
    with pytest.raises(RuntimeError, match="'false' failed: exit 1"):
        plugin_python("false")


def test_a_sandbox_needs_the_plugin_python() -> None:
    with pytest.raises(ValueError, match="the seatbelt sandbox needs the Python plugins run on"):
        sandbox.configure("seatbelt")
