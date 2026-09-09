"""Translate NanoAgent's runner protocol to Hermes Agent's one-shot CLI."""

from __future__ import annotations

import json
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


def _emit(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _prompt(request: dict[str, Any]) -> str:
    task = request.get("input")
    if not isinstance(task, str) or not task.strip():
        raise ValueError("request.input must be a non-empty string")
    instructions = request.get("instructions")
    if instructions is not None and not isinstance(instructions, str):
        raise ValueError("request.instructions must be a string or null")
    messages = request.get("messages", [])
    if not isinstance(messages, list):
        raise ValueError("request.messages must be a list")
    transcript = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or message.get("role") not in {"user", "assistant"}:
            raise ValueError(f"request.messages[{index}] must have a user or assistant role")
        content = message.get("content")
        if not isinstance(content, str):
            raise ValueError(f"request.messages[{index}].content must be a string")
        transcript.append(f"{message['role'].title()}:\n{content}")
    sections = []
    if instructions and instructions.strip():
        sections.append(f"Application instructions:\n{instructions.strip()}")
    if transcript:
        sections.append("Conversation history:\n\n" + "\n\n".join(transcript))
    sections.append(f"Current user request:\n{task}")
    return "\n\n".join(sections)


def _command(executable: str, prompt: str, usage_path: str, options: dict[str, Any]) -> list[str]:
    command = [executable, "-z", prompt, "--usage-file", usage_path]
    for option, flag in (("model", "--model"), ("provider", "--provider")):
        value = options.get(option)
        if value is not None:
            if not isinstance(value, str) or not value:
                raise ValueError(f"Hermes option {option!r} must be a non-empty string")
            command.extend([flag, value])
    toolsets = options.get("toolsets")
    if toolsets is not None:
        if not isinstance(toolsets, list) or any(not isinstance(item, str) for item in toolsets):
            raise ValueError("Hermes option 'toolsets' must be a list of strings")
        command.extend(["--toolsets", ",".join(toolsets)])
    return command


def _done(answer: str, usage: dict[str, Any]) -> dict[str, Any]:
    token_fields = {
        "prompt_tokens": usage.get("input_tokens"),
        "completion_tokens": usage.get("output_tokens"),
        "total_tokens": usage.get("total_tokens"),
    }
    tokens = {
        key: value
        for key, value in token_fields.items()
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0
    }
    api_calls = usage.get("api_calls")
    steps = api_calls if isinstance(api_calls, int) and api_calls >= 0 else 0
    estimated_cost = usage.get("estimated_cost_usd")
    cost = float(estimated_cost) if isinstance(estimated_cost, (int, float)) else 0.0
    return {
        "type": "done",
        "answer": answer,
        "stop_reason": "answer",
        "steps": steps,
        "usage": tokens,
        "cost": max(cost, 0.0),
        "error": None,
    }


def _run(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("protocol") != "nanoagent.runner.v1":
        raise ValueError("unsupported runner protocol")
    request = payload.get("request")
    options = payload.get("options", {})
    if not isinstance(request, dict) or not isinstance(options, dict):
        raise ValueError("request and options must be objects")
    executable_name = options.get("executable", "hermes")
    if not isinstance(executable_name, str) or not executable_name:
        raise ValueError("Hermes option 'executable' must be a non-empty string")
    executable = shutil.which(executable_name)
    if executable is None:
        raise FileNotFoundError(
            f"Hermes executable {executable_name!r} was not found; install with "
            '`pip install "nanoagent[hermes]"` or set harness.options.executable'
        )

    usage_file = tempfile.NamedTemporaryFile(prefix="nanoagent-hermes-", suffix=".json", delete=False)
    usage_path = usage_file.name
    usage_file.close()
    child: subprocess.Popen[str] | None = None
    previous_handler = signal.getsignal(signal.SIGTERM)
    try:
        child = subprocess.Popen(
            _command(executable, _prompt(request), usage_path, options),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        def terminate_child(_signum: int, _frame: Any) -> None:
            if child is not None and child.poll() is None:
                child.terminate()
            raise SystemExit(143)

        signal.signal(signal.SIGTERM, terminate_child)
        stdout, stderr = child.communicate()
        if child.returncode != 0:
            detail = stderr.strip() or f"Hermes exited with status {child.returncode}"
            raise RuntimeError(detail)
        try:
            usage = json.loads(Path(usage_path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            usage = {}
        return _done(stdout.strip(), usage if isinstance(usage, dict) else {})
    finally:
        signal.signal(signal.SIGTERM, previous_handler)
        Path(usage_path).unlink(missing_ok=True)


def main() -> int:
    try:
        payload = json.loads(sys.stdin.readline())
        if not isinstance(payload, dict):
            raise ValueError("runner request must be a JSON object")
        _emit(_run(payload))
    except FileNotFoundError as error:
        _emit({"type": "error", "code": "runner_unavailable", "error": str(error)})
    except ValueError as error:
        _emit({"type": "error", "code": "invalid_request", "error": str(error)})
    except Exception as error:
        print(f"Hermes Agent failed: {error}", file=sys.stderr)
        _emit({"type": "error", "code": "hermes_error", "error": "Hermes Agent failed"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
