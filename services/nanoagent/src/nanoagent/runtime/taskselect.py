"""Task-subset selection shared by batch runtimes and their CLI adapters.

Both ``nanoagent.runtime.batch.filter_tasks`` (over ``(task_id, task)`` tuples) and
a benchmark runner's ``select_tasks`` (over its own ``Task`` objects) narrow a
task list the same way; that one body lives here in nanoagent (the runner imports it from here,
the product it already depends on), with the two callers as thin delegators that pass their own id
accessor. Import the public helper::

    from nanoagent.runtime.taskselect import select_subset

:func:`select_subset` runs up to three stages, in this fixed order, on a copy of the input:

  1. **seeded shuffle** (``shuffle=True``) — sort by ``key`` (ties broken by ``repr`` so equal-``key``
     items get a fixed, input-order-independent order) then shuffle with a local
     ``random.Random(_SHUFFLE_SEED)``, so the order depends only on the items and the fixed seed,
     not the caller's input order;
  2. **regex filter** (``filter_re``) — keep items whose ``key(item)`` ``re.search``-matches;
  3. **slice** (``slice_spec``) — an ``a:b`` (or ``a:b:step``) spec applied as ``out[slice(*parts)]``.

A falsy argument skips its stage, so the all-default call is just a fresh list copy.
"""

from __future__ import annotations

import random
import re
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")

_SHUFFLE_SEED = 42  # fixed so a given task set always shuffles into the same order


def select_subset(
    items: list[T],
    *,
    key: Callable[[T], str],
    filter_re: str = "",
    slice_spec: str = "",
    shuffle: bool = False,
) -> list[T]:
    """Select a subset of ``items``: seeded shuffle, then regex on ``key(item)``, then ``a:b`` (or ``a:b:step``) slice.

    ``key`` extracts each item's id string (``lambda t: t[0]`` for tuple rows, ``lambda t:
    t.task_id`` for a benchmark ``Task``). The three stages run in the order above;
    each is skipped when its argument is falsy. Returns a new list — the input is never mutated.
    """
    out = list(items)
    if shuffle:
        # Tiebreak equal keys by repr so equal-key items get a fixed, input-order-independent order
        # before the shuffle. Assumes a content-based repr (tuple/dataclass callers), not identity-based.
        out = sorted(out, key=lambda x: (key(x), repr(x)))
        random.Random(_SHUFFLE_SEED).shuffle(out)
    if filter_re:
        try:
            rx = re.compile(filter_re)
        except re.error as e:
            raise ValueError(f"filter_re {filter_re!r} is not a valid regular expression: {e}") from e
        out = [x for x in out if rx.search(key(x))]
    if slice_spec:
        try:
            parts = [int(x) if x else None for x in slice_spec.split(":")]
        except ValueError as e:
            raise ValueError(f"slice_spec {slice_spec!r} is not a valid a:b[:step] slice (each field must be an int or empty): {e}") from e
        try:
            out = out[slice(*parts)]
        except (TypeError, ValueError) as e:
            raise ValueError(f"slice_spec {slice_spec!r} is not a valid a:b[:step] slice (at most 3 colon-separated fields): {e}") from e
    return out
