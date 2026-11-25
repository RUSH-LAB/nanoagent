"""`astra`, this NanoAgent as a member's own agent in RUSH: it runs RUSH's own nanoagent path with this package first and the variant's switches."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from nanoagent.cli import astra

FAKE_RUSH = '''
import os, sys
def nanoagent(entry, argv):
    env = {**os.environ, "PYTHONPATH": "/rush/build/site:/rush/build"}
    os.execvpe(sys.executable, [sys.executable, "-m", "nanoagent.cli." + entry, *argv], env)
'''


@pytest.mark.parametrize(("variant", "stop", "dedup"), [("base", "", "0"), ("stop", astra.STOP, "0"), ("minhash", "", "1"), ("both", astra.STOP, "1")])
def test_runs_rushs_nanoagent_path_with_this_package_first(variant, stop, dedup, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "rush.py").write_text(FAKE_RUSH)
    (tmp_path / "mgen").write_text(f"#!/bin/sh\nexec python {tmp_path}/rush.py mgen \"$@\"\n")
    (tmp_path / "mgen").chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    seen = {}
    monkeypatch.setattr(os, "execvpe", lambda file, argv, env: seen.update(argv=argv, env=env))
    astra.main(["--variant", variant, "Run the audit-run task on run-02-lsh-ast-t05"])
    assert seen["argv"][-3:] == ["nanoagent.cli.mgen", "-p", "Run the audit-run task on run-02-lsh-ast-t05"]
    ours = str(Path(astra.__file__).resolve().parents[2])
    assert seen["env"]["PYTHONPATH"].split(os.pathsep)[:3] == [ours, "/rush/build/site", "/rush/build"]
    assert (seen["env"]["NANOAGENT_STOP_AFTER"], seen["env"]["NANOAGENT_DEDUP"]) == (stop, dedup)


def test_help_without_a_prompt_does_not_need_rush(capsys: pytest.CaptureFixture[str]) -> None:
    astra.main([])
    assert "--variant" in capsys.readouterr().out
