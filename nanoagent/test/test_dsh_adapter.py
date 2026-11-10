from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.harness.adapters import dsh

STEP_USAGE = {"inputTokens": 100, "outputTokens": 20, "cacheReadTokens": 40, "cacheWriteTokens": 0, "totalTokens": 160}


def _run(tmp_path: Path, events: list[dict], status: int = 0) -> dict:
    """Run the adapter on a stand-in for npx that prints ``events`` and exits with ``status``."""
    npx = tmp_path / "npx"
    stream = "\n".join(json.dumps(event) for event in events)
    npx.write_text(f"#!/bin/sh\ncat > /dev/null\ncat <<'EOF'\n{stream}\nEOF\necho 'dsh: diagnostics' >&2\nexit {status}\n")
    npx.chmod(0o755)
    payload = {
        "protocol": "nanoagent.runner.v1",
        "request": {"input": "hi", "messages": [], "instructions": None, "metadata": None, "workspace": str(tmp_path)},
        "options": {"executable": str(npx), "model": "deepseek-flash", "package": "@deepseek-ai/dsh@0.2.2-rc.1"},
    }
    return dsh._run(payload)


def _progress(capsys: pytest.CaptureFixture[str]) -> list[dict]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


def test_relays_and_profiles_the_run(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    done = _run(
        tmp_path,
        [
            {"type": "session", "sessionId": "session-1", "cwd": str(tmp_path)},
            {"type": "status", "phase": "step_start", "turn": 1, "step": 1},
            {"type": "tool_call", "callId": "c1", "tool": "bash", "input": {"command": "ls"}},
            {"type": "tool_result", "callId": "c1", "status": "completed", "result": "a.txt\n"},
            {"type": "status", "phase": "step_end", "turn": 1, "step": 1, "usage": STEP_USAGE},
            {"type": "status", "phase": "step_start", "turn": 1, "step": 2},
            {"type": "text", "text": "done"},
            {"type": "status", "phase": "step_end", "turn": 1, "step": 2, "usage": STEP_USAGE},
            {"type": "final", "sessionId": "session-1", "reason": {"kind": "completed"}, "text": "done"},
        ],
    )
    # Input counts every token sent, cached or not.
    step = {"prompt_tokens": 140, "completion_tokens": 20, "total_tokens": 160, "cached_tokens": 40, "cache_write_tokens": 0}
    progress = [{key: value for key, value in event.items() if key != "metrics"} for event in _progress(capsys)]
    assert progress == [
        {"type": "tool_start", "id": "c1", "name": "bash"},
        {"type": "tool", "id": "c1", "name": "bash", "arguments": {"command": "ls"}, "output": "a.txt\n", "is_error": False},
        {"type": "step", "step": 1, "cost": 0.0, "usage": step},
        {"type": "delta", "kind": "content", "text": "done"},
        {"type": "step", "step": 2, "cost": 0.0, "usage": step},
    ]
    assert done["answer"] == "done"
    assert done["stop_reason"] == "answer"
    assert done["error"] is None
    assert done["steps"] == 2
    assert done["usage"] == {name: 2 * value for name, value in step.items()}
    profile = done["metrics"]
    assert [[call["name"] for call in one["tool_calls"]] for one in profile["steps"]] == [["bash"], []]
    assert all(len(one["model_calls"]) == 1 and one["model_calls"][0]["ttft_s"] is None for one in profile["steps"])


def test_a_run_dsh_ends_unfinished_fails_with_its_reason(tmp_path: Path) -> None:
    done = _run(
        tmp_path,
        [
            {"type": "status", "phase": "step_start", "turn": 1, "step": 1},
            {"type": "status", "phase": "step_end", "turn": 1, "step": 1},
            {"type": "final", "sessionId": "session-1", "reason": {"kind": "error", "error": {"code": "AUTH"}}, "text": ""},
        ],
        status=1,
    )
    assert done["stop_reason"] == "error"
    assert '"code": "AUTH"' in done["error"]
    assert "dsh: diagnostics" in done["error"]
    assert "no usage for step(s) [1]" in done["error"]


def test_an_error_event_fails_the_run(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="unknown session"):
        _run(tmp_path, [{"type": "error", "message": "unknown session"}], status=1)


def test_a_provider_runs_on_that_pi_ai_route(tmp_path: Path) -> None:
    options = {
        "package": "@deepseek-ai/dsh@0.2.2-rc.1",
        "model": "deepseek/deepseek-v4-flash-0731",
        "provider": "openrouter",
        "api_key_env": "OPENROUTER_API_KEY",
    }
    command = dsh._command("npx", tmp_path, options)
    patch = Path(command[command.index("--patch") + 1]).read_text()
    assert '"openrouter":\n        apiKeyEnv: "OPENROUTER_API_KEY"' in patch
    assert 'provider: "openrouter"\n    model: "deepseek/deepseek-v4-flash-0731"' in patch
