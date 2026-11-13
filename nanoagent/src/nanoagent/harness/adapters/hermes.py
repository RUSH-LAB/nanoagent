"""Translate NanoAgent's runner protocol to Hermes Agent's one-shot run, profiled.

Hermes runs in this process the way ``hermes -z`` runs it (``hermes_cli.oneshot``: its config, its
provider resolution, its tools, approvals off), with its agent watched as it works: every request to
the model, timed around Hermes's own request methods with the usage Hermes reads from its response,
and every tool through Hermes's tool callbacks, failed when Hermes itself would call it failed. Its
events are relayed as they happen and profiled into NanoAgent's standard profile, the done event's
``metrics``; the run's tokens are Hermes's own account of them, and its estimated cost is kept as
``metrics.reported``."""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
from contextlib import redirect_stderr, redirect_stdout
from typing import Any, TextIO

from nanoagent.harness.adapters._coding_cli import run_main, workspace
from nanoagent.profiler import StreamProfiler, messages_usage


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


def _option(options: dict[str, Any], name: str) -> str | None:
    value = options.get(name)
    if value is not None and (not isinstance(value, str) or not value):
        raise ValueError(f"Hermes option {name!r} must be a non-empty string")
    return value


class _Relay:
    """Hermes's work passed on as NanoAgent progress and recorded in the run's profile. Hermes may run
    tools on threads, so each event is handled whole under one lock."""

    def __init__(self, out: TextIO) -> None:
        self.out = out
        self.profiler = StreamProfiler()
        self.lock = threading.Lock()
        self.depth = 0  # a request method may call the other: only the outer one is the request
        self.agent: Any = None  # Hermes's agent, once it is built

    def emit(self, event: dict[str, Any]) -> None:
        self.out.write(json.dumps(event, separators=(",", ":")) + "\n")
        self.out.flush()

    def request(self, call: Any, *, on_first_delta: Any = None) -> Any:
        """Run one of Hermes's requests to the model, timed."""
        with self.lock:
            self.depth += 1
            if self.depth == 1:
                step = self.profiler.model_start()
                if step is not None:
                    self.emit({"type": "step", "step": step.step, "cost": 0.0, "usage": step.usage, "metrics": step.to_dict()})

        def first_delta() -> None:
            with self.lock:
                self.profiler.first_token()
            if on_first_delta is not None:
                on_first_delta()

        try:
            response = call(first_delta)
        except BaseException as error:
            with self.lock:
                self.depth -= 1
                if self.depth == 0:
                    self.profiler.model_end(error=str(error) or type(error).__name__)
            raise
        with self.lock:
            self.depth -= 1
            if self.depth == 0:
                self.profiler.model_end(usage=self.response_usage(response))
        return response

    def response_usage(self, response: Any) -> dict[str, int] | None:
        from agent.usage_pricing import normalize_usage

        raw = getattr(response, "usage", None)
        if not raw:
            return None
        usage = normalize_usage(raw, provider=self.agent.provider, api_mode=self.agent.api_mode)
        return messages_usage(usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens, usage.reasoning_tokens)

    def tool_start(self, call_id: str, name: str, arguments: Any) -> None:
        with self.lock:
            self.profiler.tool_start(call_id, name)
            self.emit({"type": "tool_start", "id": call_id, "name": name})

    def tool_complete(self, call_id: str, name: str, arguments: Any, result: Any) -> None:
        from agent.display import _detect_tool_failure

        failed, _ = _detect_tool_failure(name, result if isinstance(result, str) else None)
        with self.lock:
            self.profiler.tool_end(call_id, is_error=failed)
            output = result if isinstance(result, str) else json.dumps(result, default=str)
            self.emit({"type": "tool", "id": call_id, "name": name, "arguments": arguments, "output": output, "is_error": failed})


def _profiled_agent(relay: _Relay) -> type:
    """Hermes's agent, its requests to the model timed and its tools reported to ``relay``."""
    from run_agent import AIAgent

    class ProfiledAgent(AIAgent):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            relay.agent = self
            self.tool_start_callback = relay.tool_start
            self.tool_complete_callback = relay.tool_complete

        def _interruptible_api_call(self, api_kwargs: dict) -> Any:
            return relay.request(lambda _first: super(ProfiledAgent, self)._interruptible_api_call(api_kwargs))

        def _interruptible_streaming_api_call(self, api_kwargs: dict, *, on_first_delta: Any = None) -> Any:
            return relay.request(
                lambda first: super(ProfiledAgent, self)._interruptible_streaming_api_call(api_kwargs, on_first_delta=first),
                on_first_delta=on_first_delta,
            )

    return ProfiledAgent


def _run(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("protocol") != "nanoagent.runner.v1":
        raise ValueError("unsupported runner protocol")
    request = payload.get("request")
    options = payload.get("options", {})
    if not isinstance(request, dict) or not isinstance(options, dict):
        raise ValueError("request and options must be objects")
    model, provider = _option(options, "model"), _option(options, "provider")
    if provider is not None and model is None:
        raise ValueError("Hermes option 'provider' needs a model")
    toolsets = options.get("toolsets")
    if toolsets is not None and (not isinstance(toolsets, list) or any(not isinstance(item, str) for item in toolsets)):
        raise ValueError("Hermes option 'toolsets' must be a list of strings")
    # The profile's clock starts before Hermes loads, as other harnesses' start before they boot.
    relay = _Relay(sys.stdout)
    try:
        import run_agent
        from gateway.session_context import declare_stateless_channel
        from hermes_cli import oneshot
    except ImportError as error:
        raise FileNotFoundError(f'Hermes Agent is not installed: install with `pip install "nanoagent[hermes]"` ({error})') from None

    # Hermes works in the workspace: its shell and file tools start from TERMINAL_CWD.
    root = workspace(request)
    os.chdir(root)
    os.environ["TERMINAL_CWD"] = str(root)
    # As `hermes -z` sets itself up: no one approves anything, and nothing runs in the background.
    os.environ["HERMES_YOLO_MODE"] = "1"
    os.environ["HERMES_ACCEPT_HOOKS"] = "1"
    declare_stateless_channel()
    logging.disable(logging.CRITICAL)
    shipped = run_agent.AIAgent
    run_agent.AIAgent = _profiled_agent(relay)
    try:
        # Hermes prints as it works; the runner protocol owns stdout.
        with open(os.devnull, "w", encoding="utf-8") as devnull, redirect_stdout(devnull), redirect_stderr(devnull):
            answer, result = oneshot._run_agent(
                _prompt(request),
                model=model,
                provider=provider,
                toolsets=toolsets,
                use_config_toolsets=toolsets is None,
            )
    finally:
        run_agent.AIAgent = shipped
    with relay.lock:
        step = relay.profiler.close()
        if step is not None:
            relay.emit({"type": "step", "step": step.step, "cost": 0.0, "usage": step.usage, "metrics": step.to_dict()})
    total = messages_usage(
        result.get("input_tokens") or 0,
        result.get("output_tokens") or 0,
        result.get("cache_read_tokens") or 0,
        result.get("cache_write_tokens") or 0,
        result.get("reasoning_tokens"),
    )
    profile = relay.profiler.finish(total)
    failed = bool(result.get("failed")) or not answer.strip()
    cost = result.get("estimated_cost_usd")
    return {
        "type": "done",
        "answer": answer,
        "stop_reason": "error" if failed else "answer",
        "steps": len(profile.steps),
        "usage": profile.usage,
        "cost": float(cost) if isinstance(cost, (int, float)) and cost > 0 else 0.0,
        "error": (result.get("error") or "Hermes produced no answer") if failed else None,
        "metrics": profile.to_dict() | {"reported": {"cost": cost, "cost_status": result.get("cost_status"), "api_calls": result.get("api_calls")}},
    }


def main() -> int:
    return run_main(_run, error_code="hermes_error", label="Hermes Agent")


if __name__ == "__main__":
    raise SystemExit(main())
