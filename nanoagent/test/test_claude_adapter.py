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
    assert profile["reported"] == {"duration_s": 3.547, "model_s": 3.494, "ttft_s": 0.9, "cost": 0.01, "turns": 2, "usage_by_model": {"m": done["usage"]}}
    assert done["stop_reason"] == "answer"


def test_a_run_claude_code_reports_failed_fails(tmp_path: Path) -> None:
    done = _run(tmp_path, [{"type": "system", "subtype": "init"}, RESULT | {"is_error": True, "result": "limit reached"}])
    assert done["stop_reason"] == "error"
    assert "limit reached" in done["error"]


def test_partial_usage_and_no_phantom_call(tmp_path: Path) -> None:
    tool = {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}
    events = _call(tool)
    events[0]["event"]["message"] = {"usage": {"input_tokens": 2, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20}}
    events[-2]["event"]["usage"] = {"output_tokens": 10}
    done = _run(tmp_path, [{"type": "system", "subtype": "init"}, *events,
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}, RESULT])
    assert len(done["metrics"]["steps"]) == 1
    assert done["metrics"]["steps"][0]["usage"]["prompt_tokens"] == 122


def test_a_call_after_tools_runs_from_their_last_result(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [0.0]
    monkeypatch.setattr(claude.time, "perf_counter", lambda: now[0])
    relay = claude._Relay()

    def at(seconds: float, event: dict) -> None:
        now[0] = seconds
        relay(event)

    tool = {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}
    first, second = _call(tool), _call()
    at(0.0, {"type": "system", "subtype": "init"})
    at(1.0, first[0])
    at(2.0, first[2])  # the tool call: the model call ends, the tool starts
    at(2.5, first[3])
    at(2.5, first[4])
    at(4.0, {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}})
    at(7.0, second[0])  # the next call's stream starts; it was asked for at 4.0
    at(8.0, second[4])
    one, two = relay.profiler.finish().steps
    assert (one.duration_s, one.model_s, one.tools_s) == (4.0, 2.0, 2.0)
    assert two.model_calls[0].duration_s == 4.0
