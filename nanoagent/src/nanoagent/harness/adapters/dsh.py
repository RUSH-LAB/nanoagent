"""Translate NanoAgent's runner protocol to DeepSeek Harness (dsh) in headless mode.

dsh runs one task with ``--json`` and its own ``DSH_HOME``, which lives only for the run. Its event
stream is relayed as it arrives (committed text and reasoning as deltas, each tool call as
``tool_start`` and then ``tool``, each finished step as ``step``) and profiled as it arrives into
NanoAgent's standard profile, the done event's ``metrics``. dsh's side call that titles the session
is turned off, so the steps' tokens are all the run's."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from nanoagent.harness.adapters._coding_cli import (
    emit,
    executable,
    extra_args,
    prompt,
    request_and_options,
    run_main,
    stream_child,
    workspace,
)
from nanoagent.profiler import StreamProfiler, messages_usage


def _string(options: dict[str, Any], name: str) -> str | None:
    value = options.get(name)
    if value is not None and (not isinstance(value, str) or not value):
        raise ValueError(f"dsh option {name} must be a non-empty string")
    return value


def _command(npx: str, home: Path, options: dict[str, Any]) -> list[str]:
    # A patch layer over the headless profile: no title call, and the route and model fresh agents
    # start on. Without a provider, dsh's own DeepSeek route (DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL);
    # with one, that route of pi-ai's catalog (e.g. openrouter), keyed by the variable api_key_env names.
    patch = "- id: session-title-llm\n  disabled: true\n"
    model, provider, key = _string(options, "model"), _string(options, "provider"), _string(options, "api_key_env")
    if provider is None:
        if key is not None:
            raise ValueError("dsh option api_key_env needs a provider; the DeepSeek route reads DEEPSEEK_API_KEY")
        route = "deepseek-official"
    else:
        if key is None or model is None or model == "default":
            raise ValueError(f"dsh on provider {provider} needs options api_key_env and model")
        patch += f"- id: llm-pi-ai\n  config:\n    providers:\n      {json.dumps(provider)}:\n        apiKeyEnv: {json.dumps(key)}\n"
        route = provider
    if model is not None and model != "default":
        patch += f"- id: agent-default-model\n  config:\n    provider: {json.dumps(route)}\n    model: {json.dumps(model)}\n"
    patch_path = home / "run.patch.yml"
    patch_path.write_text(patch, encoding="utf-8")
    package = options.get("package")
    if not isinstance(package, str) or not package:
        raise ValueError("dsh option package must name the dsh release npx runs, e.g. @deepseek-ai/dsh@0.2.2-rc.1")
    command = [npx, "-y", package, "--profile", "headless", "--patch", str(patch_path)]
    # Headless has no one to approve a call: a call that needs approval is refused, not left waiting.
    return [*command, "--json", "--approval-policy", "never", *extra_args(options), "-"]


class _Relay:
    """dsh's events passed on as NanoAgent progress and recorded in the run's profile.

    dsh reports a model call when it commits it, with no streamed tokens: a call runs from its
    step's start to its first committed text, reasoning or tool call, and has no time to first token.
    """

    def __init__(self) -> None:
        self.profiler = StreamProfiler()
        self.calls: dict[str, dict[str, Any]] = {}
        self.unmetered: list[int] = []

    def __call__(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind in {"text", "thinking", "tool_call"}:
            self.profiler.model_end()
        if kind in {"text", "thinking"}:
            emit({"type": "delta", "kind": "content" if kind == "text" else "reasoning", "text": event["text"]})
        elif kind == "tool_call":
            self.calls[event["callId"]] = event
            self.profiler.tool_start(event["callId"], event["tool"])
            emit({"type": "tool_start", "id": event["callId"], "name": event["tool"]})
        elif kind == "tool_result":
            call = self.calls[event["callId"]]
            failed = event["status"] != "completed"
            self.profiler.tool_end(event["callId"], is_error=failed)
            emit(
                {
                    "type": "tool",
                    "id": event["callId"],
                    "name": call["tool"],
                    "arguments": call["input"],
                    "output": event["result"],
                    "is_error": failed,
                }
            )
        elif kind == "status" and event.get("phase") == "step_start":
            self.profiler.model_start()
        elif kind == "status" and event.get("phase") == "step_end":
            self.profiler.model_end()
            # dsh leaves out a step's usage when it is not known whole, e.g. a request that failed.
            if "usage" in event:
                raw = event["usage"]
                self.profiler.usage(
                    messages_usage(
                        raw["inputTokens"],
                        raw["outputTokens"],
                        raw.get("cacheReadTokens", 0),
                        raw.get("cacheWriteTokens", 0),
                        raw.get("reasoningTokens"),
                    )
                )
            else:
                self.unmetered.append(event["step"])
            step = self.profiler.close()
            assert step is not None
            emit({"type": "step", "step": step.step, "cost": 0.0, "usage": step.usage, "metrics": step.to_dict()})


def _run(payload: dict[str, Any]) -> dict[str, Any]:
    request, options = request_and_options(payload)
    root = workspace(request)
    npx = executable(options, "npx")
    relay = _Relay()
    final: dict[str, Any] | None = None

    def on_event(event: dict[str, Any]) -> None:
        nonlocal final
        if event.get("type") == "error":
            raise RuntimeError(f"dsh failed: {event.get('message')}")
        if event.get("type") == "final":
            final = event
        else:
            relay(event)

    with tempfile.TemporaryDirectory(prefix="nanoagent-dsh-") as home:
        status, diagnostics = stream_child(
            _command(npx, Path(home), options),
            cwd=root,
            input_text=prompt(request),
            on_event=on_event,
            env={"DSH_HOME": home},
        )
    if final is None:
        raise RuntimeError(diagnostics or f"dsh exited with status {status} and no final event")
    reason = final["reason"]
    completed = status == 0 and isinstance(reason, dict) and reason.get("kind") == "completed"
    problems = [] if completed else [f"dsh ended with status {status}, reason {json.dumps(reason)}: {diagnostics}"]
    if relay.unmetered:
        problems.append(f"dsh reported no usage for step(s) {relay.unmetered}, so the tokens are incomplete")
    error = "; ".join(problems) or None
    profile = relay.profiler.finish()
    return {
        "type": "done",
        "answer": final["text"],
        "stop_reason": "error" if error else "answer",
        "steps": len(profile.steps),
        "usage": profile.usage,
        "cost": 0.0,
        "error": error,
        "metrics": profile.to_dict() | {"reported": None},
    }


def main() -> int:
    return run_main(_run, error_code="dsh_error", label="DeepSeek Harness")


if __name__ == "__main__":
    raise SystemExit(main())
