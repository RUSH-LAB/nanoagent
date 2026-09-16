from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from nanoagent.benchmark.adapters.swebench import SWEbenchBenchmark
from nanoagent.benchmark.engine import run_benchmark
from nanoagent.runtime.runner import RunnerCapabilities, RunnerRequest, RunnerResult
from nanoagent.runtime.runner_factory import RunnerProfile


class EditingRunner:
    name = "editing-runner"
    capabilities = RunnerCapabilities(tools=True)

    async def run(self, request: RunnerRequest, emit) -> RunnerResult:
        assert request.workspace is not None
        (Path(request.workspace) / "bug.py").write_text("fixed = True\n")
        return RunnerResult(answer="fixed", stop_reason="answer", steps=1)

    async def aclose(self) -> None:
        return None

    def availability(self):
        return True, None


@pytest.mark.asyncio
async def test_swebench_runs_workspace_agent_and_exports_official_prediction(tmp_path: Path) -> None:
    source = tmp_path / "sources" / "owner" / "repo"
    source.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    (source / "bug.py").write_text("fixed = False\n")
    subprocess.run(["git", "add", "bug.py"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "base"], cwd=source, check=True)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    dataset = tmp_path / "dataset.jsonl"
    dataset.write_text(json.dumps({
        "instance_id": "owner__repo-1",
        "repo": "owner/repo",
        "base_commit": commit,
        "problem_statement": "Set fixed to true",
        "FAIL_TO_PASS": ["test_bug"],
        "PASS_TO_PASS": [],
    }) + "\n")
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
        "assert '+fixed = True' in prediction['model_patch']\n"
        "out=Path('logs/run_evaluation') / a.run_id / 'results.json'\n"
        "out.parent.mkdir(parents=True, exist_ok=True)\n"
        "out.write_text(json.dumps({'completed_ids':[a.instance_ids],"
        "'resolved_ids':[a.instance_ids], 'infra_failure_ids':[], 'error_ids':[]}))\n"
    )
    benchmark = SWEbenchBenchmark(
        name="fixture",
        label="Fixture",
        version="1",
        primary_metric="resolved",
        options={
            "dataset": str(dataset),
            "split": "test",
            "cache_dir": str(tmp_path / "cache"),
            "work_dir": str(tmp_path / "work"),
            "repo_url_template": str(tmp_path / "sources" / "{repo}"),
            "evaluator_command": [sys.executable, str(evaluator)],
            "evaluation_timeout": 30,
        },
    )
    profile = RunnerProfile("local", "Local", "editing-runner", "model", EditingRunner())
    output = tmp_path / "output"

    summary = await run_benchmark(benchmark, profile, output_dir=output, concurrency=1)

    assert summary["primary_metric"] == {"name": "resolved", "value": 1.0}
    prediction = json.loads((output / "predictions.jsonl").read_text())
    assert prediction["instance_id"] == "owner__repo-1"
    assert "+fixed = True" in prediction["model_patch"]
    assert list((tmp_path / "work").iterdir()) == []
