"""Normalized token usage per physical model request, following the contract's "Token accounting" table.

Input includes cache reads and writes, output includes reasoning, total is input plus output. Unreported values stay
None (unknown); only a call proven never to reach upstream is zero.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Any

from nanoagent.uploaded.dialects import AssembledResponse, Dialect

COUNT_FIELDS = ("input", "output", "total", "cache_read", "cache_write", "reasoning")


class MalformedUsageError(ValueError):
    """A usage object carries a value that is not a non-negative integer count."""


@dataclass(frozen=True)
class NormalizedUsage:
    """One usage record. ``earlier`` keeps the values a reconciliation replaced; ``source_ids`` the IDs they came from."""

    input: int | None
    output: int | None
    total: int | None
    cache_read: int | None
    cache_write: int | None
    reasoning: int | None
    supplied_total: int | None
    cost_usd: Decimal | None
    provenance: str
    discrepancies: tuple[str, ...] = ()
    source_ids: tuple[str, ...] = ()
    earlier: tuple[NormalizedUsage, ...] = ()


NOT_DISPATCHED = NormalizedUsage(0, 0, 0, 0, 0, 0, None, Decimal(0), "not_dispatched")


def _count(usage: Mapping[str, Any] | None, *path: str) -> int | None:
    value: Any = usage
    for key in path:
        value = value.get(key) if isinstance(value, Mapping) else None
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise MalformedUsageError(f"usage field {'.'.join(path)} is not a non-negative integer: {value!r}")
    return value


def _cost(usage: Mapping[str, Any] | None, key: str = "cost") -> Decimal | None:
    value = (usage or {}).get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise MalformedUsageError(f"usage cost is not a number: {value!r}")
    return Decimal(str(value))


def _sum(*parts: int | None) -> int | None:
    return None if any(part is None for part in parts) else sum(parts)  # type: ignore[arg-type]


def _build(
    input_: int | None,
    output: int | None,
    cache_read: int | None,
    cache_write: int | None,
    reasoning: int | None,
    supplied_total: int | None,
    cost: Decimal | None,
    provenance: str,
    source_ids: tuple[str, ...],
) -> NormalizedUsage:
    total = _sum(input_, output)
    discrepancies = ()
    if supplied_total is not None and total is not None and supplied_total != total:
        discrepancies = (f"supplied total {supplied_total} differs from input + output {total} ({provenance})",)
    return NormalizedUsage(input_, output, total, cache_read, cache_write, reasoning, supplied_total, cost, provenance, discrepancies, source_ids)


def _chat(usage: Mapping[str, Any] | None, provenance: str, ids: tuple[str, ...]) -> NormalizedUsage:
    return _build(
        _count(usage, "prompt_tokens"),
        _count(usage, "completion_tokens"),
        _count(usage, "prompt_tokens_details", "cached_tokens"),
        _count(usage, "prompt_tokens_details", "cache_write_tokens"),
        _count(usage, "completion_tokens_details", "reasoning_tokens"),
        _count(usage, "total_tokens"),
        _cost(usage),
        provenance,
        ids,
    )


def _responses(usage: Mapping[str, Any] | None, provenance: str, ids: tuple[str, ...]) -> NormalizedUsage:
    return _build(
        _count(usage, "input_tokens"),
        _count(usage, "output_tokens"),
        _count(usage, "input_tokens_details", "cached_tokens"),
        _count(usage, "input_tokens_details", "cache_write_tokens"),
        _count(usage, "output_tokens_details", "reasoning_tokens"),
        _count(usage, "total_tokens"),
        _cost(usage),
        provenance,
        ids,
    )


def _anthropic(usage: Mapping[str, Any] | None, provenance: str, ids: tuple[str, ...]) -> NormalizedUsage:
    uncached = _count(usage, "input_tokens")
    # Anthropic omits the cache counters when nothing was cached, so absent means zero for this dialect.
    cache_read = _count(usage, "cache_read_input_tokens") or 0
    cache_write = _count(usage, "cache_creation_input_tokens") or 0
    return _build(
        _sum(uncached, cache_read, cache_write),
        _count(usage, "output_tokens"),
        cache_read,
        cache_write,
        None,  # the wire has no reasoning count
        _count(usage, "total_tokens"),
        _cost(usage),
        provenance,
        ids,
    )


_NORMALIZERS = {"chat_completions": _chat, "responses": _responses, "anthropic_messages": _anthropic}


def usage_for(dialect: Dialect, assembled_or_body: AssembledResponse | Mapping[str, Any]) -> NormalizedUsage:
    """Normalize the usage of an assembled response, or of a non-streaming response body."""
    if isinstance(assembled_or_body, AssembledResponse):
        usage = assembled_or_body.usage
        ids = tuple(dict.fromkeys(i for i in (assembled_or_body.response_id, assembled_or_body.generation_id) if i))
        provenance = f"{dialect}:stream" if assembled_or_body.frame_count is not None else f"{dialect}:body"
    else:
        usage = assembled_or_body.get("usage")
        ids = (assembled_or_body["id"],) if assembled_or_body.get("id") else ()
        provenance = f"{dialect}:body"
    return _NORMALIZERS[dialect](usage, provenance if usage is not None else f"{provenance}:no_usage", ids)


@dataclass(frozen=True)
class FieldTotal:
    """The sum over the calls that reported a field, and how many calls did not."""

    known: int | Decimal
    missing: int


@dataclass(frozen=True)
class UsageAggregate:
    calls: int
    input: FieldTotal
    output: FieldTotal
    total: FieldTotal
    cache_read: FieldTotal
    cache_write: FieldTotal
    reasoning: FieldTotal
    cost_usd: FieldTotal


def _field_total(values: Sequence[Any], zero: int | Decimal) -> FieldTotal:
    known = [value for value in values if value is not None]
    return FieldTotal(sum(known, zero), len(values) - len(known))


def aggregate(usages: Sequence[NormalizedUsage]) -> UsageAggregate:
    """Sum usage across calls. An empty sequence from a complete attempt is all zeros with nothing missing."""
    fields = {name: _field_total([getattr(usage, name) for usage in usages], 0) for name in COUNT_FIELDS}
    return UsageAggregate(calls=len(usages), cost_usd=_field_total([usage.cost_usd for usage in usages], Decimal(0)), **fields)


def reconcile(provisional: NormalizedUsage, accounting: Mapping[str, Any]) -> NormalizedUsage:
    """Replace provisional fields with a generation lookup's accounting (the ``data`` object of ``GET /api/v1/generation``).

    Only fields the lookup reports are replaced, so the physical call stays one record. The replaced record is kept in
    ``earlier`` and the lookup's ID is added to ``source_ids``. Native prompt tokens include cache reads and native
    completion tokens include reasoning, matching the normalized semantics.
    """
    input_ = _count(accounting, "native_tokens_prompt")
    output = _count(accounting, "native_tokens_completion")
    cost = _cost(accounting, "total_cost")
    merged = {
        "input": provisional.input if input_ is None else input_,
        "output": provisional.output if output is None else output,
        "cache_read": _first(_count(accounting, "native_tokens_cached"), provisional.cache_read),
        "cache_write": provisional.cache_write,
        "reasoning": _first(_count(accounting, "native_tokens_reasoning"), provisional.reasoning),
        "cost": provisional.cost_usd if cost is None else cost,
    }
    lookup_id = accounting.get("id")
    ids = provisional.source_ids if not lookup_id or lookup_id in provisional.source_ids else (*provisional.source_ids, lookup_id)
    total = _sum(merged["input"], merged["output"])
    return replace(
        provisional,
        input=merged["input"],
        output=merged["output"],
        total=total,
        cache_read=merged["cache_read"],
        cache_write=merged["cache_write"],
        reasoning=merged["reasoning"],
        cost_usd=merged["cost"],
        provenance="generation_lookup",
        discrepancies=(),
        source_ids=ids,
        earlier=(*provisional.earlier, replace(provisional, earlier=())),
    )


def _first(value: int | None, fallback: int | None) -> int | None:
    return fallback if value is None else value
