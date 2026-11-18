"""Normalized token usage per physical model request, following the contract's "Token accounting" table.

Input includes cache reads and writes, output includes reasoning, total is input plus output. Unreported values stay
None (unknown); only a call proven never to reach upstream is zero.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Any

from nanoagent.uploaded.dialects import AssembledResponse

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


# Per dialect: the paths of input, output, cached input, cache-write input and reasoning counts.
_OPENAI_PATHS = {
    "chat_completions": (
        ("prompt_tokens",),
        ("completion_tokens",),
        ("prompt_tokens_details", "cached_tokens"),
        ("prompt_tokens_details", "cache_write_tokens"),
        ("completion_tokens_details", "reasoning_tokens"),
    ),
    "responses": (
        ("input_tokens",),
        ("output_tokens",),
        ("input_tokens_details", "cached_tokens"),
        ("input_tokens_details", "cache_write_tokens"),
        ("output_tokens_details", "reasoning_tokens"),
    ),
}


def _openai(dialect: str, usage: Mapping[str, Any] | None, provenance: str, ids: tuple[str, ...]) -> NormalizedUsage:
    input_, output, cache_read, cache_write, reasoning = (_count(usage, *path) for path in _OPENAI_PATHS[dialect])
    return _build(input_, output, cache_read, cache_write, reasoning, _count(usage, "total_tokens"), _cost(usage), provenance, ids)


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


def usage_for(assembled: AssembledResponse) -> NormalizedUsage:
    """Normalize the usage of an assembled response."""
    dialect, usage = assembled.dialect, assembled.usage
    ids = tuple(dict.fromkeys(i for i in (assembled.response_id, assembled.generation_id) if i))
    provenance = f"{dialect}:stream" if assembled.frame_count is not None else f"{dialect}:body"
    provenance = provenance if usage is not None else f"{provenance}:no_usage"
    if dialect == "anthropic_messages":
        return _anthropic(usage, provenance, ids)
    return _openai(dialect, usage, provenance, ids)


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
    input_ = provisional.input if input_ is None else input_
    output = provisional.output if output is None else output
    lookup_id = accounting.get("id")
    ids = provisional.source_ids if not lookup_id or lookup_id in provisional.source_ids else (*provisional.source_ids, lookup_id)
    cache_read, reasoning = _count(accounting, "native_tokens_cached"), _count(accounting, "native_tokens_reasoning")
    return replace(
        provisional,
        input=input_,
        output=output,
        total=_sum(input_, output),
        cache_read=provisional.cache_read if cache_read is None else cache_read,
        reasoning=provisional.reasoning if reasoning is None else reasoning,
        cost_usd=provisional.cost_usd if cost is None else cost,
        provenance="generation_lookup",
        discrepancies=(),
        source_ids=ids,
        earlier=(*provisional.earlier, replace(provisional, earlier=())),
    )
