from __future__ import annotations

from pathlib import Path

import pytest

from nanoagent.adapters.claude import _run as run_claude
from nanoagent.adapters.codex import _run as run_codex
from nanoagent.runtime.process_runner import SubprocessRunner
from nanoagent.runtime.runner import RunnerRequest


def executable(path: Path, body: str) -> Path:
    path.write_text("#!/usr/bin/env python3\n" + body)
    path.chmod(0o755)
    return path


def envelope(workspace: Path, executable_path: Path, **options):
    return {
        "protocol": "nanoagent.runner.v1",
        "request": {
            "input": "fix it",
            "instructions": "edit the checkout",
            "messages": [],
            "workspace": str(workspace),
        },
        "options": {"executable": str(executable_path), "model": "default", **options},
    }


def test_codex_adapter_uses_workspace_and_reads_final_message(tmp_path: Path) -> None:
    script = executable(
        tmp_path / "fake-codex",
        "import json, pathlib, sys\n"
        "args=sys.argv[1:]\n"
        "out=pathlib.Path(args[args.index('--output-last-message')+1])\n"
        "prompt=sys.stdin.read()\n"
        "pathlib.Path('changed.txt').write_text(prompt)\n"
        "out.write_text('finished')\n"
        "print(json.dumps({'type':'turn.completed','usage':{'input_tokens':2,'output_tokens':1}}))\n",
    )

    result = run_codex(envelope(tmp_path, script, sandbox="workspace-write"))

    assert result["answer"] == "finished"
    assert result["usage"] == {"input_tokens": 2, "output_tokens": 1}
    assert (tmp_path / "changed.txt").read_text() == "edit the checkout\n\nfix it\n"


def test_claude_adapter_uses_workspace_and_normalizes_result(tmp_path: Path) -> None:
    script = executable(
        tmp_path / "fake-claude",
        "import json, pathlib, sys\n"
        "pathlib.Path('changed.txt').write_text(sys.stdin.read())\n"
        "print(json.dumps({'result':'finished','is_error':False,'num_turns':3,"
        "'total_cost_usd':0.25,'usage':{'input_tokens':4,'output_tokens':2}}))\n",
    )

    result = run_claude(envelope(tmp_path, script, permission_mode="bypassPermissions"))

    assert result["answer"] == "finished"
    assert result["steps"] == 3
    assert result["cost"] == 0.25
    assert result["usage"] == {"input_tokens": 4, "output_tokens": 2}
    assert (tmp_path / "changed.txt").read_text() == "edit the checkout\n\nfix it\n"


@pytest.mark.asyncio
async def test_codex_companion_speaks_runner_protocol(tmp_path: Path) -> None:
    script = executable(
        tmp_path / "fake-codex",
        "import json, pathlib, sys\n"
        "args=sys.argv[1:]\n"
        "pathlib.Path(args[args.index('--output-last-message')+1]).write_text('done')\n"
        "sys.stdin.read()\n"
        "print(json.dumps({'type':'turn.completed','usage':{'total_tokens':3}}))\n",
    )
    runner = SubprocessRunner(
        "codex",
        ["nanoagent-codex-runner"],
        options={"executable": str(script), "model": "default"},
    )

    result = await runner.run(
        RunnerRequest(input="fix it", workspace=str(tmp_path)), lambda _event: None
    )

    assert result.answer == "done"
    assert result.usage == {"total_tokens": 3}
