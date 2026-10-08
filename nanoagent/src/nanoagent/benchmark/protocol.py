"""The stable contract between benchmark datasets, runners, and scorers.

An adapter owns benchmark-specific data and scoring. The engine sees a public
``PreparedCase`` and passes only that to the model; the private ``oracle`` remains
on ``BenchmarkCase`` and is available only to the scorer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from nanoagent.benchmark.environment import BenchmarkEnvironment, LocalEnvironment
from nanoagent.benchmark.metric import MetricDefinition
from nanoagent.benchmark.scorer import BenchmarkScore, BenchmarkScorer
from nanoagent.benchmark.task import BenchmarkTask

BENCHMARK_PROTOCOL = "nanoagent.benchmark.v2"
BENCHMARK_RESULT_PROTOCOL = "nanoagent.benchmark.result.v2"
BENCHMARK_TASK_PROTOCOL = "nanoagent.benchmark.task.v2"
# Compatibility alias for the v1 name.
BENCHMARK_CASE_PROTOCOL = BENCHMARK_TASK_PROTOCOL


@dataclass(frozen=True)
class BenchmarkDescriptor:
    name: str
    label: str
    version: str
    dataset_fingerprint: str
    primary_metric: str
    metrics: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label,
            "version": self.version,
            "dataset_fingerprint": self.dataset_fingerprint,
            "primary_metric": self.primary_metric,
            "metrics": dict(self.metrics),
        }


@dataclass(frozen=True)
class PreparedCase:
    input: str
    instructions: str | None = None
    messages: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


class BenchmarkAdapter(Protocol):
    """A task source composed with an environment and a deterministic scorer."""

    descriptor: BenchmarkDescriptor
    environment: BenchmarkEnvironment
    scorer: BenchmarkScorer

    def tasks(self) -> list[BenchmarkTask]: ...

    async def prepare(self, task: BenchmarkTask) -> PreparedCase: ...

    def public(self) -> dict[str, Any]: ...


class BaseBenchmarkAdapter:
    """Convenient composition defaults for benchmark task sources."""

    descriptor: BenchmarkDescriptor
    environment: BenchmarkEnvironment = LocalEnvironment()
    scorer: BenchmarkScorer

    def cases(self) -> list[BenchmarkTask]:
        """Compatibility alias for the original benchmark API."""
        return self.tasks()

    async def prepare(self, task: BenchmarkTask) -> PreparedCase:
        return PreparedCase(
            input=task.input,
            instructions=task.instructions,
            metadata=dict(task.metadata),
        )

    def public(self) -> dict[str, Any]:
        environment_available, environment_reason = self.environment.availability()
        scorer_available, scorer_reason = self.scorer.availability()
        return {
            "protocol": BENCHMARK_PROTOCOL,
            **self.descriptor.to_dict(),
            "environment": {
                **self.environment.descriptor.to_dict(),
                "available": environment_available,
                "unavailable_reason": environment_reason,
            },
            "scorer": {
                **self.scorer.descriptor.to_dict(),
                "available": scorer_available,
                "unavailable_reason": scorer_reason,
            },
            "metrics": [metric.to_dict() for metric in self.scorer.metrics],
        }


# Compatibility name for code written against nanoagent.benchmark.v1.
BenchmarkCase = BenchmarkTask

__all__ = [
    "BENCHMARK_CASE_PROTOCOL",
    "BENCHMARK_PROTOCOL",
    "BENCHMARK_RESULT_PROTOCOL",
    "BENCHMARK_TASK_PROTOCOL",
    "BaseBenchmarkAdapter",
    "BenchmarkAdapter",
    "BenchmarkCase",
    "BenchmarkDescriptor",
    "BenchmarkScore",
    "MetricDefinition",
    "PreparedCase",
]
