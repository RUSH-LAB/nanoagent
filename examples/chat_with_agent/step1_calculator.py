import operator
from collections.abc import Callable

from nanoagent.core.tool import JsonSchema, Tool


class Calculator(Tool):
    """Apply one configured arithmetic operation to two numbers."""

    NAME = "calculator"

    def __init__(self, operations: list[str]) -> None:
        available: dict[str, Callable[[float, float], float]] = {
            "add": operator.add,
            "subtract": operator.sub,
            "multiply": operator.mul,
            "divide": operator.truediv,
        }
        unknown = sorted(set(operations) - available.keys())
        if unknown:
            raise ValueError(f"unknown calculator operations: {', '.join(unknown)}")
        self._operations = {name: available[name] for name in operations}
        self.PARAMETERS: JsonSchema = {
            "type": "object",
            "properties": {
                "operation": {"type": "string", "enum": list(self._operations)},
                "left": {"type": "number"},
                "right": {"type": "number"},
            },
            "required": ["operation", "left", "right"],
            "additionalProperties": False,
        }

    def run(self, operation: str, left: float, right: float) -> float:
        try:
            calculate = self._operations[operation]
        except KeyError:
            raise ValueError(f"operation {operation!r} is not enabled") from None
        return calculate(left, right)
