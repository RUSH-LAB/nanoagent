"""The comparison of two sealed attempts as JSON, for RUSH's compare screen: the same ``project``,
``to_compare_attempt`` and ``compare`` the CLI's step 4 runs, on records and payloads posted by the caller.
Nothing here reaches the network or a model."""

from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping
from dataclasses import fields, is_dataclass
from decimal import Decimal
from typing import Any

from nanoagent.uploaded.compare import Comparison, compare
from nanoagent.uploaded.projection import project, to_compare_attempt
from nanoagent.uploaded.timing import Unknown


def plain(value: Any) -> Any:
    """JSON-ready: Unknown as ``{"unknown": reason}``, Decimal as text, dataclasses as objects."""
    if isinstance(value, Unknown):
        return {"unknown": value.reason}
    if isinstance(value, Decimal):
        return str(value)
    if is_dataclass(value) and not isinstance(value, type):
        return {f.name: plain(getattr(value, f.name)) for f in fields(value)}
    if isinstance(value, (tuple, list)):
        return [plain(item) for item in value]
    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}
    return value


def _side(side: Any, name: str) -> tuple[list[Mapping[str, Any]], dict[str, bytes], dict[str, str]]:
    if not isinstance(side, Mapping) or not isinstance(side.get("records"), list):
        raise ValueError(f"{name} needs a records list")
    payloads = side.get("payloads", {})
    redactions = side.get("redactions", {})
    if not isinstance(payloads, Mapping) or not isinstance(redactions, Mapping):
        raise ValueError(f"{name} payloads and redactions are objects keyed by SHA-256")
    try:
        data = {str(sha): base64.b64decode(text, validate=True) for sha, text in payloads.items()}
    except (binascii.Error, TypeError) as error:
        raise ValueError(f"{name} payloads are base64 text") from error
    return side["records"], data, {str(sha): str(status) for sha, status in redactions.items()}


def build_rows(result: Comparison, differences_only: bool = False) -> list[dict[str, Any]]:
    """Rows (only the differing ones when ``differences_only``), each with its index among all rows."""
    kept = result.differences_only() if differences_only else result.rows
    index = {id(row): i for i, row in enumerate(result.rows)}
    return [{"index": index[id(row)], **plain(row)} for row in kept]


def build_header(result: Comparison, conditions: tuple[Any, Any]) -> dict[str, Any]:
    """The conditions of both sides with every flagged difference, and the estimate delta (or why it is withheld)."""
    estimate = result.estimate_delta_ns
    return {
        "conditions_a": plain(conditions[0]),
        "conditions_b": plain(conditions[1]),
        "condition_differences": [plain(d) for d in result.conditions if d.state == "different"],
        "unknown_fields": [d.name for d in result.conditions if d.state == "unknown"],
        "estimate_delta_ns": None if isinstance(estimate, Unknown) else estimate,
        "estimate_withheld": estimate.reason if isinstance(estimate, Unknown) else None,
    }


def compare_attempts(a: Any, b: Any) -> dict[str, Any]:
    """``{conditions_a, conditions_b, condition_differences, unknown_fields, estimate_delta_ns, estimate_withheld, rows,
    first_difference}`` for attempts ``a`` and ``b``, each ``{records, payloads (base64 by SHA-256), redactions}``. Rows are
    all of them, each with its ``index``; ``first_difference`` is the index of the earliest changed action or group."""
    sides = []
    for name, side in (("a", a), ("b", b)):
        records, payloads, redactions = _side(side, name)
        sides.append(to_compare_attempt(project(records, payloads, redactions), payloads, redactions))
    result = compare(*sides)
    return {
        **build_header(result, (sides[0].conditions, sides[1].conditions)),
        "rows": build_rows(result),
        "first_difference": result.first_difference,
    }
