"""Harness-neutral execution contract used by the web and service layers."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from nanoagent.core.agent import AgentResult

ProgressSink = Callable[[dict[str, Any]], None]


@dataclass(frozen=True)
class RunnerCapabilities:
    """Features a harness can expose through NanoAgent's normalized protocol."""

    streaming: bool = False
    reasoning: bool = False
    tools: bool = False
    usage: bool = False
    cancellation: bool = True
    history: bool = False

    def as_dict(self) -> dict[str, bool]:
        return {
            "streaming": self.streaming,
            "reasoning": self.reasoning,
            "tools": self.tools,
            "usage": self.usage,
            "cancellation": self.cancellation,
            "history": self.history,
        }


@dataclass(frozen=True)
class RunnerRequest:
    input: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    instructions: str | None = None
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "input": self.input,
            "messages": self.messages,
            "instructions": self.instructions,
            "metadata": self.metadata,
        }


@dataclass(frozen=True)
class RunnerResult:
    answer: str
    stop_reason: str
    steps: int = 0
    usage: dict[str, int] = field(default_factory=dict)
    cost: float = 0.0
    error: str | None = None

    @classmethod
    def from_agent_result(cls, result: AgentResult) -> RunnerResult:
        return cls(
            answer=result.answer,
            stop_reason=result.stop_reason.value,
            steps=result.steps,
            usage=dict(result.usage),
            cost=result.cost,
            error=result.error,
        )

    @classmethod
    def from_event(cls, event: dict[str, Any]) -> RunnerResult:
        try:
            answer = event["answer"]
            stop_reason = event["stop_reason"]
        except KeyError as error:
            raise RunnerProtocolError(f"done event is missing {error.args[0]!r}") from error
        if not isinstance(answer, str) or not isinstance(stop_reason, str):
            raise RunnerProtocolError("done event answer and stop_reason must be strings")
        usage = event.get("usage", {})
        if not isinstance(usage, dict) or any(
            not isinstance(key, str) or not isinstance(value, int)
            for key, value in usage.items()
        ):
            raise RunnerProtocolError("done event usage must map strings to integers")
        return cls(
            answer=answer,
            stop_reason=stop_reason,
            steps=_non_negative_int(event.get("steps", 0), "steps"),
            usage=dict(usage),
            cost=_non_negative_number(event.get("cost", 0.0), "cost"),
            error=_optional_string(event.get("error"), "error"),
        )


class RunnerError(RuntimeError):
    """A harness failure safe to project onto the public run stream."""

    def __init__(self, message: str, *, code: str = "runner_error") -> None:
        super().__init__(message)
        self.code = code


class RunnerUnavailableError(RunnerError):
    def __init__(self, message: str) -> None:
        super().__init__(message, code="runner_unavailable")


class RunnerProtocolError(RunnerError):
    def __init__(self, message: str) -> None:
        super().__init__(message, code="runner_protocol_error")


class Runner(Protocol):
    name: str
    capabilities: RunnerCapabilities

    async def run(self, request: RunnerRequest, emit: ProgressSink) -> RunnerResult: ...

    async def aclose(self) -> None: ...

    def availability(self) -> tuple[bool, str | None]: ...


def validate_progress_event(event: Any) -> dict[str, Any]:
    """Validate one non-terminal event received from a third-party runner."""
    if not isinstance(event, dict):
        raise RunnerProtocolError("runner event must be a JSON object")
    event_type = event.get("type")
    if event_type == "delta":
        if event.get("kind") not in {"content", "reasoning"} or not isinstance(
            event.get("text"), str
        ):
            raise RunnerProtocolError("delta event requires kind and text")
    elif event_type == "tool":
        required = {"id": str, "name": str, "output": str, "is_error": bool}
        if any(not isinstance(event.get(key), kind) for key, kind in required.items()):
            raise RunnerProtocolError("tool event has invalid required fields")
        if "arguments" not in event:
            raise RunnerProtocolError("tool event is missing 'arguments'")
    elif event_type == "step":
        _non_negative_int(event.get("step"), "step")
        _non_negative_number(event.get("cost"), "cost")
        usage = event.get("usage")
        if not isinstance(usage, dict) or any(not isinstance(value, int) for value in usage.values()):
            raise RunnerProtocolError("step event usage must map strings to integers")
    else:
        raise RunnerProtocolError(f"runner emitted unsupported progress event {event_type!r}")
    return dict(event)


def _non_negative_int(value: Any, field_name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise RunnerProtocolError(f"{field_name} must be a non-negative integer")
    return value


def _non_negative_number(value: Any, field_name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
        raise RunnerProtocolError(f"{field_name} must be a non-negative number")
    return float(value)


def _optional_string(value: Any, field_name: str) -> str | None:
    if value is not None and not isinstance(value, str):
        raise RunnerProtocolError(f"{field_name} must be a string or null")
    return value
