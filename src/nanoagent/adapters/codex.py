"""Translate NanoAgent's runner protocol to the local Codex CLI."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from nanoagent.adapters._coding_cli import (
    executable,
    extra_args,
    prompt,
    request_and_options,
    run_child,
    run_main,
    workspace,
)


def _command(
    executable_path: str,
    output_path: Path,
    root: Path,
    options: dict[str, Any],
) -> list[str]:
    sandbox = str(options.get("sandbox", "workspace-write"))
    if sandbox not in {"read-only", "workspace-write", "danger-full-access"}:
        raise ValueError("Codex sandbox must be read-only, workspace-write, or danger-full-access")
    command = [
        executable_path,
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        sandbox,
        "--ask-for-approval",
        "never",
        "--ephemeral",
        "--output-last-message",
        str(output_path),
        "--cd",
        str(root),
    ]
    model = options.get("model")
    if isinstance(model, str) and model and model != "default":
        command.extend(["--model", model])
    return [*command, *extra_args(options), "-"]


def _run(payload: dict[str, Any]) -> dict[str, Any]:
    request, options = request_and_options(payload)
    root = workspace(request)
    output = tempfile.NamedTemporaryFile(prefix="nanoagent-codex-", suffix=".txt", delete=False)
    output_path = Path(output.name)
    output.close()
    try:
        stdout, _ = run_child(
            _command(executable(options, "codex"), output_path, root, options),
            cwd=root,
            input_text=prompt(request),
        )
        usage: dict[str, int] = {}
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "turn.completed" and isinstance(event.get("usage"), dict):
                usage = {
                    key: int(value)
                    for key, value in event["usage"].items()
                    if isinstance(key, str)
                    and isinstance(value, int)
                    and not isinstance(value, bool)
                }
        answer = output_path.read_text(encoding="utf-8", errors="replace")
        return {
            "type": "done",
            "answer": answer.strip(),
            "stop_reason": "answer",
            "steps": 1,
            "usage": usage,
            "cost": 0.0,
            "error": None,
        }
    finally:
        output_path.unlink(missing_ok=True)


def main() -> int:
    return run_main(_run, error_code="codex_error", label="Codex CLI")


if __name__ == "__main__":
    raise SystemExit(main())
