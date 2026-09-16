"""Task identity and private evaluation data for benchmark runs."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class TaskEnvironment:
    """The reproducible environment requested by one task."""

    name: str
    version: str
    config: dict[str, Any] = field(default_factory=dict)

    @property
    def fingerprint(self) -> str:
        payload = json.dumps(
            {"name": self.name, "version": self.version, "config": self.config},
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return f"sha256:{hashlib.sha256(payload.encode()).hexdigest()}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "version": self.version,
            "fingerprint": self.fingerprint,
        }


@dataclass(frozen=True)
class BenchmarkTask:
    """One named problem; ``oracle`` is private and never enters a runner request."""

    id: str
    name: str
    input: str
    environment: TaskEnvironment
    instructions: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    oracle: Any = None

    def __post_init__(self) -> None:
        for field_name in ("id", "name", "input"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"benchmark task {field_name} must be a non-empty string")

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "input": self.input,
            "instructions": self.instructions,
            "metadata": dict(self.metadata),
            "environment": self.environment.to_dict(),
        }
