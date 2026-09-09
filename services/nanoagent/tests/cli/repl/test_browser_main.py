"""Offline unit tests for the two exit-code branches of :func:`nanoagent.cli.repl.browser.main`.

``main`` has three return paths; the first two are fully offline and were previously
unpinned. ``test_browser.py`` covers ``render_message``, ``test_browser_steps.py`` covers
``find_trajectories``/``messages_to_steps``/``_load_messages``,
``test_load_messages_scalar.py`` covers the scalar branch, and
``test_cli_dispatch.py::test_browse_delegates_to_browser`` monkeypatches ``import_module``
so the real ``main`` body never runs — none of them call ``main``. This file pins it:

* ``main([])`` -> prints ``_USAGE`` and returns ``2`` (no-args usage path).
* ``main(["path=<empty dir>"])`` -> ``find_trajectories`` finds nothing, so it prints the
  "no <suffix> files found under ..." message and returns ``1`` without reaching the
  Textual TUI.

The third path (``_run_app(files); return 0``) launches the Textual app and is *not*
offline, so it is deliberately left uncovered.

Consumes: ``nanoagent.cli.repl.browser`` (the ``main`` entry point under test) and
``nanoagent.runtime.trajectory.TRAJECTORY_SUFFIX`` (the real ``*.traj.json`` suffix). Pure — stdlib
plus pytest's ``tmp_path``/``capsys`` only; no model, network or GPU, and the empty
``tmp_path`` guarantees ``find_trajectories`` returns ``[]`` so ``_run_app`` is never reached.

Run (from the repo root)::

    python3 -m pytest tests/cli/repl/test_browser_main.py -x -q
"""

from __future__ import annotations

from pathlib import Path

import pytest

from nanoagent.cli.repl import browser
from nanoagent.runtime.trajectory import TRAJECTORY_SUFFIX


def test_main_no_args_prints_usage_returns_2(capsys: pytest.CaptureFixture[str]) -> None:
    # Empty argv -> the usage line is printed and the exit code is 2 (not 0 or 1).
    rc = browser.main([])
    assert rc == 2
    assert browser._USAGE in capsys.readouterr().out


def test_main_empty_dir_finds_nothing_returns_1(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # An empty directory has no *.traj.json files, so find_trajectories returns [] and main
    # reports "no <suffix> files found under ..." and returns 1 without launching the app.
    rc = browser.main([f"path={tmp_path}"])
    assert rc == 1
    out = capsys.readouterr().out
    assert TRAJECTORY_SUFFIX in out
    assert "files found" in out
