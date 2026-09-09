"""Backend protocol with a shared async retry helper and a token-cost helper.

A backend turns one chat-message list into a :class:`~nanoagent.inference.types.Response`. The
sglang transport (:mod:`nanoagent.inference.backends.sglang`) implements :class:`Backend`.

:func:`retry_async` wraps a coroutine factory with exponential backoff, re-raising
immediately on caller-declared ``abort_errors`` (e.g. 4xx auth / bad-request, which
won't succeed on retry). The backoff schedule is ``base_delay * 2**attempt``. This
module imports no provider SDK, so importing it never pulls in the sglang backend's
``openai`` dependency.

:func:`token_cost` turns a usage dict and per-1M-token prices into the dollar cost of
one call — one formula every backend shares rather than each re-deriving it.
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar, Protocol

from nanoagent.inference.types import Fidelity, Response

logger: logging.Logger = logging.getLogger(__name__)


class Backend(Protocol):
    """One transport: turn an OpenAI-shape message list into a :class:`~nanoagent.inference.types.Response`.

    ``tools`` (OpenAI tool specs) advertises tool calling when given; the backend parses any
    requested calls into :attr:`~nanoagent.inference.types.Response.tool_calls`. ``on_delta(kind, text)``
    streams fragments live when given (``kind`` in ``{"reasoning", "content"}``); a transport
    that cannot stream emits the final text once. Both default to off, so the plain batch path
    (:func:`~nanoagent.inference.engine.infer`) calls ``generate(messages)`` unchanged. :meth:`aclose`
    releases transport resources (e.g. an HTTP connection pool); the batch path closes the
    backend it builds when the batch finishes.

    :attr:`fidelity` declares, on the CLASS, whether this transport can report the ids the
    sampler actually saw. It is read before an instance exists (by
    :func:`~nanoagent.inference.backends.build_backend`, deciding whether to wrap the transport in
    a reconstructing one), which is why it is a class attribute and not something ``from_config``
    computes. A transport written before this field existed is read as
    :attr:`~nanoagent.inference.types.Fidelity.RECONSTRUCTED`, which is the safe reading: an
    unannotated backend is an OpenAI-compatible one.
    """

    fidelity: ClassVar[Fidelity]

    async def generate(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        on_delta: Callable[[str, str], None] | None = None,
    ) -> Response: ...

    async def aclose(self) -> None: ...


async def retry_async(
    fn: Callable[[], Awaitable[Any]],
    *,
    max_retries: int,
    base_delay: float,
    max_delay: float = float("inf"),
    jitter: float = 0.0,
    abort_errors: tuple[type[Exception], ...] = (),
) -> Any:
    """Call ``fn`` with exponential backoff, returning its result on first success.

    ``abort_errors`` are re-raised immediately (no retry). Any other exception is treated as
    transient: back off and retry, up to ``max_retries`` times, then re-raise the last error.

    The base wait is ``base_delay * 2**attempt``, capped at ``max_delay`` so a high attempt
    count can't sleep for minutes. ``jitter`` (a fraction in ``[0, 1]``) then subtracts up to
    that fraction of the wait at random — ``jitter=1.0`` is full jitter — so many clients
    retrying a shared rate limit at once don't re-collide in lockstep (thundering herd).
    The defaults (no cap, no jitter) keep plain exponential backoff for callers that don't opt in.
    """
    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            return await fn()
        except abort_errors:  # caller-declared fail-fast errors -> don't retry
            raise
        except Exception as e:  # transient (network / rate-limit / 5xx) -> back off and retry
            last_error = e
            if attempt >= max_retries:
                break
            delay = min(max_delay, base_delay * (2**attempt))
            if jitter:
                delay *= 1.0 - jitter * random.random()
            logger.warning(
                "backend call failed (attempt %d/%d): %s; retrying in %.1fs",
                attempt + 1,
                max_retries + 1,
                e,
                delay,
            )
            await asyncio.sleep(delay)
    assert last_error is not None
    raise last_error


def token_cost(usage: dict[str, int], input_price: float, output_price: float) -> float:
    """Dollar cost of one call: (prompt*input_price + completion*output_price) per 1e6 tokens."""
    return (
        usage.get("prompt_tokens", 0) * input_price
        + usage.get("completion_tokens", 0) * output_price
    ) / 1_000_000
