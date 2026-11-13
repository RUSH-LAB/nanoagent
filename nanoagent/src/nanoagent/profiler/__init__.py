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

    cache_write = _first_number(raw, "cache_write_tokens", "cache_creation_input_tokens", "cacheWrite")
    if cache_write is not None:
        usage["cache_write_tokens"] = cache_write
    cache_write_1h = _first_number(raw, "cache_write_1h_tokens", "cacheWrite1h")
    if cache_write_1h is not None:
        usage["cache_write_1h_tokens"] = cache_write_1h

    completion_details = _field(raw, "completion_tokens_details") or _field(raw, "output_tokens_details")
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
    # From the run's start to its first streamed token; None when nothing was streamed.
    ttft_s: float | None = None

    @property
    def model_s(self) -> float:
        return sum(step.model_s for step in self.steps)

    @property
    def tools_s(self) -> float:
        return sum(step.tools_s for step in self.steps)

    @property
    def overhead_s(self) -> float:
        return max(0.0, self.duration_s - self.model_s - self.tools_s)

    @property
    def generation_s(self) -> float | None:
        """Time spent streaming tokens: each model call's first token to its last, summed; None when
        no call was seen streaming (e.g. Codex's rollout), so an unmeasured run doesn't read as 0."""
        calls = [call for step in self.steps for call in step.model_calls if call.kind != "tool"]
        if calls and all(call.generation_s is None for call in calls):
            return None
        return sum(call.generation_s or 0.0 for call in calls)

    def to_dict(self) -> dict[str, Any]:
        return {
            "duration_s": self.duration_s,
            "model_s": self.model_s,
            "tools_s": self.tools_s,
            "overhead_s": self.overhead_s,
            "ttft_s": self.ttft_s,
            "generation_s": self.generation_s,
            "usage": dict(self.usage),
            "cost": self.cost,
            "steps": [step.to_dict() for step in self.steps],
        }


@dataclass(slots=True)
class _ModelCallTimer:
    kind: str
    started: float
    clock: Clock
    on_first: Callable[[float], None]
    first_delta: float | None = None

    def on_delta(self, kind: str, text: str) -> None:
        """Observe a streamed token fragment without changing the user's callback."""
        del kind
        if text and self.first_delta is None:
            self.first_delta = self.clock()
            self.on_first(self.first_delta)

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
        return _ModelCallTimer(kind, self._owner._clock(), self._owner._clock, self._owner._first_token)

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

    def add_model_call(self, record: ModelCallProfile) -> None:
        """A model call a tool made itself (kind ``"tool"``): counted in the step's usage and cost,
        and in neither its model time nor the run's generation time, which its tool time holds."""
        self._model_calls.append(record)

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
        model_s = sum(call.duration_s for call in self._model_calls if call.kind != "tool")
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
        self._first: float | None = None
        self._steps: list[StepProfile] = []
        self._active: StepProfiler | None = None

    def _first_token(self, at: float) -> None:
        if self._first is None:
            self._first = at

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
            ttft_s=None if self._first is None else max(0.0, self._first - self._started),
        )


def messages_usage(input_tokens: int, output_tokens: int, cache_read: int = 0, cache_write: int = 0, reasoning: int | None = None) -> dict[str, int]:
    """Usage in NanoAgent's terms from Anthropic Messages' counts, whose input leaves cache reads and
    writes out: here the prompt counts every token sent, cached or not."""
    usage = {
        "prompt_tokens": input_tokens + cache_read + cache_write,
        "completion_tokens": output_tokens,
        "total_tokens": input_tokens + cache_read + cache_write + output_tokens,
        "cached_tokens": cache_read,
        "cache_write_tokens": cache_write,
    }
    if reasoning is not None:
        usage["reasoning_tokens"] = reasoning
    return usage


@dataclass(slots=True)
class _StreamCall:
    started: float
    first: float | None = None
    ended: float | None = None
    usage: dict[str, int] | None = None
    error: str | None = None


@dataclass(slots=True)
class _StreamStep:
    started: float
    calls: list[_StreamCall]
    tools: list[ToolCallProfile]
    tools_s: float = 0.0


class StreamProfiler:
    """A :class:`RunProfile` of a harness NanoAgent does not run itself, built from its events as they
    reach this process and timed on this process's clock, so every harness is profiled alike.

    A step is one model call and the tools it asked for: it opens when the call starts and closes
    when the next call starts, or when the harness says the step ended, or at the run's end. Tool
    time is the time at least one tool runs, so tools running together count once. A call's usage
    may come with its end or later (``usage``); a call that reports none has empty usage.
    """

    def __init__(self, *, clock: Clock = time.perf_counter) -> None:
        self._clock = clock
        self._started = clock()
        self._first: float | None = None
        self._steps: list[StepProfile] = []
        self._step: _StreamStep | None = None
        self._running: dict[str, tuple[str, float]] = {}
        self._phase: float | None = None

    def model_start(self, at: float | None = None) -> StepProfile | None:
        """A model call starts, opening a step; returns the step this closed, if one was open. A call
        right after a failed one, with no tools between, retries it: it joins that call's step.

        ``at`` is when the call was asked for, on this profiler's clock, when the harness only shows
        later that it was (e.g. by the start of its stream); the previous step closes then too."""
        now = self._clock() if at is None else at
        step = self._step
        if step is not None and step.calls[-1].error is not None and not step.tools:
            step.calls.append(_StreamCall(now))
            return None
        closed = self.close(at=now)
        self._step = _StreamStep(now, [_StreamCall(now)], [])
        return closed

    def first_token(self) -> None:
        call = self._call()
        if call.first is None:
            call.first = self._clock()
            if self._first is None:
                self._first = call.first

    def model_end(self, usage: Mapping[str, int] | None = None, error: str | None = None) -> None:
        call = self._call()
        if call.ended is None:
            call.ended = self._clock()
        if usage is not None:
            call.usage = dict(usage)
        call.error = error

    def usage(self, usage: Mapping[str, int]) -> None:
        """The usage of the open step's model call, when the harness reports it after the call."""
        self._call().usage = dict(usage)

    def tool_start(self, call_id: str, name: str) -> None:
        if self._step is None:
            raise RuntimeError(f"tool {name} started outside a step")
        now = self._clock()
        if not self._running:
            self._phase = now
        self._running[call_id] = (name, now)

    def tool_end(self, call_id: str, *, is_error: bool, error: str | None = None) -> None:
        assert self._step is not None and self._phase is not None
        name, started = self._running.pop(call_id)
        now = self._clock()
        self._step.tools.append(ToolCallProfile(call_id, name, now - started, is_error, error))
        if not self._running:
            self._step.tools_s += now - self._phase

    @property
    def tools_running(self) -> bool:
        return bool(self._running)

    def close(self, at: float | None = None) -> StepProfile | None:
        """Close the open step, if any, now or ``at``, and return it."""
        step, self._step = self._step, None
        if step is None:
            return None
        if self._running:
            raise RuntimeError(f"step {len(self._steps) + 1} closed with tools still running: {sorted(self._running)}")
        ended = self._clock() if at is None else at
        calls = tuple(
            ModelCallProfile(
                kind="agent",
                duration_s=(call.ended or ended) - call.started,
                ttft_s=None if call.first is None else call.first - call.started,
                generation_s=None if call.first is None else (call.ended or ended) - call.first,
                usage=dict(call.usage or {}),
                cost=0.0,
                error=call.error,
            )
            for call in step.calls
        )
        usage: dict[str, int] = {}
        for call in calls:
            accumulate_usage(usage, call.usage)
        model_s = sum(call.duration_s for call in calls)
        duration = ended - step.started
        profile = StepProfile(
            step=len(self._steps) + 1,
            duration_s=duration,
            model_s=model_s,
            tools_s=step.tools_s,
            overhead_s=max(0.0, duration - model_s - step.tools_s),
            usage=usage,
            cost=0.0,
            model_calls=calls,
            tool_calls=tuple(step.tools),
        )
        self._steps.append(profile)
        return profile

    def finish(self, usage: Mapping[str, int] | None = None) -> RunProfile:
        """The run's profile, its last step closed. ``usage`` is the run's whole usage when the harness
        reports more than its steps hold (calls it makes outside them); else the steps' sum."""
        self.close()
        total: dict[str, int] = {}
        for step in self._steps:
            accumulate_usage(total, step.usage)
        return RunProfile(
            duration_s=self._clock() - self._started,
            usage=dict(usage) if usage is not None else total,
            cost=0.0,
            steps=tuple(self._steps),
            ttft_s=None if self._first is None else self._first - self._started,
        )

    def _call(self) -> _StreamCall:
        if self._step is None:
            raise RuntimeError("no model call is open")
        return self._step.calls[-1]


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
    ttft = profiles[0].ttft_s if profiles else None
    return RunProfile(duration_s=duration, usage=usage, cost=cost, steps=tuple(steps), ttft_s=ttft)


__all__ = [
    "ModelCallProfile",
    "Profiler",
    "RunProfile",
    "StepProfile",
    "StepProfiler",
    "StreamProfiler",
    "ToolCallProfile",
    "accumulate_usage",
    "merge_profiles",
    "messages_usage",
    "normalize_usage",
]
