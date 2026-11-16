import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "examples" / "benchmark"))

from step2_single_run import Prices, cost, described, finished_steps  # noqa: E402

from nanoagent.profiler import StepProfile  # noqa: E402


def _step(number: int, model_s: float, tools_s: float, usage: dict[str, int]) -> dict:
    step = StepProfile(step=number, duration_s=model_s + tools_s, model_s=model_s, tools_s=tools_s, overhead_s=0.0, usage=usage, cost=0.0)
    return {"t": float(number), "type": "step", "step": number, "cost": 0.0, "usage": usage, "metrics": step.to_dict()}


def test_a_failed_harness_keeps_the_steps_it_finished() -> None:
    timeline = [
        {"t": 0.5, "type": "tool_start", "id": "a", "name": "bash"},
        _step(1, 1.0, 0.5, {"prompt_tokens": 100, "completion_tokens": 10, "cached_tokens": 40}),
        _step(2, 2.0, 0.0, {"prompt_tokens": 200, "completion_tokens": 20, "cached_tokens": 150}),
    ]
    profile = finished_steps(timeline, 5.0)
    assert profile["model_s"] == 3.0
    assert profile["tools_s"] == 0.5
    assert profile["overhead_s"] == 1.5
    assert profile["usage"] == {"prompt_tokens": 300, "completion_tokens": 30, "cached_tokens": 190}
    assert [step["step"] for step in profile["steps"]] == [1, 2]
    assert profile["ttft_s"] is None and profile["generation_s"] is None


def test_a_harness_that_failed_before_any_step_has_only_its_latency() -> None:
    profile = finished_steps([], 0.8)
    assert profile["steps"] == [] and profile["usage"] == {}
    assert profile["model_s"] == 0.0 and profile["overhead_s"] == 0.8


def test_a_failure_is_described_by_its_type_and_message() -> None:
    assert described(RuntimeError("400: refused")) == "RuntimeError: 400: refused"
    assert described(TimeoutError()) == "TimeoutError"


def test_cost_prices_uncached_input_cache_reads_and_writes_and_output_apart() -> None:
    prices = Prices(input=1.0, cached_input=0.25, cache_write=1.5, output=4.0)
    tokens = {"prompt_tokens": 2200, "cached_tokens": 1000, "cache_write_tokens": 200, "completion_tokens": 80}
    assert cost(tokens, prices) == (1000 * 1.0 + 1000 * 0.25 + 200 * 1.5 + 80 * 4.0) / 1e6
