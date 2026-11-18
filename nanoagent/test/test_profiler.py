from __future__ import annotations

from nanoagent.profiler import Profiler, StreamProfiler, messages_usage, normalize_usage


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_run_profile_times_the_first_token_and_generation() -> None:
    clock = Clock()
    profiler = Profiler(clock=clock)
    clock.now = 1.0
    step = profiler.start_step(1)
    call = step.start_model_call()
    clock.now = 3.0
    call.on_delta("reasoning", "")  # an empty fragment is not a token
    clock.now = 4.0
    call.on_delta("content", "hi")
    clock.now = 6.0
    step.finish_model_call(call)
    second = step.start_model_call()
    clock.now = 7.0
    second.on_delta("content", "again")
    clock.now = 8.0
    step.finish_model_call(second)
    step.finish()

    profile = profiler.snapshot()
    assert profile.ttft_s == 4.0
    assert profile.generation_s == 3.0
    assert profile.to_dict()["ttft_s"] == 4.0 and profile.to_dict()["generation_s"] == 3.0


def test_an_unstreamed_run_has_no_first_token() -> None:
    profiler = Profiler()
    step = profiler.start_step(1)
    step.finish_model_call(step.start_model_call())
    step.finish()
    profile = profiler.snapshot()
    assert profile.ttft_s is None and profile.generation_s is None


def test_stream_profile_counts_tools_running_together_once() -> None:
    clock = Clock()
    profiler = StreamProfiler(clock=clock)
    clock.now += 1.0
    profiler.model_start()
    clock.now += 0.5
    profiler.first_token()
    clock.now += 1.5
    profiler.model_end(messages_usage(10, 5, cache_read=90, cache_write=0))
    profiler.tool_start("a", "bash")
    clock.now += 1.0
    profiler.tool_start("b", "read")
    clock.now += 1.0
    profiler.tool_end("a", is_error=False)
    clock.now += 1.0
    profiler.tool_end("b", is_error=True)
    step = profiler.model_start()
    assert step is not None
    assert step.model_s == 2.0
    assert step.tools_s == 3.0  # a from 0 to 2 and b from 1 to 3: three seconds with a tool running
    assert [(call.name, call.duration_s, call.is_error) for call in step.tool_calls] == [("bash", 2.0, False), ("read", 2.0, True)]
    assert step.model_calls[0].ttft_s == 0.5
    assert step.usage["prompt_tokens"] == 100  # every token sent, the cached included
    clock.now += 2.0
    profiler.model_end()
    profile = profiler.finish(usage={"prompt_tokens": 150})
    assert len(profile.steps) == 2
    assert profile.duration_s == 8.0
    assert profile.ttft_s == 1.5
    assert profile.usage == {"prompt_tokens": 150}  # the harness's own account, calls outside the steps included


def test_stream_profile_keeps_a_retry_in_its_step() -> None:
    clock = Clock()
    profiler = StreamProfiler(clock=clock)
    profiler.model_start()
    clock.now += 1.0
    profiler.model_end(error="rate limited")
    assert profiler.model_start() is None
    clock.now += 2.0
    profiler.model_end({"completion_tokens": 3})
    profile = profiler.finish()
    assert len(profile.steps) == 1
    # The failed attempt is not a call, but its time is model time.
    assert [call.error for call in profile.steps[0].model_calls] == [None]
    assert profile.steps[0].model_calls[0].duration_s == 2.0
    assert profile.model_s == 3.0


def test_stream_profile_counts_no_call_when_every_attempt_fails() -> None:
    clock = Clock()
    profiler = StreamProfiler(clock=clock)
    profiler.model_start()
    clock.now += 1.5
    profiler.model_end(error="server error")
    profile = profiler.finish()
    assert len(profile.steps) == 1
    assert profile.steps[0].model_calls == ()
    assert profile.model_s == 1.5


def test_openrouter_cache_writes_are_read_from_the_prompt_details() -> None:
    usage = normalize_usage(
        {"prompt_tokens": 1000, "completion_tokens": 50, "prompt_tokens_details": {"cached_tokens": 600, "cache_write_tokens": 300}}
    )
    assert usage["cached_tokens"] == 600
    assert usage["cache_write_tokens"] == 300


def test_run_profile_counts_no_call_for_a_failed_attempt_but_keeps_its_time() -> None:
    clock = Clock()
    profiler = Profiler(clock=clock)
    step = profiler.start_step(1)
    call = step.start_model_call()
    clock.now = 2.0
    step.finish_model_call(call, error="APIStatusError: 500")
    profile = step.finish()
    assert profile.model_calls == ()
    assert profile.model_s == 2.0
