from __future__ import annotations

from nanoagent.profiler import Profiler


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
    assert profile.ttft_s is None and profile.generation_s == 0.0
