"""SWE-bench tasks, disposable Git workspaces, and official Docker scoring."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from nanoagent.benchmark.environment import GitCheckoutEnvironment
from nanoagent.benchmark.protocol import BaseBenchmarkAdapter, BenchmarkDescriptor
from nanoagent.benchmark.scorer import SWEbenchScorer
from nanoagent.benchmark.task import BenchmarkTask, TaskEnvironment


def _load_rows(dataset: str, split: str) -> list[dict[str, Any]]:
    path = Path(dataset)
    if path.is_file() and path.suffix == ".jsonl":
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    elif path.is_file() and path.suffix == ".json":
        rows = json.loads(path.read_text(encoding="utf-8"))
    else:
        try:
            from swebench.harness.utils import load_swebench_dataset
        except ImportError:
            raise RuntimeError(
                'loading a hosted SWE-bench dataset requires `pip install "nanoagent[swebench]"`'
            ) from None
        rows = load_swebench_dataset(dataset, split)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("SWE-bench dataset must contain a list of JSON objects")
    return rows


class SWEbenchBenchmark(BaseBenchmarkAdapter):
    """A SWE-bench dataset evaluated by its official deterministic Docker harness."""

    def __init__(
        self,
        *,
        name: str,
        label: str,
        version: str,
        primary_metric: str,
        options: dict[str, Any],
    ) -> None:
        if primary_metric != "resolved":
            raise ValueError("SWE-bench primary_metric must be 'resolved'")
        dataset = str(options.get("dataset", "SWE-bench/SWE-bench_Lite"))
        split = str(options.get("split", "test"))
        self._rows = _load_rows(dataset, split)
        self.environment = GitCheckoutEnvironment(
            cache_dir=options.get("cache_dir"),
            work_dir=options.get("work_dir"),
            keep=bool(options.get("keep_workspaces", False)),
            repo_url_template=str(options.get("repo_url_template", "https://github.com/{repo}.git")),
        )
        evaluator_command = options.get("evaluator_command")
        if evaluator_command is not None and (
            not isinstance(evaluator_command, list)
            or not evaluator_command
            or any(not isinstance(part, str) or not part for part in evaluator_command)
        ):
            raise ValueError("SWE-bench evaluator_command must be a non-empty argv list")
        self.scorer = SWEbenchScorer(
            dataset=dataset,
            split=split,
            timeout=int(options.get("evaluation_timeout", 1800)),
            evaluator_command=evaluator_command,
        )
        canonical = json.dumps(self._rows, sort_keys=True, separators=(",", ":"), default=str)
        self.descriptor = BenchmarkDescriptor(
            name=name,
            label=label,
            version=version,
            dataset_fingerprint=f"sha256:{hashlib.sha256(canonical.encode()).hexdigest()}",
            primary_metric=primary_metric,
            metrics={"resolved": "higher_is_better"},
        )

    def tasks(self) -> list[BenchmarkTask]:
        tasks: list[BenchmarkTask] = []
        seen: set[str] = set()
        for index, row in enumerate(self._rows, start=1):
            required = ("instance_id", "repo", "base_commit", "problem_statement")
            missing = [field for field in required if not row.get(field)]
            if missing:
                raise ValueError(f"SWE-bench row {index} is missing {', '.join(missing)}")
            task_id = str(row["instance_id"])
            if task_id in seen:
                raise ValueError(f"SWE-bench dataset contains duplicate instance id {task_id!r}")
            seen.add(task_id)
            repo = str(row["repo"])
            commit = str(row["base_commit"])
            tasks.append(
                BenchmarkTask(
                    id=task_id,
                    name=task_id,
                    input=str(row["problem_statement"]),
                    instructions=(
                        "Work directly in the provided repository. Diagnose and fix the reported "
                        "issue. Modify the working tree with the smallest correct patch. Do not "
                        "only describe the solution; leave all code changes in the workspace."
                    ),
                    environment=TaskEnvironment(
                        name="git-checkout",
                        version="1",
                        config={"repo": repo, "base_commit": commit},
                    ),
                    metadata={
                        "repo": repo,
                        "base_commit": commit,
                        **({"version": str(row["version"])} if row.get("version") else {}),
                    },
                    oracle={
                        key: row.get(key)
                        for key in ("patch", "test_patch", "FAIL_TO_PASS", "PASS_TO_PASS")
                    },
                )
            )
        return tasks
