from __future__ import annotations

import json
from pathlib import Path

from nanoagent.harness.adapters import codex


def _usage(tokens: int) -> dict:
    return {"input_tokens": tokens, "cached_input_tokens": tokens // 2, "output_tokens": 10, "reasoning_output_tokens": 2}


def _record(second: float, kind: str, payload: dict | None = None) -> str:
    stamp = f"2026-11-10T19:00:{second:06.3f}Z"
    if kind in {"token_usage_record"}:
        return json.dumps({"timestamp": stamp, "type": kind})
    return json.dumps(
        {
            "timestamp": stamp,
            "type": "response_item" if payload and "call_id" in payload else "event_msg",
            "payload": {"type": kind, **(payload or {})},
        }
    )


def test_profiles_codexs_session_with_each_calls_usage(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    session.write_text(
        "\n".join(
            [
                _record(1.0, "task_started"),
                _record(3.0, "function_call", {"call_id": "c1", "name": "exec_command"}),
                _record(3.5, "token_usage_record"),
                _record(4.0, "function_call_output", {"call_id": "c1", "output": "Process exited with code 1\nOutput:\n"}),
                # Codex counts a call's usage after its tools' output: it is still the first call's.
                _record(4.0, "token_count", {"info": {"last_token_usage": _usage(100)}}),
                json.dumps({"timestamp": "2026-11-10T19:00:06.000Z", "type": "response_item", "payload": {"type": "message", "role": "assistant"}}),
                _record(6.5, "token_usage_record"),
                _record(6.5, "token_count", {"info": {"last_token_usage": _usage(200)}}),
                _record(7.0, "task_complete", {"duration_ms": 6000, "time_to_first_token_ms": 1500}),
            ]
        )
    )
    started = codex._seconds("2026-11-10T19:00:00.000Z")
    profile, reported = codex._profile(session, started, _usage(300))
    first, second = profile.steps
    assert first.model_calls[0].usage["prompt_tokens"] == 100
    assert first.model_calls[0].duration_s == 2.5  # the turn's start to Codex's record of the response
    assert [(tool.name, tool.duration_s, tool.is_error) for tool in first.tool_calls] == [("exec_command", 1.0, True)]
    assert second.model_calls[0].usage == {
        "prompt_tokens": 200,
        "completion_tokens": 10,
        "total_tokens": 210,
        "cached_tokens": 100,
        "cache_write_tokens": 0,
        "reasoning_tokens": 2,
    }
    assert second.model_calls[0].duration_s == 2.5  # asked for at the tool's output, recorded at 6.5
    assert profile.usage["prompt_tokens"] == 300
    assert reported == {"duration_s": 6.0, "ttft_s": 1.5}


def test_a_provider_with_a_base_url_speaks_the_responses_api() -> None:
    flags = codex._provider({"provider": "openrouter", "base_url": "https://openrouter.ai/api/v1", "api_key_env": "OPENROUTER_API_KEY"})
    assert flags[1] == 'model_provider="openrouter"'
    assert 'wire_api="responses"' in flags[3] and 'env_key="OPENROUTER_API_KEY"' in flags[3]
    assert codex._provider({"provider": "oss", "local_provider": "ollama"}) == ["--oss", "--local-provider", "ollama"]
