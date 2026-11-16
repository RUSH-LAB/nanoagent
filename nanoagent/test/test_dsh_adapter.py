from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from nanoagent.harness.adapters import dsh

STEP_USAGE = {"inputTokens": 100, "outputTokens": 20, "cacheReadTokens": 40, "cacheWriteTokens": 0, "totalTokens": 160}


def _run(tmp_path: Path, events: list[dict], status: int = 0) -> dict:
    """Run the adapter on a stand-in for npx that prints ``events`` and exits with ``status``."""
    npx = tmp_path / "npx"
    stream = "\n".join(json.dumps(event) for event in events)
    # What the usage tap would record: one line per streamed response, here one per step with usage.
    tap = "\n".join(json.dumps({"output": event["usage"]["outputTokens"], "reasoning": None}) for event in events if event.get("usage", {}).get("outputTokens"))
    npx.write_text(
        "#!/bin/sh\ncat > /dev/null\n"
        + (f"cat >> \"$NANOAGENT_DSH_USAGE\" <<'EOF'\n{tap}\nEOF\n" if tap else "")
        + f"cat <<'EOF'\n{stream}\nEOF\necho 'dsh: diagnostics' >&2\nexit {status}\n"
    )
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
    assert done["version"] == "0.2.2-rc.1"  # the release the pinned package names
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
    # A step with no usage is a failed request, which is no model call.
    assert [len(step["model_calls"]) for step in done["metrics"]["steps"]] == [0]


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


def test_a_base_url_moves_the_pi_ai_route_to_that_endpoint(tmp_path: Path) -> None:
    options = {
        "package": "@deepseek-ai/dsh@0.2.2-rc.1",
        "model": "deepseek/deepseek-v4-flash-0731",
        "provider": "openrouter",
        "api_key_env": "OPENROUTER_API_KEY",
        "base_url": "http://127.0.0.1:8080/api/v1",
    }
    command = dsh._command("npx", tmp_path, options)
    patch = Path(command[command.index("--patch") + 1]).read_text()
    assert 'apiKeyEnv: "OPENROUTER_API_KEY"\n        baseURL: "http://127.0.0.1:8080/api/v1"\n' in patch


def test_a_thinking_level_is_the_default_models_reasoning_effort(tmp_path: Path) -> None:
    options = {
        "package": "@deepseek-ai/dsh@0.2.2-rc.1",
        "model": "deepseek/deepseek-v4-flash-0731",
        "provider": "openrouter",
        "api_key_env": "OPENROUTER_API_KEY",
        "thinking_level": "medium",
    }
    command = dsh._command("npx", tmp_path, options)
    patch = Path(command[command.index("--patch") + 1]).read_text()
    assert 'model: "deepseek/deepseek-v4-flash-0731"\n    reasoningEffort: "medium"\n' in patch
    assert 'models:\n          - id: "deepseek/deepseek-v4-flash-0731"\n            reasoningEfforts:\n              "medium": "medium"\n' in patch


def test_a_thinking_level_without_a_model_fails(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="thinking_level needs a provider and a model"):
        dsh._command("npx", tmp_path, {"package": "@deepseek-ai/dsh@0.2.2-rc.1", "thinking_level": "medium"})


def test_a_base_url_without_a_provider_fails(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="need a provider"):
        dsh._command("npx", tmp_path, {"package": "@deepseek-ai/dsh@0.2.2-rc.1", "base_url": "http://127.0.0.1:8080/api/v1"})


def _step_end(relay: dsh._Relay, step: int, output_tokens: int) -> None:
    relay({"type": "status", "phase": "step_start", "turn": 1, "step": step})
    relay({"type": "status", "phase": "step_end", "turn": 1, "step": step, "usage": {**STEP_USAGE, "outputTokens": output_tokens}})


def test_a_steps_reasoning_tokens_are_what_the_provider_reported_on_its_request(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # dsh's events omit a pi-ai route's reasoning tokens; the tap records them from each streamed response.
    tap = tmp_path / "usage.jsonl"
    tap.write_text('{"output": 50, "reasoning": 20}\n{"output": 30, "reasoning": 0}\n')
    relay = dsh._Relay(tap)
    _step_end(relay, 1, 50)
    _step_end(relay, 2, 30)
    steps = [event["usage"] for event in _progress(capsys) if event["type"] == "step"]
    assert [step["reasoning_tokens"] for step in steps] == [20, 0]


def test_a_step_without_a_recorded_request_fails_the_run(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="dsh finished step 1 with usage but no streamed response recorded it"):
        _step_end(dsh._Relay(tmp_path / "usage.jsonl"), 1, 20)


def test_a_request_that_does_not_match_its_step_fails_the_run(tmp_path: Path) -> None:
    tap = tmp_path / "usage.jsonl"
    tap.write_text('{"output": 51, "reasoning": 20}\n')
    with pytest.raises(RuntimeError, match="reported 50 output tokens but its request carried 51"):
        _step_end(dsh._Relay(tap), 1, 50)


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_the_usage_tap_records_the_provider_usage_of_an_event_stream_without_changing_it(tmp_path: Path) -> None:
    chunks = [
        'data: {"choices": [{"delta": {"content": "hi"}}]}\n\n',
        'data: {"choices": [], "usage": {"completion_tokens": 50, "completion_tokens_details": {"reasoning_tokens": 20}}}\n\n',
        "data: [DONE]\n\n",
    ]
    # A stand-in provider is installed before the tap wraps it; the script reads the stream as the client does.
    script = tmp_path / "tap.cjs"
    script.write_text(
        f"""
globalThis.fetch = async () => new Response({json.dumps("".join(chunks))}, {{ headers: {{ "content-type": "text/event-stream" }} }});
{dsh._USAGE_TAP}
fetch("http://provider").then((response) => response.text()).then((text) => console.log(JSON.stringify(text)));
""",
        encoding="utf-8",
    )
    tap = tmp_path / "usage.jsonl"
    done = subprocess.run(["node", str(script)], env={**os.environ, "NANOAGENT_DSH_USAGE": str(tap)}, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout) == "".join(chunks)
    assert tap.read_text() == '{"output":50,"reasoning":20}\n'


def test_a_failed_run_reports_the_version_with_its_error(tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
    npx = tmp_path / "npx"
    npx.write_text('#!/bin/sh\ncat > /dev/null\necho \'{"type":"error","message":"unknown session"}\'\nexit 1\n')
    npx.chmod(0o755)
    payload = {
        "protocol": "nanoagent.runner.v1",
        "request": {"input": "hi", "messages": [], "instructions": None, "metadata": None, "workspace": str(tmp_path)},
        "options": {"executable": str(npx), "model": "deepseek-flash", "package": "@deepseek-ai/dsh@0.2.2-rc.1"},
    }
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps(payload) + "\n"))
    assert dsh.main() == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out.splitlines()[-1]) == {
        "type": "error",
        "code": "dsh_error",
        "error": "DeepSeek Harness failed",
        "version": "0.2.2-rc.1",
    }


def test_a_step_whose_request_the_provider_refused_is_a_failed_step_with_the_providers_status(tmp_path: Path) -> None:
    # dsh closes the step of a 401'd request with zero usage and no stream: no call, but a step with its model time.
    refused = {"message": "401: User not found.", "code": "AUTH"}
    done = _run(
        tmp_path,
        [
            {"type": "status", "phase": "step_start", "turn": 1, "step": 1},
            {"type": "status", "phase": "step_end", "turn": 1, "step": 1, "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}},
            {"type": "final", "sessionId": "session-1", "reason": {"kind": "error", "error": refused}, "text": ""},
        ],
        status=1,
    )
    assert done["stop_reason"] == "error"
    assert done["steps"] == 1
    assert "401: User not found." in done["error"]
    assert "no usage" not in done["error"]
    assert [len(step["model_calls"]) for step in done["metrics"]["steps"]] == [0]
    assert done["metrics"]["model_s"] > 0 and done["metrics"]["steps"][0]["model_s"] == done["metrics"]["model_s"]
