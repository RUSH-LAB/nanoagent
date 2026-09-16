from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.benchmark.adapters.jsonl import JsonlExactMatchBenchmark
from nanoagent.benchmark.environment import EnvironmentOutcome, EnvironmentSession
from nanoagent.benchmark.scorer import ScoringContext
from nanoagent.runtime.runner import RunnerResult


def adapter(path: Path, **options) -> JsonlExactMatchBenchmark:
    return JsonlExactMatchBenchmark(
        name="tiny",
        label="Tiny",
        version="1",
        primary_metric="accuracy",
        options={"path": str(path), **options},
    )


@pytest.mark.asyncio
async def test_exact_match_keeps_gold_out_of_public_case(tmp_path: Path) -> None:
    dataset = tmp_path / "cases.jsonl"
    dataset.write_text(
        json.dumps({"id": "one", "input": "2 + 2", "expected": "4", "metadata": {"topic": "math"}}) + "\n"
    )
    benchmark = adapter(dataset, casefold=True)
    case = benchmark.tasks()[0]

    assert case.metadata == {"topic": "math"}
    assert "expected" not in case.metadata
    assert case.oracle == "4"
    score = await benchmark.scorer.score(
        case,
        RunnerResult(answer=" 4 ", stop_reason="answer"),
        EnvironmentSession(),
        EnvironmentOutcome(),
        ScoringContext(tmp_path, "run", "profile", "model"),
    )
    assert score.metrics == {"accuracy": 1.0}
    assert benchmark.descriptor.dataset_fingerprint.startswith("sha256:")


def test_jsonl_rejects_duplicate_case_ids(tmp_path: Path) -> None:
    dataset = tmp_path / "cases.jsonl"
    dataset.write_text(
        "\n".join(
            json.dumps({"id": "same", "input": value, "expected": value})
            for value in ("a", "b")
        )
    )
    with pytest.raises(ValueError, match="duplicate"):
        adapter(dataset).cases()
