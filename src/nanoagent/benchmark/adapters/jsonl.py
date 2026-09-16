"""A small universal JSONL benchmark with exact-match scoring."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from nanoagent.benchmark.environment import LocalEnvironment
from nanoagent.benchmark.protocol import (
    BaseBenchmarkAdapter,
    BenchmarkDescriptor,
)
from nanoagent.benchmark.scorer import ExactMatchScorer
from nanoagent.benchmark.task import BenchmarkTask, TaskEnvironment


class JsonlExactMatchBenchmark(BaseBenchmarkAdapter):
    """Rows are ``{"id", "input", "expected"}``; gold never reaches the runner."""

    def __init__(
        self,
        *,
        name: str,
        label: str,
        version: str,
        primary_metric: str,
        options: dict[str, Any],
    ) -> None:
        try:
            self.path = Path(str(options["path"]))
        except KeyError:
            raise ValueError(f"benchmark {name!r}: jsonl adapter requires options.path") from None
        if not self.path.is_file():
            raise FileNotFoundError(f"benchmark {name!r}: dataset does not exist: {self.path}")
        self.id_field = str(options.get("id_field", "id"))
        self.input_field = str(options.get("input_field", "input"))
        self.expected_field = str(options.get("expected_field", "expected"))
        self.strip = bool(options.get("strip", True))
        self.casefold = bool(options.get("casefold", False))
        self.environment = LocalEnvironment()
        self.scorer = ExactMatchScorer(
            metric=primary_metric,
            strip=self.strip,
            casefold=self.casefold,
        )
        digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.descriptor = BenchmarkDescriptor(
            name=name,
            label=label,
            version=version,
            dataset_fingerprint=f"sha256:{digest}",
            primary_metric=primary_metric,
            metrics={primary_metric: "higher_is_better"},
        )

    def tasks(self) -> list[BenchmarkTask]:
        tasks: list[BenchmarkTask] = []
        seen: set[str] = set()
        with self.path.open(encoding="utf-8") as source:
            for line_number, line in enumerate(source, start=1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(
                        f"{self.path} line {line_number}: invalid JSON: {error}"
                    ) from error
                if not isinstance(row, dict):
                    raise ValueError(f"{self.path} line {line_number}: row must be an object")
                missing = [
                    field
                    for field in (self.id_field, self.input_field, self.expected_field)
                    if field not in row
                ]
                if missing:
                    raise ValueError(
                        f"{self.path} line {line_number}: missing {', '.join(missing)}"
                    )
                case_id = str(row[self.id_field])
                if not case_id or case_id in seen:
                    raise ValueError(
                        f"{self.path} line {line_number}: duplicate or empty case id {case_id!r}"
                    )
                seen.add(case_id)
                public_metadata = row.get("metadata", {})
                if not isinstance(public_metadata, dict):
                    raise ValueError(f"{self.path} line {line_number}: metadata must be an object")
                tasks.append(
                    BenchmarkTask(
                        id=case_id,
                        name=str(row.get("name") or case_id),
                        input=str(row[self.input_field]),
                        environment=TaskEnvironment(name="local", version="1"),
                        instructions=(
                            None if row.get("instructions") is None else str(row["instructions"])
                        ),
                        metadata=dict(public_metadata),
                        oracle=row[self.expected_field],
                    )
                )
        return tasks
