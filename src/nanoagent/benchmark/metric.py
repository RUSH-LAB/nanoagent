"""Machine-readable metric definitions and deterministic aggregation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

MetricDirection = Literal["maximize", "minimize"]
MetricAggregation = Literal["mean", "sum"]


@dataclass(frozen=True)
class MetricDefinition:
    name: str
    direction: MetricDirection = "maximize"
    aggregation: MetricAggregation = "mean"
    minimum: float | None = None
    maximum: float | None = None

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("metric name must be non-empty")
        if self.direction not in {"maximize", "minimize"}:
            raise ValueError("metric direction must be maximize or minimize")
        if self.aggregation not in {"mean", "sum"}:
            raise ValueError("metric aggregation must be mean or sum")
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("metric minimum cannot exceed maximum")

    def aggregate(self, values: list[float]) -> float | None:
        if not values:
            return None
        total = sum(float(value) for value in values)
        return total if self.aggregation == "sum" else total / len(values)

    def validate(self, value: float) -> float:
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ValueError(f"metric {self.name!r} must be numeric")
        number = float(value)
        if self.minimum is not None and number < self.minimum:
            raise ValueError(f"metric {self.name!r} must be >= {self.minimum}")
        if self.maximum is not None and number > self.maximum:
            raise ValueError(f"metric {self.name!r} must be <= {self.maximum}")
        return number

    def to_dict(self) -> dict[str, str | float | None]:
        return {
            "name": self.name,
            "direction": self.direction,
            "aggregation": self.aggregation,
            "minimum": self.minimum,
            "maximum": self.maximum,
        }
