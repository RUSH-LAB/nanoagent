"""Translate NanoAgent's runner protocol to the Codex CLI (``codex exec --json``).

Codex runs with a ``CODEX_HOME`` of its own that lives only for the run, from ``codex`` on PATH or,
with the ``package`` option, a pinned release through npx. It reaches its model by ``provider``:
none for the OpenAI login in ``~/.codex``; ``bedrock``; ``oss`` for a local model through Ollama or
LM Studio (``local_provider``); or any other name with ``base_url`` and ``api_key_env``, a provider
that serves the Responses API (Codex speaks no other), e.g. OpenRouter for open models.

Its events are relayed as they arrive (messages and reasoning as deltas, each tool as ``tool_start``
and then ``tool``). The run's standard profile, the done event's ``metrics``, is built afterwards
from the session Codex records, on Codex's own clock: a model call runs from the turn's start, or
from the last output of the tools it asked for, to Codex's record of the response, with the usage
Codex counted for it; Codex's own time to first token and duration are kept as ``metrics.reported``.
"""

from __future__ import annotations

import json
import re
import shutil
import tempfile
from datetime import datetime
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
from nanoagent.profiler import RunProfile, StreamProfiler

# Codex's tools report a process's exit like this in their output.
EXIT = re.compile(r"Process exited with code (-?\d+)")
TOOL_CALLS = {"function_call", "custom_tool_call", "local_shell_call"}
TOOL_OUTPUTS = {"function_call_output", "custom_tool_call_output", "local_shell_call_output"}
STREAMED_TOOLS = {"command_execution", "file_change", "mcp_tool_call", "web_search"}


def _string(options: dict[str, Any], name: str) -> str | None:
    value = options.get(name)
    if value is not None and (not isinstance(value, str) or not value):
        raise ValueError(f"Codex option {name} must be a non-empty string")
    return value


def _provider(options: dict[str, Any]) -> list[str]:
    """The flags that point Codex at its model's provider."""
    provider = _string(options, "provider")
    if provider is None:
        return []
    if provider == "bedrock":
        region, profile = _string(options, "aws_region"), _string(options, "aws_profile")
        if region is None:
            raise ValueError("Codex Bedrock profiles require aws_region")
        flags = ["-c", 'model_provider="amazon-bedrock"', "-c", f"model_providers.amazon-bedrock.aws.region={json.dumps(region)}"]
        if profile is not None:
            flags += ["-c", f"model_providers.amazon-bedrock.aws.profile={json.dumps(profile)}"]
        return flags
    if provider == "oss":
        local = _string(options, "local_provider")
        if local not in {"ollama", "lmstudio"}:
            raise ValueError("Codex provider oss needs local_provider ollama or lmstudio")
        return ["--oss", "--local-provider", local]
    base_url, key = _string(options, "base_url"), _string(options, "api_key_env")
    if base_url is None or key is None:
        raise ValueError(f"Codex provider {provider} needs base_url and api_key_env")
    table = f'{{name={json.dumps(provider)},base_url={json.dumps(base_url)},env_key={json.dumps(key)},wire_api="responses"}}'
    return ["-c", f"model_provider={json.dumps(provider)}", "-c", f"model_providers.{provider}={table}"]


def _command(codex: list[str], root: Path, options: dict[str, Any]) -> list[str]:
    sandbox = str(options.get("sandbox", "workspace-write"))
    if sandbox not in {"read-only", "workspace-write", "danger-full-access"}:
        raise ValueError("Codex sandbox must be read-only, workspace-write, or danger-full-access")
    command = [*codex, "exec", "--json", "--color", "never", "--skip-git-repo-check", "--sandbox", sandbox, "--cd", str(root)]
    model = options.get("model")
    if isinstance(model, str) and model and model != "default":
        command.extend(["--model", model])
    return [*command, *_provider(options), *extra_args(options), "-"]


def _codex(options: dict[str, Any]) -> list[str]:
    """How Codex starts: a pinned release through npx, or ``codex`` on PATH."""
    package = _string(options, "package")
    if package is None:
        return [executable(options, "codex")]
    return [executable(options, "npx"), "-y", package]


class _Relay:
    """Codex's streamed events passed on as NanoAgent progress."""

    def __init__(self) -> None:
        self.thread: str | None = None
        self.answer = ""
        self.usage: dict[str, int] | None = None
        self.failure: str | None = None

    def __call__(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "thread.started":
            self.thread = event["thread_id"]
        elif kind == "turn.completed":
            self.usage = event["usage"]
        elif kind == "turn.failed":
            self.failure = json.dumps(event.get("error") or event.get("message"))
        elif kind in {"item.started", "item.completed"}:
            item = event["item"]
            if item["type"] in STREAMED_TOOLS:
                if kind == "item.started":
                    emit({"type": "tool_start", "id": item["id"], "name": item["type"]})
                else:
                    failed = item.get("status") == "failed" or item.get("exit_code") not in (None, 0)
                    output = item.get("aggregated_output") or json.dumps({k: v for k, v in item.items() if k not in {"id", "type"}})
                    emit(
                        {
                            "type": "tool",
                            "id": item["id"],
                            "name": item["type"],
                            "arguments": item.get("command") or {},
                            "output": output,
                            "is_error": failed,
                        }
                    )
            elif kind == "item.completed" and item["type"] in {"agent_message", "reasoning"}:
                if item["type"] == "agent_message":
                    self.answer = item["text"]
                emit({"type": "delta", "kind": "content" if item["type"] == "agent_message" else "reasoning", "text": item["text"]})


def _seconds(stamp: str) -> float:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def _tool_failed(payload: dict[str, Any]) -> bool:
    """Whether a tool's output says its process failed, as Codex's tools report an exit."""
    output = payload.get("output")
    if isinstance(output, str):
        found = EXIT.search(output)
        if found:
            return int(found.group(1)) != 0
        try:
            output = json.loads(output)
        except json.JSONDecodeError:
            return False
    code = output.get("metadata", {}).get("exit_code") if isinstance(output, dict) else None
    return code not in (None, 0)


def _usage(counts: dict[str, int]) -> dict[str, int]:
    """One call's usage from Codex's counts, whose input holds the cached tokens, as NanoAgent's does."""
    return {
        "prompt_tokens": counts["input_tokens"],
        "completion_tokens": counts["output_tokens"],
        "total_tokens": counts["input_tokens"] + counts["output_tokens"],
        "cached_tokens": counts.get("cached_input_tokens", 0),
        "cache_write_tokens": counts.get("cache_write_input_tokens", 0),
        "reasoning_tokens": counts.get("reasoning_output_tokens", 0),
    }


def _profile(session: Path, started: float, total: dict[str, int] | None) -> tuple[RunProfile, dict[str, Any]]:
    """The run's standard profile from Codex's session record, with ``total`` its tokens as Codex
    counts them (null when it reported none), and what Codex reported of itself.

    Codex records a call's usage (``token_count``) after the outputs of the tools it asked for, so the
    next call is opened only when its response appears, from when it was asked for: the turn's start,
    the last tool's output, or the previous response."""
    now = started
    profiler = StreamProfiler(clock=lambda: now)
    calling, asked, reported = False, started, {}
    for line in session.read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        payload = record.get("payload") or {}
        kind = payload.get("type") if record["type"] in {"event_msg", "response_item"} else record["type"]
        now = _seconds(record["timestamp"])
        responding = kind in TOOL_CALLS or kind == "reasoning" or (kind == "message" and payload.get("role") == "assistant")
        if (responding or kind == "token_usage_record") and not calling and not profiler.tools_running:
            now, at = asked, now
            profiler.model_start()
            now, calling = at, True
        if kind == "task_started":
            asked = now
        elif kind in TOOL_CALLS:
            if calling:
                profiler.model_end()
            profiler.tool_start(payload["call_id"], payload.get("name") or kind)
        elif kind == "token_usage_record" and calling:
            profiler.model_end()
            calling, asked = False, now
        elif kind == "token_count" and payload.get("info"):
            profiler.usage(_usage(payload["info"]["last_token_usage"]))
        elif kind in TOOL_OUTPUTS:
            profiler.tool_end(payload["call_id"], is_error=_tool_failed(payload))
            if not profiler.tools_running:
                asked = now
        elif kind == "task_complete":
            ttft = payload.get("time_to_first_token_ms")
            reported = {"duration_s": payload["duration_ms"] / 1000, "ttft_s": None if ttft is None else ttft / 1000}
    # The rollout holds no streamed tokens, so the profile has no first token of its own; Codex's own
    # figure counts from its turn's start, not the harness's, and stays in what it reported.
    return profiler.finish(None if total is None else _usage(total)), reported


def _run(payload: dict[str, Any]) -> dict[str, Any]:
    request, options = request_and_options(payload)
    root = workspace(request)
    codex = _codex(options)
    relay = _Relay()
    with tempfile.TemporaryDirectory(prefix="nanoagent-codex-") as home:
        login = Path.home() / ".codex" / "auth.json"
        if _string(options, "provider") is None:
            if not login.is_file():
                raise RuntimeError(f"Codex on the OpenAI login needs {login}: sign in with `codex login`")
            shutil.copy(login, Path(home, "auth.json"))
        started = datetime.now().timestamp()
        status, diagnostics = stream_child(
            _command(codex, root, options), cwd=root, input_text=prompt(request), on_event=relay, env={"CODEX_HOME": home}
        )
        if relay.thread is None:
            raise RuntimeError(diagnostics or f"Codex exited with status {status} and started no thread")
        sessions = list(Path(home, "sessions").rglob(f"rollout-*{relay.thread}.jsonl"))
        if len(sessions) != 1:
            raise RuntimeError(f"Codex recorded {len(sessions)} sessions for thread {relay.thread}")
        profile, reported = _profile(sessions[0], started, relay.usage)
    failed = status != 0 or relay.failure is not None or relay.usage is None
    return {
        "type": "done",
        "answer": relay.answer,
        "stop_reason": "error" if failed else "answer",
        "steps": len(profile.steps),
        "usage": profile.usage,
        "cost": 0.0,
        "error": f"Codex failed with status {status}: {relay.failure or diagnostics}" if failed else None,
        "metrics": profile.to_dict() | {"reported": reported},
    }


def main() -> int:
    return run_main(_run, error_code="codex_error", label="Codex CLI")


if __name__ == "__main__":
    raise SystemExit(main())
