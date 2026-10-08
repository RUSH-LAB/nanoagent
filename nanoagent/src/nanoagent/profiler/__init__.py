"""Low-overhead profiling primitives for agent runs.

The profiler records client-observed wall time.  In particular, ``ttft_s`` includes
transport and provider queueing as well as prompt prefill; only a provider-side metric can
separate those components.  A missing ``ttft_s`` means the request was not streamed, not that
the first token arrived instantaneously.

``Profiler`` is intentionally independent of the agent/runtime layers.  It can therefore be
used by another harness without importing NanoAgent's loop, and the loop can use it without
creating a dependency cycle.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
import time
from typing import Any

Clock = Callable[[], float]


def accumulate_usage(total: dict[str, int], delta: Mapping[str, int]) -> None:
    """Add one provider usage mapping into ``total`` in place."""
    for key, value in delta.items():
        total[key] = total.get(key, 0) + int(value)


def _number(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def _field(value: Any, name: str) -> Any:
    if isinstance(value, Mapping):
        return value.get(name)
    return getattr(value, name, None)


def _first_number(value: Any, *names: str) -> int | None:
    for name in names:
        found = _number(_field(value, name))
        if found is not None:
            return found
    return None


def normalize_usage(raw: Any) -> dict[str, int]:
    """Normalize common provider usage shapes without inventing unavailable values.

    Cache reads are a subset of prompt tokens, and reasoning is a subset of completion
    tokens.  Consequently neither is added to ``total_tokens``.  Zero-valued details are
    retained when the provider explicitly reports them, which distinguishes "zero" from
    "unknown".
    """
    if raw is None:
        return {}

    usage: dict[str, int] = {}
    prompt = _first_number(raw, "prompt_tokens", "input_tokens", "input")
    completion = _first_number(raw, "completion_tokens", "output_tokens", "output")
    total = _first_number(raw, "total_tokens", "totalTokens")
    if prompt is not None:
        usage["prompt_tokens"] = prompt
    if completion is not None:
        usage["completion_tokens"] = completion
    if total is None and prompt is not None and completion is not None:
        total = prompt + completion
    if total is not None:
        usage["total_tokens"] = total

    prompt_details = _field(raw, "prompt_tokens_details") or _field(raw, "input_tokens_details")
    cached = _first_number(prompt_details, "cached_tokens")
    if cached is None:
        cached = _first_number(raw, "cached_tokens", "cache_read_input_tokens", "cacheRead")
    if cached is not None:
        usage["cached_tokens"] = cached

    cache_write = _first_number(
        raw, "cache_write_tokens", "cache_creation_input_tokens", "cacheWrite"
    )
    if cache_write is not None:
        usage["cache_write_tokens"] = cache_write
    cache_write_1h = _first_number(raw, "cache_write_1h_tokens", "cacheWrite1h")
    if cache_write_1h is not None:
        usage["cache_write_1h_tokens"] = cache_write_1h

    completion_details = _field(raw, "completion_tokens_details") or _field(
        raw, "output_tokens_details"
    )
    reasoning = _first_number(completion_details, "reasoning_tokens")
    if reasoning is None:
        reasoning = _first_number(raw, "reasoning_tokens", "reasoning")
    if reasoning is not None:
        usage["reasoning_tokens"] = reasoning
    return usage


@dataclass(frozen=True, slots=True)
class ModelCallProfile:
    """One model request, including retries represented as separate records."""

    kind: str
    duration_s: float
    ttft_s: float | None
    generation_s: float | None
    usage: dict[str, int]
    cost: float
    error: str | None = None

    @property
    def output_tokens_per_second(self) -> float | None:
        tokens = self.usage.get("completion_tokens")
        if tokens is None or self.generation_s is None or self.generation_s <= 0:
            return None
        return tokens / self.generation_s

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "duration_s": self.duration_s,
            "ttft_s": self.ttft_s,
            "generation_s": self.generation_s,
            "output_tokens_per_second": self.output_tokens_per_second,
            "usage": dict(self.usage),
            "cost": self.cost,
            "error": self.error,
        }


@dataclass(frozen=True, slots=True)
class ToolCallProfile:
    """Wall-clock duration of one tool invocation."""

    id: str
    name: str
    duration_s: float
    is_error: bool
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "duration_s": self.duration_s,
            "is_error": self.is_error,
            "error": self.error,
        }


@dataclass(frozen=True, slots=True)
class StepProfile:
    """One agent step and all model/tool calls made inside it."""

    step: int
    duration_s: float
    model_s: float
    tools_s: float
    overhead_s: float
    usage: dict[str, int]
    cost: float
    model_calls: tuple[ModelCallProfile, ...] = ()
    tool_calls: tuple[ToolCallProfile, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "step": self.step,
            "duration_s": self.duration_s,
            "model_s": self.model_s,
            "tools_s": self.tools_s,
            "overhead_s": self.overhead_s,
            "usage": dict(self.usage),
            "cost": self.cost,
            "model_calls": [call.to_dict() for call in self.model_calls],
            "tool_calls": [call.to_dict() for call in self.tool_calls],
        }


@dataclass(frozen=True, slots=True)
class RunProfile:
    """Detached snapshot of a run's profiling data."""

    duration_s: float
    usage: dict[str, int]
    cost: float
    steps: tuple[StepProfile, ...] = ()

    @property
    def model_s(self) -> float:
        return sum(step.model_s for step in self.steps)

    @property
    def tools_s(self) -> float:
        return sum(step.tools_s for step in self.steps)

    @property
    def overhead_s(self) -> float:
        return max(0.0, self.duration_s - self.model_s - self.tools_s)

    def to_dict(self) -> dict[str, Any]:
        return {
            "duration_s": self.duration_s,
            "model_s": self.model_s,
            "tools_s": self.tools_s,
            "overhead_s": self.overhead_s,
            "usage": dict(self.usage),
            "cost": self.cost,
            "steps": [step.to_dict() for step in self.steps],
        }


@dataclass(slots=True)
class _ModelCallTimer:
    kind: str
    started: float
    clock: Clock
    first_delta: float | None = None

    def on_delta(self, kind: str, text: str) -> None:
        """Observe a streamed token fragment without changing the user's callback."""
        del kind
        if text and self.first_delta is None:
            self.first_delta = self.clock()

    def finish(
        self,
        *,
        usage: Mapping[str, int] | None = None,
        cost: float = 0.0,
        error: str | None = None,
    ) -> ModelCallProfile:
        ended = self.clock()
        ttft = None if self.first_delta is None else max(0.0, self.first_delta - self.started)
        generation = None if self.first_delta is None else max(0.0, ended - self.first_delta)
        return ModelCallProfile(
            kind=self.kind,
            duration_s=max(0.0, ended - self.started),
            ttft_s=ttft,
            generation_s=generation,
            usage=dict(usage or {}),
            cost=cost,
            error=error,
        )


@dataclass(slots=True)
class _ToolCallTimer:
    id: str
    name: str
    started: float
    clock: Clock

    def finish(self, *, is_error: bool, error: str | None = None) -> ToolCallProfile:
        return ToolCallProfile(
            id=self.id,
            name=self.name,
            duration_s=max(0.0, self.clock() - self.started),
            is_error=is_error,
            error=error,
        )


class StepProfiler:
    """Mutable recorder for one in-flight step; created by :class:`Profiler`."""

    def __init__(self, owner: Profiler, step: int) -> None:
        self._owner = owner
        self.step = step
        self._started = owner._clock()
        self._model_calls: list[ModelCallProfile] = []
        self._tool_calls: list[ToolCallProfile | None] = []
        self._tools_s = 0.0
        self._finished = False

    def start_model_call(self, kind: str = "agent") -> _ModelCallTimer:
        return _ModelCallTimer(kind, self._owner._clock(), self._owner._clock)

    def finish_model_call(
        self,
        timer: _ModelCallTimer,
        *,
        usage: Mapping[str, int] | None = None,
        cost: float = 0.0,
        error: str | None = None,
    ) -> ModelCallProfile:
        record = timer.finish(usage=usage, cost=cost, error=error)
        self._model_calls.append(record)
        return record

    def start_tool_call(self, call_id: str, name: str) -> tuple[int, _ToolCallTimer]:
        slot = len(self._tool_calls)
        timer = _ToolCallTimer(call_id, name, self._owner._clock(), self._owner._clock)
        self._tool_calls.append(None)
        return slot, timer

    def finish_tool_call(
        self,
        slot: int,
        timer: _ToolCallTimer,
        *,
        is_error: bool,
        error: str | None = None,
    ) -> ToolCallProfile:
        record = timer.finish(is_error=is_error, error=error)
        self._tool_calls[slot] = record
        return record

    def add_tool_phase(self, duration_s: float) -> None:
        # Calls inside one dispatch run concurrently; this is dispatch wall time, deliberately
        # distinct from the sum of individual tool durations.
        self._tools_s += max(0.0, duration_s)

    def finish(self) -> StepProfile:
        if self._finished:
            raise RuntimeError("profiler step already finished")
        self._finished = True
        ended = self._owner._clock()
        usage: dict[str, int] = {}
        cost = 0.0
        for call in self._model_calls:
            accumulate_usage(usage, call.usage)
            cost += call.cost
        model_s = sum(call.duration_s for call in self._model_calls)
        duration_s = max(0.0, ended - self._started)
        profile = StepProfile(
            step=self.step,
            duration_s=duration_s,
            model_s=model_s,
            tools_s=self._tools_s,
            overhead_s=max(0.0, duration_s - model_s - self._tools_s),
            usage=usage,
            cost=cost,
            model_calls=tuple(self._model_calls),
            tool_calls=tuple(call for call in self._tool_calls if call is not None),
        )
        self._owner._finish_step(self, profile)
        return profile


class Profiler:
    """Recorder that produces immutable, JSON-ready run snapshots."""

    def __init__(self, *, clock: Clock = time.perf_counter) -> None:
        self._clock = clock
        self._started = clock()
        self._steps: list[StepProfile] = []
        self._active: StepProfiler | None = None

    def start_step(self, step: int) -> StepProfiler:
        if self._active is not None:
            raise RuntimeError("cannot start a profiler step while another is active")
        self._active = StepProfiler(self, step)
        return self._active

    def _finish_step(self, recorder: StepProfiler, profile: StepProfile) -> None:
        if recorder is not self._active:
            raise RuntimeError("finished profiler step is not active")
        self._steps.append(profile)
        self._active = None

    def snapshot(self) -> RunProfile:
        usage: dict[str, int] = {}
        cost = 0.0
        for step in self._steps:
            accumulate_usage(usage, step.usage)
            cost += step.cost
        return RunProfile(
            duration_s=max(0.0, self._clock() - self._started),
            usage=usage,
            cost=cost,
            steps=tuple(self._steps),
        )


def merge_profiles(profiles: list[RunProfile]) -> RunProfile:
    """Combine sequential task profiles into one active-work session profile."""
    usage: dict[str, int] = {}
    cost = 0.0
    duration = 0.0
    steps: list[StepProfile] = []
    for profile in profiles:
        accumulate_usage(usage, profile.usage)
        cost += profile.cost
        duration += profile.duration_s
        for step in profile.steps:
            steps.append(replace(step, step=len(steps) + 1))
    return RunProfile(duration_s=duration, usage=usage, cost=cost, steps=tuple(steps))


__all__ = [
    "ModelCallProfile",
    "Profiler",
    "RunProfile",
    "StepProfile",
    "StepProfiler",
    "ToolCallProfile",
    "accumulate_usage",
    "merge_profiles",
    "normalize_usage",
]
