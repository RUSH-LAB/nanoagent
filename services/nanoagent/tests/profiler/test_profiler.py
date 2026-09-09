from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from nanoagent.core.agent import Agent, Reply, ToolCall
from nanoagent.core.tool import JsonSchema, Tool
from nanoagent.profiler import Profiler, normalize_usage
from nanoagent.runtime.trajectory import save, load


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_profiler_records_ttft_generation_usage_and_parallel_tool_wall_time() -> None:
    clock = _Clock()
    profiler = Profiler(clock=clock)
    step = profiler.start_step(1)

    model = step.start_model_call()
    clock.now = 0.25
    model.on_delta("reasoning", "r")
    clock.now = 1.0
    step.finish_model_call(
        model,
        usage={"prompt_tokens": 10, "completion_tokens": 5, "cached_tokens": 4},
        cost=0.2,
    )

    slot_a, tool_a = step.start_tool_call("a", "search")
    slot_b, tool_b = step.start_tool_call("b", "read")
    clock.now = 1.4
    step.finish_tool_call(slot_a, tool_a, is_error=False)
    clock.now = 1.6
    step.finish_tool_call(slot_b, tool_b, is_error=True, error="boom")
    step.add_tool_phase(0.6)
    finished = step.finish()
    profile = profiler.snapshot()

    call = finished.model_calls[0]
    assert call.duration_s == pytest.approx(1.0)
    assert call.ttft_s == pytest.approx(0.25)
    assert call.generation_s == pytest.approx(0.75)
    assert call.output_tokens_per_second == pytest.approx(5 / 0.75)
    assert finished.tools_s == pytest.approx(0.6)
    assert [tool.duration_s for tool in finished.tool_calls] == pytest.approx([0.4, 0.6])
    assert profile.usage == {"prompt_tokens": 10, "completion_tokens": 5, "cached_tokens": 4}
    assert profile.cost == pytest.approx(0.2)


def test_normalize_usage_preserves_cache_and_reasoning_details_including_zero() -> None:
    raw = SimpleNamespace(
        prompt_tokens=100,
        completion_tokens=20,
        total_tokens=120,
        prompt_tokens_details=SimpleNamespace(cached_tokens=80),
        completion_tokens_details=SimpleNamespace(reasoning_tokens=0),
    )
    assert normalize_usage(raw) == {
        "prompt_tokens": 100,
        "completion_tokens": 20,
        "total_tokens": 120,
        "cached_tokens": 80,
        "reasoning_tokens": 0,
    }


class _SlowTool(Tool):
    NAME = "slow"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    async def run(self) -> str:
        await asyncio.sleep(0.01)
        return "ok"


class _StreamingModel:
    def __init__(self) -> None:
        self.turn = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.turn += 1
        if on_delta is not None:
            await asyncio.sleep(0.005)
            on_delta("content", "x")
            await asyncio.sleep(0.005)
        usage = {
            "prompt_tokens": 10,
            "completion_tokens": 2,
            "total_tokens": 12,
            "cached_tokens": 3,
        }
        if self.turn == 1:
            return Reply(
                content=None,
                tool_calls=[ToolCall(id="c1", name="slow", arguments="{}")],
                usage=usage,
            )
        return Reply(content="done", usage=usage)


async def test_agent_profile_is_complete_and_saved(tmp_path: Any) -> None:
    result = await Agent(_StreamingModel(), [_SlowTool()], system_prompt="sys").run(
        "go", on_delta=lambda _kind, _text: None
    )

    assert result.profile is not None
    assert len(result.profile.steps) == 2
    assert result.profile.usage["prompt_tokens"] == 20
    assert result.profile.usage["cached_tokens"] == 6
    assert result.profile.steps[0].model_calls[0].ttft_s is not None
    assert result.profile.steps[0].model_calls[0].generation_s is not None
    assert result.profile.steps[0].tool_calls[0].name == "slow"
    assert result.profile.steps[0].tool_calls[0].duration_s > 0
    assert result.profile.steps[1].tool_calls == ()

    data = load(save(result, tmp_path / "profile.traj.json"))
    assert data["profile"] == result.profile.to_dict()
