from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from nanoagent.benchmark.adapters.swebench import SWEbenchBenchmark
from nanoagent.benchmark.environment import EnvironmentOutcome, EnvironmentSession, GitCheckoutEnvironment
from nanoagent.benchmark.metric import MetricDefinition
from nanoagent.benchmark.scorer import ScoringContext, SWEbenchScorer
from nanoagent.benchmark.task import BenchmarkTask, TaskEnvironment
from nanoagent.runtime.runner import RunnerResult


def task(*, repo: str = "owner/repo", commit: str = "0123456789abcdef") -> BenchmarkTask:
    return BenchmarkTask(
        id="owner__repo-1",
        name="Fix the regression",
        input="The parser rejects valid input.",
        environment=TaskEnvironment(
            name="git-checkout",
            version="1",
            config={"repo": repo, "base_commit": commit},
        ),
        oracle={"private": True},
    )


def test_task_has_name_and_hides_oracle_from_public_protocol() -> None:
    value = task()

    assert value.name == "Fix the regression"
    assert value.public()["environment"]["name"] == "git-checkout"
    assert "oracle" not in value.public()


def test_metric_declares_direction_range_and_aggregation() -> None:
    metric = MetricDefinition(
        "resolved", direction="maximize", aggregation="mean", minimum=0.0, maximum=1.0
    )

    assert metric.aggregate([1.0, 0.0, 1.0]) == pytest.approx(2 / 3)
    with pytest.raises(ValueError, match="<= 1.0"):
        metric.validate(2.0)


@pytest.mark.asyncio
async def test_git_environment_checks_out_captures_patch_and_cleans_up(tmp_path: Path) -> None:
    source = tmp_path / "sources" / "owner" / "repo"
    source.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    (source / "old.txt").write_text("before\n")
    subprocess.run(["git", "add", "old.txt"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "base"], cwd=source, check=True)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    environment = GitCheckoutEnvironment(
        cache_dir=tmp_path / "cache",
        work_dir=tmp_path / "work",
        repo_url_template=str(tmp_path / "sources" / "{repo}"),
    )
    value = task(commit=commit)

    session = await environment.start(value)
    assert session.workspace is not None
    workspace = session.workspace
    (workspace / "old.txt").write_text("after\n")
    (workspace / "new.txt").write_text("new\n")
    outcome = await environment.capture(value, session)

    assert "old.txt" in outcome.submission
    assert "new.txt" in outcome.submission
    assert outcome.metadata["base_commit"] == commit
    await environment.close(value, session)
    assert not workspace.exists()


def test_swebench_loader_builds_named_tasks_without_exposing_gold(tmp_path: Path) -> None:
    dataset = tmp_path / "swebench.jsonl"
    dataset.write_text(
        json.dumps(
            {
                "instance_id": "owner__repo-1",
                "repo": "owner/repo",
                "base_commit": "0123456789abcdef",
                "problem_statement": "Fix it",
                "patch": "private gold patch",
                "test_patch": "private tests",
                "FAIL_TO_PASS": ["test_bug"],
                "PASS_TO_PASS": ["test_existing"],
            }
        )
        + "\n"
    )
    benchmark = SWEbenchBenchmark(
        name="swebench",
        label="SWE-bench fixture",
        version="1",
        primary_metric="resolved",
        options={"dataset": str(dataset), "split": "test"},
    )

    value = benchmark.tasks()[0]
    assert value.id == value.name == "owner__repo-1"
    assert value.environment.config == {
        "repo": "owner/repo",
        "base_commit": "0123456789abcdef",
    }
    assert value.oracle["patch"] == "private gold patch"
    assert "oracle" not in value.public()
    public = benchmark.public()
    assert public["scorer"]["deterministic"] is True
    assert public["metrics"][0]["name"] == "resolved"


@pytest.mark.asyncio
async def test_swebench_scorer_uses_official_prediction_contract(tmp_path: Path) -> None:
    evaluator = tmp_path / "evaluator.py"
    evaluator.write_text(
        "import argparse, json\n"
        "from pathlib import Path\n"
        "p=argparse.ArgumentParser()\n"
        "p.add_argument('--dataset_name'); p.add_argument('--split')\n"
        "p.add_argument('--predictions_path'); p.add_argument('--instance_ids')\n"
        "p.add_argument('--max_workers'); p.add_argument('--run_id'); p.add_argument('--timeout')\n"
        "a=p.parse_args()\n"
        "prediction=json.loads(Path(a.predictions_path).read_text())\n"
        "assert prediction['instance_id'] == a.instance_ids\n"
        "out=Path('logs/run_evaluation') / a.run_id / 'results.json'\n"
        "out.parent.mkdir(parents=True, exist_ok=True)\n"
        "out.write_text(json.dumps({'completed_ids':[a.instance_ids],"
        "'resolved_ids':[a.instance_ids], 'infra_failure_ids':[], 'error_ids':[]}))\n"
    )
    scorer = SWEbenchScorer(
        dataset="fixture.jsonl",
        split="test",
        timeout=30,
        evaluator_command=[sys.executable, str(evaluator)],
    )
    value = task()
    context = ScoringContext(tmp_path / "output", "run-id", "profile", "model")

    score = await scorer.score(
        value,
        RunnerResult(answer="done", stop_reason="answer"),
        EnvironmentSession(workspace=tmp_path),
        EnvironmentOutcome(submission="diff --git a/a b/a\n"),
        context,
    )

    assert score.metrics == {"resolved": 1.0}
    assert score.submission == {
        "instance_id": value.id,
        "model_name_or_path": "profile__model",
        "model_patch": "diff --git a/a b/a\n",
    }
    assert score.details["completed"] is True
