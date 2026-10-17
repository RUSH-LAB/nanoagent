from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from packaging.tags import sys_tags

from nanoagent import helpers
from nanoagent.__main__ import ENTRY
from nanoagent.plugin import sandbox
from nanoagent.plugin.python import plugin_python


def test_a_helper_runs_on_this_python() -> None:
    assert helpers.command("package", "x") == [sys.executable, "-I", "-c", ENTRY, "helper", "package", "x"]
    with pytest.raises(ValueError, match="no NanoAgent helper 'nope'"):
        helpers.command("nope")


def test_an_unknown_helper_is_refused() -> None:
    completed = subprocess.run(helpers.command("package")[:-1] + ["nope"], capture_output=True, text=True, check=False)
    assert completed.returncode == 2 and "usage: nanoagent helper {package|verifier|egress-bridge|appcontainer}" in completed.stderr


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
