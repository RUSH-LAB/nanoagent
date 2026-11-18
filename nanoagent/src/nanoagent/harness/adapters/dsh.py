"""Translate NanoAgent's runner protocol to DeepSeek Harness (dsh) in headless mode.

dsh runs one task with ``--json`` and its own ``DSH_HOME``, which lives only for the run. Its event
stream is relayed as it arrives (committed text and reasoning as deltas, each tool call as
``tool_start`` and then ``tool``, each finished step as ``step``) and profiled as it arrives into
NanoAgent's standard profile, the done event's ``metrics``. dsh's side call that titles the session
is turned off, so the steps' tokens are all the run's.

dsh's events leave out a pi-ai route's reasoning tokens (its pi-ai usage mapping drops them), so a
preload on the dsh process records each streamed response's own usage, and the reasoning tokens of a
step are the provider's number for that step's request."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from nanoagent.harness.adapters._coding_cli import (
    emit,
    executable,
    extra_args,
    package_version,
    prompt,
    reporting_version,
    request_and_options,
    run_main,
    stream_child,
    workspace,
)
from nanoagent.profiler import StreamProfiler, messages_usage


# Loaded into the dsh process with NODE_OPTIONS. It passes every event stream through unchanged and, as
# a stream ends, appends the usage the provider reported on it, which dsh's events do not carry whole.
_USAGE_TAP = """\
const { appendFileSync } = require("node:fs");
const send = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await send(...args);
  if (!response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response;
  const decoder = new TextDecoder();
  let pending = "";
  let usage;
  let recorded = false;
  // The client stops reading at [DONE] and cancels the stream, so the usage is recorded there.
  const record = () => {
    if (recorded || usage?.completion_tokens === undefined) return;
    recorded = true;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? null;
    appendFileSync(process.env.NANOAGENT_DSH_USAGE, JSON.stringify({ output: usage.completion_tokens, reasoning }) + "\\n");
  };
  const tap = new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\\n");
      pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith("data: [DONE]")) record();
        else if (line.startsWith("data: {")) usage = JSON.parse(line.slice(6)).usage ?? usage;
      }
      controller.enqueue(chunk);
    },
    flush: record,
  });
  return new Response(response.body.pipeThrough(tap), response);
};
"""


def _string(options: dict[str, Any], name: str) -> str | None:
    value = options.get(name)
    if value is not None and (not isinstance(value, str) or not value):
        raise ValueError(f"dsh option {name} must be a non-empty string")
    return value


def _package(options: dict[str, Any]) -> str:
    package = options.get("package")
    if not isinstance(package, str) or not package:
        raise ValueError("dsh option package must name the dsh release npx runs, e.g. @deepseek-ai/dsh@0.2.2-rc.1")
    return package


def _command(npx: str, home: Path, options: dict[str, Any]) -> list[str]:
    # A patch layer over the headless profile: no title call, and the route and model fresh agents
    # start on. Without a provider, dsh's own DeepSeek route (DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL);
    # with one, that route of pi-ai's catalog (e.g. openrouter), keyed by the variable api_key_env names
    # and, with base_url, at that endpoint instead of the catalog's.
    patch = "- id: session-title-llm\n  disabled: true\n"
    model, provider, key = _string(options, "model"), _string(options, "provider"), _string(options, "api_key_env")
    base_url, thinking = _string(options, "base_url"), _string(options, "thinking_level")
    if thinking is not None and (provider is None or model is None or model == "default"):
        raise ValueError("dsh option thinking_level needs a provider and a model: dsh's reasoning effort belongs to the default model selection")
    if provider is None:
        if key is not None or base_url is not None:
            raise ValueError("dsh options api_key_env and base_url need a provider; the DeepSeek route reads DEEPSEEK_API_KEY")
        route = "deepseek-official"
    else:
        if key is None or model is None or model == "default":
            raise ValueError(f"dsh on provider {provider} needs options api_key_env and model")
        patch += f"- id: llm-pi-ai\n  config:\n    providers:\n      {json.dumps(provider)}:\n        apiKeyEnv: {json.dumps(key)}\n"
        if base_url is not None:
            patch += f"        baseURL: {json.dumps(base_url)}\n"
        if thinking is not None:
            # The route's catalog may not describe this model, and dsh refuses an effort the model does not
            # declare, so the model is declared with the level as its one reasoning effort (wire spelling
            # included), alongside what the default selection below then asks for.
            patch += f"        models:\n          - id: {json.dumps(model)}\n            reasoningEfforts:\n              {json.dumps(thinking)}: {json.dumps(thinking)}\n"
        route = provider
    if model is not None and model != "default":
        patch += f"- id: agent-default-model\n  config:\n    provider: {json.dumps(route)}\n    model: {json.dumps(model)}\n"
        if thinking is not None:
            patch += f"    reasoningEffort: {json.dumps(thinking)}\n"
    patch_path = home / "run.patch.yml"
    patch_path.write_text(patch, encoding="utf-8")
    command = [npx, "-y", _package(options), "--profile", "headless", "--patch", str(patch_path)]
    # Headless has no one to approve a call: a call that needs approval is refused, not left waiting.
    return [*command, "--json", "--approval-policy", "never", *extra_args(options), "-"]


class _Relay:
    """dsh's events passed on as NanoAgent progress and recorded in the run's profile.

    dsh reports a model call when it commits it, with no streamed tokens: a call runs from its
    step's start to its first committed text, reasoning or tool call, and has no time to first token.
    """

    def __init__(self, tap: Path) -> None:
        self.tap = tap
        self.requests = 0
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
        elif kind == "status" and event.get("phase") == "step_end" and self._request_failed(event):
            # dsh closes a step whose request the provider refused (e.g. a 401) with all-zero usage and no
            # streamed response: a failed attempt, not a call. Its time is the step's model time, and the
            # provider's status and message are in the final event's reason.
            self.profiler.model_end(error="the provider refused the request")
            step = self.profiler.close()
            assert step is not None
            emit({"type": "step", "step": step.step, "cost": 0.0, "usage": step.usage, "metrics": step.to_dict()})
        elif kind == "status" and event.get("phase") == "step_end":
            # dsh leaves out a step's usage when it is not known whole, e.g. a request that failed: that
            # step's call is a failed attempt, which the profile does not count as a model call.
            self.profiler.model_end(error=None if "usage" in event else "dsh reported no usage for the step")
            if "usage" in event:
                raw = event["usage"]
                self.profiler.usage(
                    messages_usage(
                        raw["inputTokens"],
                        raw["outputTokens"],
                        raw.get("cacheReadTokens", 0),
                        raw.get("cacheWriteTokens", 0),
                        self._reasoning(raw["outputTokens"]),
                    )
                )
            else:
                self.unmetered.append(event["step"])
            step = self.profiler.close()
            assert step is not None
            emit({"type": "step", "step": step.step, "cost": 0.0, "usage": step.usage, "metrics": step.to_dict()})

    def _recorded(self) -> list[str]:
        return self.tap.read_text(encoding="utf-8").splitlines() if self.tap.exists() else []

    def _request_failed(self, event: dict[str, Any]) -> bool:
        """Whether a step's end reports a request that returned no stream: zero usage, nothing recorded."""
        usage = event.get("usage")
        return usage is not None and not usage["inputTokens"] and not usage["outputTokens"] and len(self._recorded()) == self.requests

    def _reasoning(self, output_tokens: int) -> int | None:
        """The reasoning tokens the provider reported on the next streamed request, which is this step's."""
        lines = self._recorded()
        if self.requests == len(lines):
            raise RuntimeError(f"dsh finished step {self.requests + 1} with usage but no streamed response recorded it")
        request = json.loads(lines[self.requests])
        self.requests += 1
        if request["output"] != output_tokens:
            raise RuntimeError(f"dsh step reported {output_tokens} output tokens but its request carried {request['output']}")
        return request["reasoning"]


def _run(payload: dict[str, Any]) -> dict[str, Any]:
    request, options = request_and_options(payload)
    root = workspace(request)
    npx = executable(options, "npx")
    version = package_version(_package(options))
    with reporting_version(version):
        return _stream(request, options, root, npx, version)


def _stream(request: dict[str, Any], options: dict[str, Any], root: Path, npx: str, version: str) -> dict[str, Any]:
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
        tap = Path(home) / "usage.jsonl"
        (Path(home) / "usage_tap.cjs").write_text(_USAGE_TAP, encoding="utf-8")
        relay = _Relay(tap)
        status, diagnostics = stream_child(
            _command(npx, Path(home), options),
            cwd=root,
            input_text=prompt(request),
            on_event=on_event,
            env={
                "DSH_HOME": home,
                "NANOAGENT_DSH_USAGE": str(tap),
                "NODE_OPTIONS": f"--require={Path(home) / 'usage_tap.cjs'} {os.environ.get('NODE_OPTIONS', '')}".strip(),
            },
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
        "version": version,
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
