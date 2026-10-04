"""Shared plumbing for coding-CLI harness adapters."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, Sequence


def emit(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def request_and_options(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    if payload.get("protocol") != "nanoagent.runner.v1":
        raise ValueError("unsupported runner protocol")
    request = payload.get("request")
    options = payload.get("options", {})
    if not isinstance(request, dict) or not isinstance(options, dict):
        raise ValueError("request and options must be objects")
    if not isinstance(request.get("input"), str) or not request["input"].strip():
        raise ValueError("request.input must be a non-empty string")
    return request, options


def workspace(request: dict[str, Any]) -> Path:
    value = request.get("workspace")
    if not isinstance(value, str) or not value:
        raise ValueError("coding CLI runs require request.workspace")
    root = Path(value).resolve()
    if not root.is_dir():
        raise ValueError(f"request.workspace does not exist: {root}")
    return root


def prompt(request: dict[str, Any]) -> str:
    sections: list[str] = []
    instructions = request.get("instructions")
    if instructions is not None and not isinstance(instructions, str):
        raise ValueError("request.instructions must be a string or null")
    if instructions and instructions.strip():
        sections.append(instructions.strip())
    messages = request.get("messages", [])
    if not isinstance(messages, list):
        raise ValueError("request.messages must be a list")
    if messages:
        transcript: list[str] = []
        for index, message in enumerate(messages):
            if not isinstance(message, dict) or message.get("role") not in {"user", "assistant"}:
                raise ValueError(f"request.messages[{index}] must have a user or assistant role")
            content = message.get("content")
            if not isinstance(content, str):
                raise ValueError(f"request.messages[{index}].content must be a string")
            transcript.append(f"{message['role'].title()}:\n{content}")
        sections.append("Conversation history:\n\n" + "\n\n".join(transcript))
    sections.append(request["input"])
    return "\n\n".join(sections)


def executable(options: dict[str, Any], default: str) -> str:
    name = options.get("executable", default)
    if not isinstance(name, str) or not name:
        raise ValueError("harness option executable must be a non-empty string")
    resolved = shutil.which(name)
    if resolved is None:
        raise FileNotFoundError(f"coding CLI executable was not found: {name}")
    return resolved


def extra_args(options: dict[str, Any]) -> list[str]:
    value = options.get("extra_args", [])
    if not isinstance(value, list) or any(not isinstance(arg, str) for arg in value):
        raise ValueError("harness option extra_args must be a list of strings")
    return list(value)


def aws_environment(options: dict[str, Any]) -> dict[str, str]:
    """AWS variables declared by a server-owned harness profile."""
    environment: dict[str, str] = {}
    for option, variable in (
        ("aws_region", "AWS_REGION"),
        ("aws_profile", "AWS_PROFILE"),
    ):
        value = options.get(option)
        if value is not None:
            if not isinstance(value, str) or not value:
                raise ValueError(f"harness option {option} must be a non-empty string")
            environment[variable] = value
    return environment


def run_child(
    argv: Sequence[str],
    *,
    cwd: Path,
    input_text: str,
    env: dict[str, str] | None = None,
) -> tuple[str, str]:
    child: subprocess.Popen[str] | None = None
    previous_handler = signal.getsignal(signal.SIGTERM)
    try:
        child = subprocess.Popen(
            list(argv),
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=os.environ | (env or {}),
        )

        def terminate_child(_signum: int, _frame: Any) -> None:
            if child is not None and child.poll() is None:
                child.terminate()
            raise SystemExit(143)

        signal.signal(signal.SIGTERM, terminate_child)
        stdout, stderr = child.communicate(input_text + "\n")
        if child.returncode != 0:
            detail = stderr.strip()[-8000:] or f"coding CLI exited with status {child.returncode}"
            raise RuntimeError(detail)
        return stdout, stderr
    finally:
        signal.signal(signal.SIGTERM, previous_handler)


def run_main(
    run_fn: Callable[[dict[str, Any]], dict[str, Any]],
    *,
    error_code: str,
    label: str,
) -> int:
    """Shared stdin/stdout entry point for coding-CLI companion adapters.

    Reads one ``nanoagent.runner.v1`` request line, runs it, and emits the terminal
    event — ``done`` on success, ``error`` otherwise. The only per-adapter inputs are
    the failure label: ``FileNotFoundError`` (missing executable) and ``ValueError``
    (bad request) map to stable codes, anything else is the adapter's own error.
    """
    try:
        payload = json.loads(sys.stdin.readline())
        if not isinstance(payload, dict):
            raise ValueError("runner request must be a JSON object")
        emit(run_fn(payload))
    except FileNotFoundError as error:
        emit({"type": "error", "code": "runner_unavailable", "error": str(error)})
    except ValueError as error:
        emit({"type": "error", "code": "invalid_request", "error": str(error)})
    except Exception as error:
        print(f"{label} failed: {error}", file=sys.stderr)
        emit({"type": "error", "code": error_code, "error": f"{label} failed"})
    return 0
