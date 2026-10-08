"""Convert a native NanoAgent result to Harbor's ATIF trajectory shape."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from slimconfig import Output

from nanoagent.core.agent import AgentResult

ATIF_VERSION = "ATIF-v1.8"


@dataclass
class AtifTrajectory(Output):
    """Typed SlimConfig output carrying one ATIF trajectory."""

    schema_version: str
    session_id: str
    agent: dict[str, Any]
    steps: list[dict[str, Any]]
    final_metrics: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> AtifTrajectory:
        return cls(
            schema_version=value["schema_version"],
            session_id=value["session_id"],
            agent=value["agent"],
            steps=value["steps"],
            final_metrics=value["final_metrics"],
        )


def to_atif(
    result: AgentResult,
    *,
    session_id: str,
    harness: str,
    harness_version: str,
    model: str,
) -> dict[str, Any]:
    steps: list[dict[str, Any]] = []
    index = 0
    while index < len(result.messages):
        message = result.messages[index]
        role = message.get("role")
        if role in {"system", "user"}:
            steps.append(_text_step(role, str(message.get("content") or "")))
            index += 1
            continue
        if role != "assistant":
            index += 1
            continue

        calls = [
            {
                "tool_call_id": call.get("id", ""),
                "function_name": call.get("function", {}).get("name", ""),
                "arguments": _arguments(call.get("function", {}).get("arguments")),
            }
            for call in message.get("tool_calls", [])
        ]
        results = []
        cursor = index + 1
        while cursor < len(result.messages) and result.messages[cursor].get("role") == "tool":
            tool_message = result.messages[cursor]
            call_id = tool_message.get("tool_call_id")
            results.append(
                {
                    "source_call_id": call_id,
                    "content": str(tool_message.get("content") or ""),
                }
            )
            cursor += 1
        steps.append(
            {
                "step_id": 0,
                "source": "agent",
                "message": str(message.get("content") or ""),
                "reasoning_content": message.get("reasoning_content"),
                "tool_calls": calls or None,
                "observation": {"results": results} if results else None,
                "metrics": None,
            }
        )
        index = cursor

    for step_id, step in enumerate(steps, 1):
        step["step_id"] = step_id
    prompt = result.usage.get("prompt_tokens", result.usage.get("input_tokens", 0))
    completion = result.usage.get("completion_tokens", result.usage.get("output_tokens", 0))
    cached = result.usage.get("cached_tokens", 0)
    return {
        "schema_version": ATIF_VERSION,
        "session_id": session_id,
        "agent": {"name": harness, "version": harness_version, "model_name": model},
        "steps": steps,
        "final_metrics": {
            "total_prompt_tokens": prompt,
            "total_completion_tokens": completion,
            "total_cached_tokens": cached,
            "total_steps": len(steps),
            "extra": {"cost": result.cost, "stop_reason": result.stop_reason.value},
        },
    }


def _text_step(source: str, message: str) -> dict[str, Any]:
    return {
        "step_id": 0,
        "source": source,
        "message": message,
        "reasoning_content": None,
        "tool_calls": None,
        "observation": None,
        "metrics": None,
    }


def _arguments(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    import json

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


__all__ = ["ATIF_VERSION", "AtifTrajectory", "to_atif"]
