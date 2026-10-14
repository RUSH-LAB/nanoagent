"""Versioned, rule-based benchmark scorers."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
from importlib.metadata import PackageNotFoundError, version as package_version
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, Sequence

from nanoagent import helpers
from nanoagent.benchmark.environment import EnvironmentOutcome, EnvironmentSession
from nanoagent.benchmark.metric import MetricDefinition
from nanoagent.benchmark.task import BenchmarkTask
from nanoagent.harness import HarnessResult as RunnerResult


@dataclass(frozen=True)
class ScorerDescriptor:
    name: str
    version: str
    deterministic: bool
    fingerprint: str

    @classmethod
    def rules(
        cls, name: str, version: str, rules: dict[str, Any]
    ) -> ScorerDescriptor:
        encoded = json.dumps(rules, sort_keys=True, separators=(",", ":"), default=str)
        return cls(
            name=name,
            version=version,
            deterministic=True,
            fingerprint=f"sha256:{hashlib.sha256(encoded.encode()).hexdigest()}",
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "version": self.version,
            "deterministic": self.deterministic,
            "fingerprint": self.fingerprint,
        }


@dataclass(frozen=True)
class BenchmarkScore:
    metrics: dict[str, float]
    details: dict[str, Any] = field(default_factory=dict)
    submission: Any = None

    def __post_init__(self) -> None:
        if not self.metrics:
            raise ValueError("benchmark score must contain at least one metric")
        for name, value in self.metrics.items():
            if not isinstance(name, str) or not name:
                raise ValueError("benchmark metric names must be non-empty strings")
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError(f"benchmark metric {name!r} must be numeric")


@dataclass(frozen=True)
class ScoringContext:
    output_dir: Path
    run_id: str
    profile_id: str
    model: str


class BenchmarkScorer(Protocol):
    descriptor: ScorerDescriptor
    metrics: tuple[MetricDefinition, ...]

    def availability(self) -> tuple[bool, str | None]: ...

    def validate(self, score: BenchmarkScore) -> None: ...

    async def score(
        self,
        task: BenchmarkTask,
        result: RunnerResult,
        session: EnvironmentSession,
        outcome: EnvironmentOutcome,
        context: ScoringContext,
    ) -> BenchmarkScore: ...

    def aggregate(self, scores: list[BenchmarkScore]) -> dict[str, float]: ...


class RuleBasedScorer:
    """Base class for deterministic scorers with declared metric semantics."""

    descriptor: ScorerDescriptor
    metrics: tuple[MetricDefinition, ...]

    def availability(self) -> tuple[bool, str | None]:
        return True, None

    def validate(self, score: BenchmarkScore) -> None:
        definitions = {metric.name: metric for metric in self.metrics}
        unknown = sorted(set(score.metrics) - definitions.keys())
        if unknown:
            raise ValueError(f"scorer emitted undeclared metrics: {', '.join(unknown)}")
        for name, value in score.metrics.items():
            definitions[name].validate(value)

    def aggregate(self, scores: list[BenchmarkScore]) -> dict[str, float]:
        definitions = {metric.name: metric for metric in self.metrics}
        for score in scores:
            self.validate(score)
        return {
            name: value
            for name, metric in definitions.items()
            if (value := metric.aggregate([score.metrics[name] for score in scores if name in score.metrics]))
            is not None
        }


class ExactMatchScorer(RuleBasedScorer):
    def __init__(
        self,
        *,
        metric: str = "accuracy",
        strip: bool = True,
        casefold: bool = False,
    ) -> None:
        self.metric = metric
        self.strip = strip
        self.casefold = casefold
        self.metrics = (
            MetricDefinition(metric, direction="maximize", minimum=0.0, maximum=1.0),
        )
        self.descriptor = ScorerDescriptor.rules(
            "exact-match",
            "1",
            {"metric": metric, "strip": strip, "casefold": casefold},
        )

    def _normalize(self, value: Any) -> str:
        text = str(value)
        if self.strip:
            text = text.strip()
        return text.casefold() if self.casefold else text

    async def score(
        self,
        task: BenchmarkTask,
        result: RunnerResult,
        session: EnvironmentSession,
        outcome: EnvironmentOutcome,
        context: ScoringContext,
    ) -> BenchmarkScore:
        predicted = self._normalize(result.answer)
        expected = self._normalize(task.oracle)
        return BenchmarkScore(
            metrics={self.metric: float(predicted == expected)},
            details={"predicted": predicted, "expected": expected},
        )


class SWEbenchScorer(RuleBasedScorer):
    """Run the official Docker evaluator on one generated repository patch."""

    def __init__(
        self,
        *,
        dataset: str,
        split: str,
        timeout: int = 1800,
        evaluator_command: Sequence[str] | None = None,
    ) -> None:
        self.dataset = str(Path(dataset).resolve()) if Path(dataset).is_file() else dataset
        self.split = split
        self.timeout = timeout
        self._official_command = evaluator_command is None
        self.command = tuple(evaluator_command or (helpers.python("the SWE-bench evaluator"), "-m", "swebench.harness.run_evaluation"))
        if not self.command:
            raise ValueError("SWE-bench evaluator command must not be empty")
        self.metrics = (
            MetricDefinition("resolved", direction="maximize", minimum=0.0, maximum=1.0),
        )
        try:
            evaluator_version = package_version("swebench") if self._official_command else None
        except PackageNotFoundError:
            evaluator_version = "not-installed"
        self.descriptor = ScorerDescriptor.rules(
            "swebench-official",
            "1",
            {
                "dataset": self.dataset,
                "split": split,
                "timeout": timeout,
                "evaluator": (
                    {"package": "swebench", "version": evaluator_version}
                    if self._official_command
                    else {"command": list(self.command)}
                ),
            },
        )

    def availability(self) -> tuple[bool, str | None]:
        if self._official_command:
            if importlib.util.find_spec("swebench") is None:
                return False, 'SWE-bench evaluator is not installed; run `pip install "nanoagent[swebench]"`'
            try:
                import docker

                client = docker.from_env(timeout=5)
                try:
                    client.ping()
                finally:
                    client.close()
            except Exception as error:
                return False, f"Docker is unavailable for SWE-bench evaluation: {error}"
        return True, None

    async def score(
        self,
        task: BenchmarkTask,
        result: RunnerResult,
        session: EnvironmentSession,
        outcome: EnvironmentOutcome,
        context: ScoringContext,
    ) -> BenchmarkScore:
        patch = outcome.submission if isinstance(outcome.submission, str) else ""
        prediction = {
            "instance_id": task.id,
            "model_name_or_path": f"{context.profile_id}__{context.model}",
            "model_patch": patch,
        }
        if not patch.strip():
            return BenchmarkScore(
                metrics={"resolved": 0.0},
                details={"empty_patch": True},
                submission=prediction,
            )
        available, reason = self.availability()
        if not available:
            raise RuntimeError(reason)
        scorer_root = context.output_dir / "swebench"
        predictions_dir = scorer_root / "predictions"
        predictions_dir.mkdir(parents=True, exist_ok=True)
        safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", task.id).strip("-.") or "task"
        prediction_path = predictions_dir / f"{safe_id}.jsonl"
        prediction_path.write_text(json.dumps(prediction, separators=(",", ":")) + "\n")
        run_id = f"{context.run_id}-{hashlib.sha256(task.id.encode()).hexdigest()[:10]}"
        command = [
            *self.command,
            "--dataset_name",
            self.dataset,
            "--split",
            self.split,
            "--predictions_path",
            str(prediction_path),
            "--instance_ids",
            task.id,
            "--max_workers",
            "1",
            "--run_id",
            run_id,
            "--timeout",
            str(self.timeout),
        ]
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=scorer_root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        if process.returncode:
            detail = stderr.decode(errors="replace").strip()[-8000:]
            raise RuntimeError(f"official SWE-bench evaluator failed ({process.returncode}): {detail}")
        report_path = scorer_root / "logs" / "run_evaluation" / run_id / "results.json"
        if not report_path.is_file():
            output = stdout.decode(errors="replace").strip()[-2000:]
            raise RuntimeError(f"official SWE-bench evaluator produced no report: {output}")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        resolved = task.id in report.get("resolved_ids", [])
        details = {
            "official_report": str(report_path.relative_to(context.output_dir)),
            "completed": task.id in report.get("completed_ids", []),
            "resolved": resolved,
            "infra_failure": task.id in report.get("infra_failure_ids", []),
            "error": task.id in report.get("error_ids", []),
        }
        return BenchmarkScore(
            metrics={"resolved": float(resolved)},
            details=details,
            submission=prediction,
        )
