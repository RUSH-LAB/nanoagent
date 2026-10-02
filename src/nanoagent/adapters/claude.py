"""Translate NanoAgent's runner protocol to the local Claude Code CLI."""

from __future__ import annotations

import json
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


def _command(executable_path: str, options: dict[str, Any]) -> list[str]:
    command = [
        executable_path,
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        str(options.get("permission_mode", "bypassPermissions")),
    ]
    model = options.get("model")
    if isinstance(model, str) and model and model != "default":
        command.extend(["--model", model])
    return [*command, *extra_args(options)]


def _run(payload: dict[str, Any]) -> dict[str, Any]:
    request, options = request_and_options(payload)
    root = workspace(request)
    stdout, _ = run_child(
        _command(executable(options, "claude"), options),
        cwd=root,
        input_text=prompt(request),
    )
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Claude Code returned invalid JSON") from error
    if not isinstance(result, dict) or not isinstance(result.get("result", ""), str):
        raise RuntimeError("Claude Code returned an invalid result")
    raw_usage = result.get("usage", {})
    usage = (
        {
            key: int(value)
            for key, value in raw_usage.items()
            if isinstance(key, str) and isinstance(value, int) and not isinstance(value, bool)
        }
        if isinstance(raw_usage, dict)
        else {}
    )
    cost = result.get("total_cost_usd", 0.0)
    steps = result.get("num_turns", 0)
    failed = bool(result.get("is_error"))
    return {
        "type": "done",
        "answer": result.get("result", ""),
        "stop_reason": "error" if failed else "answer",
        "steps": steps if isinstance(steps, int) and steps >= 0 else 0,
        "usage": usage,
        "cost": float(cost) if isinstance(cost, (int, float)) else 0.0,
        "error": str(result.get("result")) if failed else None,
    }


def main() -> int:
    return run_main(_run, error_code="claude_error", label="Claude Code")


if __name__ == "__main__":
    raise SystemExit(main())
