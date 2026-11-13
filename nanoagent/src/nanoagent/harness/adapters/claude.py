"""Translate NanoAgent's runner protocol to the local Claude Code CLI.

Claude Code runs with ``--output-format stream-json --include-partial-messages``: its events are
relayed as they arrive (streamed text and reasoning as deltas, each tool call as ``tool_start`` and
then ``tool``, each finished step as ``step``) and profiled into NanoAgent's standard profile, the
done event's ``metrics``. A model call starts when Claude Code has what it needs to make it (the run
starting, or the last result of the tools it asked for), is recorded once its stream starts, and
ends at its first tool call or its ``message_stop``, whichever comes first. Work a
subagent does belongs to the tool that started it. The run's tokens are every model's in Claude
Code's own account (``modelUsage``), which also holds the calls Claude Code makes outside the stream;
what Claude Code reports of its own clock and cost is kept as ``metrics.reported``."""

from __future__ import annotations

import time
from typing import Any

from nanoagent.harness.adapters._coding_cli import (
    aws_environment,
    emit,
    executable,
    extra_args,
    prompt,
    request_and_options,
    run_main,
    stream_child,
    workspace,
)
from nanoagent.profiler import StepProfile, StreamProfiler, accumulate_usage, messages_usage


def _command(executable_path: str, options: dict[str, Any]) -> list[str]:
    command = [
        executable_path,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        str(options.get("permission_mode", "bypassPermissions")),
    ]
    model = options.get("model")
    if isinstance(model, str) and model and model != "default":
        command.extend(["--model", model])
    return [*command, *extra_args(options)]


class _Relay:
    """Claude Code's events passed on as NanoAgent progress and recorded in the run's profile."""

    def __init__(self) -> None:
        self.profiler = StreamProfiler(clock=time.perf_counter)
        self.calls: dict[str, dict[str, Any]] = {}
        self.calling = False  # a model call is open
        # When Claude Code asked for the next call: its tools done, it sends their results at once.
        self.asked: float | None = None
        self.result: dict[str, Any] | None = None
        self.raw_usage: dict[str, Any] = {}

    def start_call(self, at: float | None = None) -> None:
        self.passed(self.profiler.model_start(at))
        self.calling = True

    @staticmethod
    def passed(step: StepProfile | None) -> None:
        """Pass on a step just closed."""
        if step is not None:
            emit({"type": "step", "step": step.step, "cost": 0.0, "usage": step.usage, "metrics": step.to_dict()})

    def __call__(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "result":
            self.result = event
            return
        if event.get("parent_tool_use_id") is not None:
            return
        if kind == "system" and event.get("subtype") == "init":
            self.start_call()
        elif kind == "stream_event":
            self.stream(event["event"])
        elif kind == "assistant":
            for block in event["message"]["content"]:
                if block.get("type") == "tool_use":
                    self.profiler.model_end()
                    self.calls[block["id"]] = block
                    self.profiler.tool_start(block["id"], block["name"])
                    emit({"type": "tool_start", "id": block["id"], "name": block["name"]})
        elif kind == "user":
            content = event["message"]["content"]
            for block in content if isinstance(content, list) else []:
                if block.get("type") == "tool_result":
                    self.tool_result(block)

    def stream(self, event: dict[str, Any]) -> None:
        kind = event["type"]
        if kind == "message_start":
            if not self.calling:
                # The call's stream shows it happened; it was in flight from when it was asked for,
                # so a run that ends after its tools has no call that never was.
                self.start_call(self.asked)
                self.asked = None
            self.raw_usage = dict(event.get("message", {}).get("usage") or {})
        elif kind == "content_block_delta":
            self.profiler.first_token()
            delta = event["delta"]
            if delta.get("type") == "text_delta":
                emit({"type": "delta", "kind": "content", "text": delta["text"]})
            elif delta.get("type") == "thinking_delta":
                emit({"type": "delta", "kind": "reasoning", "text": delta["thinking"]})
        elif kind == "message_delta":
            self.raw_usage.update(event.get("usage") or {})
            self.profiler.usage(_usage(self.raw_usage))
        elif kind == "message_stop":
            self.profiler.model_end()
            self.calling = False

    def tool_result(self, block: dict[str, Any]) -> None:
        call = self.calls[block["tool_use_id"]]
        failed = bool(block.get("is_error"))
        self.profiler.tool_end(call["id"], is_error=failed)
        content = block.get("content")
        output = content if isinstance(content, str) else "".join(part.get("text", "") for part in content or [])
        emit({"type": "tool", "id": call["id"], "name": call["name"], "arguments": call["input"], "output": output, "is_error": failed})
        if not self.profiler.tools_running:
            # Its tools done, Claude Code asks the model again with their results.
            self.asked = time.perf_counter()


def _usage(raw: dict[str, Any]) -> dict[str, int]:
    """One call's usage from Claude Code's Messages counts."""
    details = raw.get("output_tokens_details") or {}
    return messages_usage(
        raw.get("input_tokens", 0),
        raw.get("output_tokens", 0),
        raw.get("cache_read_input_tokens") or 0,
        raw.get("cache_creation_input_tokens") or 0,
        details.get("thinking_tokens"),
    )


def _model_usage(models: dict[str, Any]) -> dict[str, int]:
    """Every model's tokens in Claude Code's own account of the run."""
    total: dict[str, int] = {}
    for counts in models.values():
        accumulate_usage(
            total,
            messages_usage(
                counts["inputTokens"],
                counts["outputTokens"],
                counts["cacheReadInputTokens"],
                counts["cacheCreationInputTokens"],
                counts.get("thinkingTokens"),
            ),
        )
    return total


def _seconds(result: dict[str, Any], field: str) -> float | None:
    value = result.get(field)
    return value / 1000 if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _run(payload: dict[str, Any]) -> dict[str, Any]:
    request, options = request_and_options(payload)
    root = workspace(request)
    environment = aws_environment(options)
    provider = options.get("provider")
    if provider is not None and provider != "bedrock":
        raise ValueError("Claude Code provider must be 'bedrock' when set")
    if provider == "bedrock":
        environment["CLAUDE_CODE_USE_BEDROCK"] = "1"
    relay = _Relay()
    status, diagnostics = stream_child(
        _command(executable(options, "claude"), options),
        cwd=root,
        input_text=prompt(request) + "\n",
        on_event=relay,
        env=environment,
    )
    result = relay.result
    if result is None:
        raise RuntimeError(diagnostics or f"Claude Code exited with status {status} and no result")
    failed = bool(result.get("is_error")) or status != 0
    relay.passed(relay.profiler.close())
    profile = relay.profiler.finish(_model_usage(result["modelUsage"]))
    # Claude Code's own clock and cost: the whole run, its time on the model's API, its first token.
    reported = {
        "duration_s": _seconds(result, "duration_ms"),
        "model_s": _seconds(result, "duration_api_ms"),
        "ttft_s": _seconds(result, "ttft_ms"),
        "cost": result.get("total_cost_usd"),
        "turns": result.get("num_turns"),
        "usage_by_model": {model: _model_usage({model: counts}) for model, counts in result["modelUsage"].items()},
    }
    cost = result.get("total_cost_usd", 0.0)
    return {
        "type": "done",
        "answer": result.get("result", ""),
        "stop_reason": "error" if failed else "answer",
        "steps": len(profile.steps),
        "usage": profile.usage,
        "cost": float(cost) if isinstance(cost, (int, float)) else 0.0,
        "error": f"{result.get('result')} {diagnostics}".strip() if failed else None,
        "metrics": profile.to_dict() | {"reported": reported},
    }


def main() -> int:
    return run_main(_run, error_code="claude_error", label="Claude Code")


if __name__ == "__main__":
    raise SystemExit(main())
