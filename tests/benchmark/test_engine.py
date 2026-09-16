from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.benchmark.adapters.jsonl import JsonlExactMatchBenchmark
from nanoagent.benchmark.engine import run_benchmark
from nanoagent.runtime.runner import RunnerCapabilities, RunnerRequest, RunnerResult
from nanoagent.runtime.runner_factory import RunnerProfile


class FakeRunner:
    name = "fake"
    capabilities = RunnerCapabilities()

    def __init__(self) -> None:
        self.calls = 0

    async def run(self, request: RunnerRequest, emit) -> RunnerResult:
        self.calls += 1
        emit({"type": "delta", "kind": "content", "text": request.input})
        answer = "yes" if request.input == "right" else "wrong"
        return RunnerResult(
            answer=answer,
            stop_reason="answer",
            steps=1,
            usage={"total_tokens": 3},
            cost=0.01,
        )

    async def aclose(self) -> None:
        return None

    def availability(self):
        return True, None


def make_benchmark(tmp_path: Path) -> JsonlExactMatchBenchmark:
    dataset = tmp_path / "cases.jsonl"
    dataset.write_text(
        "\n".join(
            [
                json.dumps({"id": "a", "input": "right", "expected": "yes"}),
                json.dumps({"id": "b", "input": "wrong", "expected": "yes"}),
            ]
        )
        + "\n"
    )
    return JsonlExactMatchBenchmark(
        name="tiny",
        label="Tiny",
        version="1",
        primary_metric="accuracy",
        options={"path": str(dataset)},
    )


@pytest.mark.asyncio
async def test_benchmark_writes_standard_artifacts_and_resumes(tmp_path: Path) -> None:
    runner = FakeRunner()
    profile = RunnerProfile("mine", "Mine", "fake", "model", runner)
    benchmark = make_benchmark(tmp_path)
    output = tmp_path / "output"

    summary = await run_benchmark(benchmark, profile, output_dir=output, concurrency=2)

    assert summary["protocol"] == "nanoagent.benchmark.result.v2"
    assert summary["primary_metric"] == {"name": "accuracy", "value": 0.5}
    assert summary["counts"] == {"selected": 2, "completed": 2, "errors": 0}
    assert summary["usage"] == {"total_tokens": 6}
    rows = [json.loads(line) for line in (output / "results.jsonl").read_text().splitlines()]
    assert {row["case_id"] for row in rows} == {"a", "b"}
    assert all((output / row["artifact"]).is_file() for row in rows)
    assert runner.calls == 2

    resumed = await run_benchmark(benchmark, profile, output_dir=output, concurrency=2)
    assert resumed["primary_metric"]["value"] == 0.5
    assert runner.calls == 2


@pytest.mark.asyncio
async def test_output_refuses_a_different_profile(tmp_path: Path) -> None:
    benchmark = make_benchmark(tmp_path)
    output = tmp_path / "output"
    first = RunnerProfile("first", "First", "fake", "one", FakeRunner())
    second = RunnerProfile("second", "Second", "fake", "two", FakeRunner())
    await run_benchmark(benchmark, first, output_dir=output, concurrency=1)
    with pytest.raises(ValueError, match="different benchmark or profile"):
        await run_benchmark(benchmark, second, output_dir=output, concurrency=1)
