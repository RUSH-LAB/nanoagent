from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.harness.adapters import claude

CALL = {"input_tokens": 2, "output_tokens": 10, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20}


def _call(*blocks: dict) -> list[dict]:
    """One model call as Claude Code streams it: its tokens, then its message."""
    return [
        {"type": "stream_event", "parent_tool_use_id": None, "event": {"type": "message_start"}},
        {"type": "stream_event", "parent_tool_use_id": None, "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "ok"}}},
        {"type": "assistant", "parent_tool_use_id": None, "message": {"content": list(blocks)}},
        {"type": "stream_event", "parent_tool_use_id": None, "event": {"type": "message_delta", "usage": CALL}},
        {"type": "stream_event", "parent_tool_use_id": None, "event": {"type": "message_stop"}},
    ]


RESULT = {
    "type": "result",
    "result": "done",
    "is_error": False,
    "num_turns": 2,
    "duration_ms": 3547,
    "duration_api_ms": 3494,
    "ttft_ms": 900,
    "total_cost_usd": 0.01,
    # Claude Code's own account holds a call the stream does not: 1000 more input tokens.
    "modelUsage": {"m": {"inputTokens": 1004, "outputTokens": 20, "cacheReadInputTokens": 200, "cacheCreationInputTokens": 40}},
}


def _run(tmp_path: Path, events: list[dict]) -> dict:
    executable = tmp_path / "claude"
    stream = "\n".join(json.dumps(event) for event in events)
    executable.write_text(f"#!/bin/sh\ncat > /dev/null\ncat <<'EOF'\n{stream}\nEOF\n")
    executable.chmod(0o755)
    payload = {
        "protocol": "nanoagent.runner.v1",
        "request": {"input": "hi", "messages": [], "instructions": None, "metadata": None, "workspace": str(tmp_path)},
        "options": {"executable": str(executable)},
    }
    return claude._run(payload)


def test_profiles_each_model_call_and_tool_and_counts_every_token(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    tool = {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}
    done = _run(
        tmp_path,
        [
            {"type": "system", "subtype": "init"},
            *_call(tool),
            {"type": "user", "parent_tool_use_id": None, "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "a.txt"}]}},
            *_call({"type": "text", "text": "done"}),
            RESULT,
        ],
    )
    progress = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["type"] for event in progress] == ["delta", "tool_start", "tool", "step", "delta", "step"]
    profile = done["metrics"]
    assert [len(step["model_calls"]) for step in profile["steps"]] == [1, 1]
    assert [call["name"] for call in profile["steps"][0]["tool_calls"]] == ["Bash"]
    assert profile["steps"][0]["model_calls"][0]["usage"]["prompt_tokens"] == 122
    assert profile["steps"][0]["model_calls"][0]["ttft_s"] is not None
    assert done["usage"]["prompt_tokens"] == 1244
    assert done["usage"]["completion_tokens"] == 20
    assert profile["reported"] == {"duration_s": 3.547, "model_s": 3.494, "ttft_s": 0.9, "cost": 0.01, "turns": 2}
    assert done["stop_reason"] == "answer"


def test_a_run_claude_code_reports_failed_fails(tmp_path: Path) -> None:
    done = _run(tmp_path, [{"type": "system", "subtype": "init"}, RESULT | {"is_error": True, "result": "limit reached"}])
    assert done["stop_reason"] == "error"
    assert "limit reached" in done["error"]
