from __future__ import annotations

import json
from pathlib import Path

import pytest

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
    assert first.model_calls[0].duration_s == 2.0  # inferred end at the first tool call
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
    assert profile.ttft_s is None and profile.generation_s is None
    assert first.model_s + first.tools_s <= first.duration_s


def test_a_session_whose_every_request_failed_has_no_model_call(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    session.write_text("\n".join([_record(1.0, "task_started"), _record(2.0, "task_complete", {"duration_ms": 1000})]))
    profile, _ = codex._profile(session, codex._seconds("2026-11-10T19:00:00.000Z"), None)
    assert sum(len(step.model_calls) for step in profile.steps) == 0


def test_a_turn_that_failed_after_its_retries_is_a_step_whose_model_time_runs_to_the_failure(tmp_path: Path) -> None:
    # Codex emits no event for a request, only the turn's start and, after retrying a 401 or 5xx, its failure.
    session = tmp_path / "rollout.jsonl"
    session.write_text(_record(1.0, "task_started"))
    started = codex._seconds("2026-11-10T19:00:00.000Z")
    profile, _ = codex._profile(session, started, None, failed_at=codex._seconds("2026-11-10T19:00:14.500Z"))
    assert len(profile.steps) == 1
    assert profile.steps[0].model_calls == ()
    assert profile.steps[0].model_s == 13.5  # from the turn's start to the failure, the retries' waiting included
    assert profile.usage == {}


def test_a_failure_after_a_tool_runs_from_the_tools_output(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    session.write_text(
        "\n".join(
            [
                _record(1.0, "task_started"),
                _record(2.0, "function_call", {"call_id": "a", "name": "shell"}),
                _record(2.5, "token_usage_record"),
                _record(3.0, "function_call_output", {"call_id": "a", "output": "Process exited with code 0"}),
                _record(3.5, "token_count", {"info": {"last_token_usage": _usage(100)}}),
            ]
        )
    )
    profile, _ = codex._profile(session, codex._seconds("2026-11-10T19:00:00.000Z"), None, failed_at=codex._seconds("2026-11-10T19:00:08.000Z"))
    assert [len(step.model_calls) for step in profile.steps] == [1, 0]
    assert profile.steps[1].model_s == 5.0  # asked for at the tool's output (3.0), failed at 8.0


def test_codex_reports_the_release_it_launches(tmp_path: Path) -> None:
    assert codex._version(["npx", "-y", "@openai/codex@0.167.0"], {"package": "@openai/codex@0.167.0"}) == "0.167.0"
    with pytest.raises(ValueError, match="must pin a release"):
        codex._version(["npx"], {"package": "@openai/codex"})
    binary = tmp_path / "codex"
    binary.write_text("#!/bin/sh\necho 'codex-cli 0.167.0'\n")
    binary.chmod(0o755)
    assert codex._version([str(binary)], {}) == "codex-cli 0.167.0"  # as the binary on PATH reports it


def test_a_provider_with_a_base_url_speaks_the_responses_api() -> None:
    flags = codex._provider({"provider": "openrouter", "base_url": "https://openrouter.ai/api/v1", "api_key_env": "OPENROUTER_API_KEY"})
    assert flags[1] == 'model_provider="openrouter"'
    assert 'wire_api="responses"' in flags[3] and 'env_key="OPENROUTER_API_KEY"' in flags[3]
    assert codex._provider({"provider": "oss", "local_provider": "ollama"}) == ["--oss", "--local-provider", "ollama"]


def test_reconnect_diagnostic_is_not_terminal_failure() -> None:
    relay = codex._Relay()
    relay({"type": "error", "message": "Reconnecting"})
    relay({"type": "turn.completed", "usage": _usage(1)})
    assert relay.failure is None and relay.usage is not None


def test_codex_runs_without_the_plugin_sync_that_writes_into_its_home(tmp_path: Path) -> None:
    command = codex._command(["codex"], tmp_path, {})
    assert command[command.index("--disable") + 1] == "plugins"


def test_a_streamed_tool_keeps_the_arguments_codex_sent(capsys) -> None:
    relay = codex._Relay()
    relay({"type": "item.completed", "item": {"id": "i1", "type": "command_execution", "command": "ls -la", "aggregated_output": "x", "exit_code": 0, "status": "completed"}})
    relay({"type": "item.completed", "item": {"id": "i2", "type": "web_search", "query": "nanoagent", "status": "completed"}})
    commands, search = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert commands["arguments"] == {"command": "ls -la"}
    assert search["arguments"] == {"query": "nanoagent"}


def test_stream_child_reaps_what_the_harness_leaves_running(tmp_path: Path) -> None:
    from nanoagent.harness.adapters._coding_cli import stream_child

    pidfile = tmp_path / "background.pid"
    # The child starts a background process in its group, as Codex's plugin sync does, and exits at once.
    script = (
        "import subprocess, sys;"
        f"p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']);"
        f"open({str(pidfile)!r}, 'w').write(str(p.pid));"
        "print('{}')"
    )
    status, _ = stream_child(["python3", "-c", script], cwd=tmp_path, input_text="", on_event=lambda event: None)
    assert status == 0
    pid = int(pidfile.read_text())
    import os

    try:
        os.kill(pid, 0)
        alive = True
    except ProcessLookupError:
        alive = False
    assert not alive
