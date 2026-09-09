"""Async batch inference engine: run many requests concurrently under a semaphore.

:func:`infer` is the single entry point. It builds the configured backend (deferred
import, so importing the engine never pulls in the backend's provider SDK until a backend
is built), normalizes each item — a
prompt string, a single message dict, a message list, or a :class:`~nanoagent.inference.types.Request` — and runs them
all concurrently, bounded by ``config.concurrency``. Results are returned in input
order. A request that fails after the backend exhausts its retries is captured as a
:class:`~nanoagent.inference.types.Response` with ``error`` set, so one failure never sinks the batch.

One turn per request is the whole contract here: a :class:`~nanoagent.inference.types.Request` carrying
``tools`` gets whatever the model asked for back in :attr:`~nanoagent.inference.types.Response.tool_calls`,
and nothing runs them. Running them and going round again is
:class:`nanoagent.core.agent.Agent`, which is a loop over ONE conversation rather than a batch
of them, and so lives on the other side of the package rather than inside it.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Sequence
from typing import Any

from nanoagent.inference.backend import Backend
from nanoagent.inference.backends import build_backend
from nanoagent.inference.config import LeanInferConfig
from nanoagent.inference.types import Request, Response

logger: logging.Logger = logging.getLogger(__name__)


async def infer(
    requests: Sequence[str | dict[str, Any] | list[dict[str, Any]] | Request],
    config: LeanInferConfig,
) -> list[Response]:
    """Run ``requests`` through the configured backend, concurrently and in input order.

    Each item is normalized via :meth:`Request.coerce` — which offers no tools, so only an item
    passed as an explicit :class:`~nanoagent.inference.types.Request` can carry them. Concurrency is bounded by
    ``config.concurrency``; the returned list aligns one-to-one with ``requests``. When
    ``config.group_by_prefix`` is set, requests sharing a long common prompt prefix are
    dispatched adjacently (so a prefix-caching backend reuses the prefix); results are still
    returned in input order. The backend (and its connection pool) is closed when the batch
    finishes, and a one-line summary (counts / tokens / cost / wall-clock) is logged at INFO.
    """
    normalized = [Request.coerce(item) for item in requests]
    if (
        not normalized
    ):  # nothing to do — skip building a backend / opening a connection pool
        return []
    backend = build_backend(config)
    semaphore = asyncio.Semaphore(max(1, config.concurrency))
    # Dispatch order: optionally place requests sharing a long common prompt prefix adjacently
    # so a prefix-caching backend reuses the cached prefix. Identity (input order) when off,
    # so the default path is unchanged.
    order = (
        _prefix_group_order(normalized)
        if config.group_by_prefix
        else range(len(normalized))
    )
    start = time.perf_counter()
    try:
        dispatched = await asyncio.gather(
            *(_run_one(backend, normalized[i], semaphore) for i in order)
        )
    finally:
        await _aclose(backend)
    # Invert the dispatch permutation so results align one-to-one with ``requests`` in INPUT
    # order via an O(n) scatter (``order`` is a permutation of range(n)). When grouping is off
    # the dispatch order already IS the input order, so return the gathered list as-is.
    responses = (
        _invert_to_input_order(order, dispatched)
        if config.group_by_prefix
        else dispatched
    )
    if logger.isEnabledFor(logging.INFO):
        # _summarize_batch is an O(n) pass over responses; only run it when the INFO line
        # will actually be emitted. isEnabledFor(INFO) is the exact predicate logger.info
        # applies internally, so this never suppresses a line the unguarded call would emit.
        logger.info(
            "nanoagent.inference batch complete: %s",
            _summarize_batch(responses, time.perf_counter() - start),
        )
    return responses


def _prompt_key(request: Request) -> str:
    """Flatten a request's full message list into one string — the lexical sort key.

    Joins every message as ``role`` + content, in order, into the whole conversation as one
    string. Two requests that share their leading messages share a leading substring, so a
    lexicographic sort of these keys places shared-prefix requests in contiguous blocks —
    exactly the prefix a prefix-caching backend would reuse.
    """
    return "\n".join(
        f"{m.get('role', '')}\t{m.get('content', '')}" for m in request.messages
    )


def _prefix_group_order(requests: Sequence[Request]) -> list[int]:
    """Return a permutation of ``range(len(requests))`` that groups shared-prefix requests.

    Pure and deterministic: a stable lexicographic sort of the indices by each request's
    flattened prompt text (:func:`_prompt_key`). Lexicographic order makes every set of
    requests sharing a common prompt prefix a contiguous block, so dispatching in this order
    lets a prefix-caching backend (e.g. SGLang) reuse the cached prefix across the block. The
    sort is stable, so requests with identical prompts keep their input order. Lexical only —
    it compares prompt strings, never embeddings or similarity.
    """
    return sorted(range(len(requests)), key=lambda i: _prompt_key(requests[i]))


def _invert_to_input_order(
    order: Sequence[int], dispatched: list[Response]
) -> list[Response]:
    """Place each gathered result back at its original input index — an O(n) permutation inverse.

    ``order`` is a permutation of ``range(len(dispatched))`` (the dispatch order from
    :func:`_prefix_group_order`), and ``dispatched[k]`` is the result for input index
    ``order[k]``. Scattering ``responses[order[k]] = dispatched[k]`` reconstructs input order
    in O(n) — no sort, no per-element key call — byte-identical to a stable sort of the
    ``(input index, result)`` pairs by input index.
    """
    responses = list(dispatched)  # right length + element type; avoids a None-filled list
    for slot, r in zip(order, dispatched):
        responses[slot] = r
    return responses


def _summarize_batch(responses: list[Response], elapsed: float) -> dict[str, Any]:
    """Aggregate a finished batch into a one-line summary: counts, token totals, cost, wall-clock.

    A pure function (no I/O) so it is cheap and unit-testable; :func:`infer` logs its result.
    """
    errors = prompt_tokens = completion_tokens = 0
    # cost starts at int 0 (matching sum()'s default start=0) so an empty batch
    # keeps cost as int 0, not float 0.0; a non-empty batch promotes it to float.
    cost = 0
    for r in responses:
        if r.error is not None:
            errors += 1
        usage = r.usage
        prompt_tokens += usage.get("prompt_tokens", 0)
        completion_tokens += usage.get("completion_tokens", 0)
        cost += r.cost
    return {
        "requests": len(responses),
        "errors": errors,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "cost": round(cost, 6),
        "elapsed_s": round(elapsed, 3),
    }


async def _aclose(backend: Backend) -> None:
    """Close ``backend`` if it exposes ``aclose`` (releases its connection pool); else no-op.

    Every shipped backend implements ``aclose``; the ``getattr`` probe is what lets a minimal
    duck-typed backend (e.g. a test double that implements only ``generate``) run unchanged.
    """
    closer = getattr(backend, "aclose", None)
    if closer is not None:
        await closer()


async def _run_one(
    backend: Backend, request: Request, semaphore: asyncio.Semaphore
) -> Response:
    """Generate one response, capturing any terminal error into ``Response.error``."""
    async with semaphore:
        try:
            # tools is passed unconditionally (None for a plain request) rather than only when set:
            # it is part of the Backend protocol's signature, so a conforming transport takes it,
            # and one call shape means the tool-calling batch is not a second code path here.
            return await backend.generate(request.messages, tools=request.tools)
        except (
            Exception
        ) as e:  # backend exhausted its retries -> record, don't sink the batch
            logger.warning("request failed: %s", e)
            return Response(error=str(e))
