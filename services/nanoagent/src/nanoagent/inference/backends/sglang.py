"""SGLang backend: chat completions over the OpenAI-compatible ``/v1`` endpoint.

SGLang serves an OpenAI-compatible API, so we point :class:`openai.AsyncOpenAI` at its
``base_url`` and call ``chat.completions.create``. :meth:`SglangBackend.generate` supports
both batch plain-text inference and tool-calling agent turns:

  * ``tools`` (OpenAI tool specs) are forwarded to the call; any tool calls in the reply are
    parsed into :attr:`~nanoagent.inference.types.Response.tool_calls`;
  * ``on_delta(kind, text)`` switches the call to streaming and fires per fragment as it
    arrives (``kind`` is ``"reasoning"`` for the model's ``<think>`` block or ``"content"``
    for the answer); tool-call fragments are reassembled internally, not streamed.
  * ``extra_body`` (extra sampling params, e.g. ``{repetition_penalty: 1.05}``) is passed
    through verbatim on the request.

Transient errors retry with backoff (fail-fast on 4xx); the response is normalized into a
:class:`~nanoagent.inference.types.Response` (text + tool calls + token usage + computed cost). Cost is
computed from optional per-1M-token prices on the config; they default to 0, so cost stays 0
for a local model unless prices are set. Selected only when ``config.backend == "sglang"``
(see :func:`nanoagent.inference.backends.build_backend`), so this module — and its ``openai`` import —
is loaded only when a backend is actually built.

Serving note: tool calling requires the SGLang server to be started with tool-call support
for the model (e.g. ``--tool-call-parser <parser>``). Without it ``tool_calls`` is always
empty and the caller just gets the plain answer.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import openai
from openai import AsyncOpenAI, DefaultAsyncHttpxClient

from nanoagent.inference.backend import retry_async, token_cost
from nanoagent.inference.config import LeanInferConfig
from nanoagent.inference.http import httpx as _httpx
from nanoagent.inference.thinking import split_thinking
from nanoagent.inference.types import Fidelity, Response, ToolCall

# 4xx / auth errors won't succeed on retry — fail fast on these.
_ABORT_ERRORS: tuple[type[Exception], ...] = (
    openai.AuthenticationError,
    openai.PermissionDeniedError,
    openai.NotFoundError,
    openai.BadRequestError,
    openai.UnprocessableEntityError,
)

# Keep an idle pooled connection alive this long (seconds) so a batch of requests reuses the
# same TCP/TLS connections instead of re-handshaking per call.
_KEEPALIVE_EXPIRY: float = 60.0
# Full jitter on the retry backoff: decorrelates many concurrent clients that hit a shared
# rate limit at the same instant, so their retries don't re-collide in lockstep.
_RETRY_JITTER: float = 1.0
# Pool size when the caller doesn't size it to its concurrency (matches the httpx default).
_DEFAULT_MAX_CONNECTIONS: int = 100
# Streaming asks SGLang to ride token usage on the final (empty-choices) chunk. Hoisted to a
# module constant so the streaming hot path (the gemma-4-31B-it delta-callback path) references
# one shared dict instead of rebuilding a fresh one-key dict per streamed completion. Never
# mutated after assignment (the SDK only reads it to build the request), so sharing one instance
# is safe — the per-call kwargs already alias extra_body by reference the same way.
_STREAM_OPTIONS: dict[str, bool] = {"include_usage": True}


def _reasoning_text(obj: Any) -> str | None:
    """Pull the ``<think>`` text out of a streaming delta or a final message, across SDK variations.

    Reasoning isn't part of the OpenAI schema, so the SDK keeps the field in ``model_extra``
    rather than a typed attribute. The field is ``reasoning`` on some models and
    ``reasoning_content`` on others; check both names, and both the typed-attribute and
    ``model_extra`` locations so this keeps working if a future SDK promotes either to a real
    field. Works on both a streaming ``delta`` and a non-streamed ``message`` (same shape).
    Returns ``None`` when absent.
    """
    reasoning = getattr(obj, "reasoning_content", None) or getattr(
        obj, "reasoning", None
    )
    # Typed attr present (common on streamed deltas) -> skip the model_extra probe entirely.
    if reasoning:
        return reasoning
    extra = getattr(obj, "model_extra", None)
    if not extra:
        return None
    return extra.get("reasoning_content") or extra.get("reasoning")


class SglangBackend:
    """Async chat backend over ``AsyncOpenAI.chat.completions`` for SGLang."""

    #: Text in, text out. The chat API reports token COUNTS and no ids — that is true of SGLang's
    #: own ``/v1`` endpoint as much as of a hosted gateway — so any ids attributed to a reply from
    #: here were produced locally. :mod:`nanoagent.inference.backends.sglang_native` is the same
    #: server through the endpoint that does return them.
    fidelity = Fidelity.RECONSTRUCTED

    #: The request field carrying the output-token budget. OpenAI deprecated ``max_tokens`` in
    #: favour of ``max_completion_tokens``, and gateways disagree about which they accept — some
    #: newer deployments reject the old name with a 400. SGLang takes ``max_tokens``, so that is
    #: the default; a subclass (typically a plugin transport, see :mod:`nanoagent.inference.plugins`)
    #: overrides this one string rather than reimplementing the request builder.
    token_budget_param: str = "max_tokens"

    def __init__(
        self,
        model: str,
        *,
        base_url: str,
        api_key: str = "EMPTY",
        temperature: float | None = 0.0,
        max_tokens: int | None = None,
        extra_body: dict[str, Any] | None = None,
        parse_thinking: bool = False,
        input_price: float = 0.0,
        output_price: float = 0.0,
        max_retries: int = 3,
        retry_base_delay: float = 1.0,
        retry_max_delay: float = 60.0,
        request_timeout: float = 600.0,
        max_connections: int = _DEFAULT_MAX_CONNECTIONS,
    ) -> None:
        # A null value turns one param OFF, matching how SGLangServeConfig.extra_args treats
        # None. Without this a shared base config's sampling knob cannot be switched off by a
        # config that inherits it: `extra_body: {}` MERGES onto the parent under OmegaConf rather
        # than replacing it, so the parent's keys survive. That is not a cosmetic gap — sending
        # an SGLang-only knob like `repetition_penalty` to a stricter gateway is a 400 on every
        # request, and the only remaining fix would be to stop sharing the base config.
        extra_body = {k: v for k, v in (extra_body or {}).items() if v is not None}
        self.parse_thinking = parse_thinking
        self.input_price = input_price
        self.output_price = output_price
        self.max_retries = max_retries
        self.retry_base_delay = retry_base_delay
        self.retry_max_delay = retry_max_delay
        # The per-call request body minus messages/tools/stream, built once instead of
        # reassembled on every generate() call.
        self._base_kwargs: dict[str, Any] = {"model": model}
        # Omitted when None, the same way max_tokens is: a reasoning deployment rejects an explicit
        # temperature once reasoning_effort is set (gpt-5* wants it absent, Claude wants exactly 1),
        # so a value that is always sent makes those models unreachable. 0.0 is still sent.
        if temperature is not None:
            self._base_kwargs["temperature"] = temperature
        if max_tokens is not None:
            self._base_kwargs[self.token_budget_param] = max_tokens
        if extra_body:
            self._base_kwargs["extra_body"] = extra_body
        # Size the connection pool to the caller's concurrency so every in-flight request keeps
        # its own pooled (kept-alive) connection — no per-request handshake, no pool queueing.
        self._limits: Any = _httpx.Limits(
            max_connections=max_connections,
            max_keepalive_connections=max_connections,
            keepalive_expiry=_KEEPALIVE_EXPIRY,
        )
        # One stuck call shouldn't pin a concurrency slot forever; connect and pool-acquire are
        # capped well below request_timeout so a genuinely stuck call fails fast into the retry path.
        # connect is 30s (not a few seconds): under an SGLang cold-start thundering herd — many
        # concurrent rollouts hitting the server while it warms up — the TCP accept backlog can take
        # tens of seconds to clear, and a 5s connect cap turned that transient into a hard
        # APITimeout that abandoned the task. pool stays low: with the pool sized to concurrency a
        # pool wait never happens, so a >5s wait means a real leak worth failing fast on.
        self._timeout: Any = _httpx.Timeout(request_timeout, connect=30.0, pool=5.0)
        # SGLang ignores the key, but the OpenAI SDK requires a non-empty string.
        # max_retries=0: retry_async owns retries; the SDK's own (default 2) would nest under
        # ours into a multiplicative storm.
        self._client = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
            max_retries=0,
            http_client=DefaultAsyncHttpxClient(
                limits=self._limits, timeout=self._timeout
            ),
        )

    @classmethod
    def from_config(cls, cfg: LeanInferConfig) -> SglangBackend:
        """Build a :class:`SglangBackend` from a ``backend: sglang`` config."""
        if cfg.base_url is None:
            raise ValueError(
                "backend='sglang' requires config.base_url (an SGLang /v1 endpoint)"
            )
        return cls(
            cfg.model,
            base_url=cfg.base_url,
            api_key=cfg.api_key or "EMPTY",
            temperature=cfg.temperature,
            max_tokens=cfg.max_tokens,
            extra_body=dict(cfg.extra_body or {}),
            parse_thinking=cfg.parse_thinking,
            input_price=cfg.input_price,
            output_price=cfg.output_price,
            max_retries=cfg.max_retries,
            retry_base_delay=cfg.retry_base_delay,
            retry_max_delay=cfg.retry_max_delay,
            request_timeout=cfg.request_timeout,
            # Match the pool to the engine's concurrency cap, so the semaphore — not the HTTP
            # pool — is the only limiter and no admitted request waits for a free connection.
            max_connections=max(1, cfg.concurrency),
        )

    async def generate(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        on_delta: Callable[[str, str], None] | None = None,
    ) -> Response:
        """Run one chat completion (with retry) and return a normalized :class:`Response`.

        With ``on_delta`` set, stream the completion and call ``on_delta(kind, text)`` for each
        fragment as it arrives — ``kind`` is ``"reasoning"`` (the model's ``<think>`` block,
        extracted by :func:`_reasoning_text`) or ``"content"`` (the answer). The returned
        :class:`Response` is identical to the non-streamed path; streaming only adds the live
        callback (tool-call fragments are reassembled internally, not streamed).
        """
        kwargs: dict[str, Any] = {**self._base_kwargs, "messages": messages}
        if tools:
            kwargs["tools"] = tools
        if on_delta is None:
            response = await self._create_with_retry(kwargs)
            return self._to_response(response)
        kwargs["stream"] = True
        kwargs["stream_options"] = _STREAM_OPTIONS  # usage rides the final chunk
        stream = await self._create_with_retry(kwargs)
        try:
            return await self._consume_stream(stream, on_delta)
        except BaseException:
            # on_delta (or chunk handling) raised, OR the consuming task was CANCELLED, mid-iteration:
            # the abandoned async-for leaves the body unread, and the OpenAI AsyncStream returns its
            # httpx connection to the pool only when fully read or closed -- so close it here, else the
            # connection stays checked out and the pool (sized to concurrency) permanently loses the
            # slot. Catch BaseException, not Exception: asyncio.CancelledError -- raised on the Block-3
            # caps/timeouts kill path -- subclasses BaseException, so `except Exception` would skip the
            # close and leak the slot on cancellation. The bare `raise` re-propagates the original
            # (incl. CancelledError) unchanged; the fully-drained happy path already releases the
            # connection, so it needs no close.
            await stream.close()
            raise

    async def _create_with_retry(self, kwargs: dict[str, Any]) -> Any:
        """One ``chat.completions.create`` call, retried with capped, jittered backoff (fail-fast on 4xx)."""
        return await retry_async(
            lambda: self._client.chat.completions.create(**kwargs),
            max_retries=self.max_retries,
            base_delay=self.retry_base_delay,
            max_delay=self.retry_max_delay,
            jitter=_RETRY_JITTER,
            abort_errors=_ABORT_ERRORS,
        )

    async def aclose(self) -> None:
        """Close the underlying HTTP client, releasing its pooled connections."""
        await self._client.close()

    async def _consume_stream(
        self, stream: Any, on_delta: Callable[[str, str], None]
    ) -> Response:
        """Reassemble a streamed completion into a :class:`Response`, emitting live deltas.

        SGLang streams the answer as ``delta.content`` and the ``<think>`` block in a
        non-OpenAI field that :func:`_reasoning_text` resolves (typically one token per
        chunk); tool calls arrive as indexed ``delta.tool_calls`` fragments whose
        ``arguments`` strings concatenate in order. The terminal usage chunk (from
        ``stream_options.include_usage``) carries ``usage`` with an empty ``choices`` list.
        Reasoning fragments are accumulated into :attr:`~nanoagent.inference.types.Response.reasoning`.
        """
        content: list[str] = []
        reasoning_parts: list[str] = []
        calls: dict[int, dict[str, Any]] = {}
        usage: dict[str, int] = {}
        finish_reason: str | None = None
        async for chunk in stream:
            if getattr(chunk, "usage", None):
                usage = self._usage(chunk)
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            chunk_finish = getattr(choice, "finish_reason", None)
            if chunk_finish:
                finish_reason = chunk_finish
            delta = choice.delta
            reasoning = _reasoning_text(delta)
            if reasoning:
                reasoning_parts.append(reasoning)
                on_delta("reasoning", reasoning)
            if delta.content:
                content.append(delta.content)
                on_delta("content", delta.content)
            for fragment in delta.tool_calls or []:
                slot = calls.get(fragment.index)
                if slot is None:
                    # annotate so the checker keeps "args" a list, not str
                    new_slot: dict[str, Any] = {"id": "", "name": "", "args": []}
                    slot = calls[fragment.index] = new_slot
                if fragment.id:
                    slot["id"] = fragment.id
                if fragment.function and fragment.function.name:
                    slot["name"] = fragment.function.name
                if fragment.function and fragment.function.arguments:
                    slot["args"].append(fragment.function.arguments)
        tool_calls = [
            ToolCall(id=s["id"], name=s["name"], arguments="".join(s["args"]))
            for _index, s in sorted(calls.items())
        ]
        text, reasoning_text = self._split_reasoning(
            "".join(content) or None, "".join(reasoning_parts) or None
        )
        return Response(
            text=text,
            reasoning=reasoning_text,
            tool_calls=tool_calls,
            usage=usage,
            cost=self._cost(usage),
            finish_reason=finish_reason,
        )

    def _to_response(self, response: Any) -> Response:
        choice = response.choices[0]
        message = choice.message
        tool_calls = [
            ToolCall(id=c.id, name=c.function.name, arguments=c.function.arguments)
            for c in (message.tool_calls or [])
        ]
        usage = self._usage(response)
        text, reasoning = self._split_reasoning(
            message.content or None, _reasoning_text(message)
        )
        return Response(
            text=text,
            reasoning=reasoning,
            tool_calls=tool_calls,
            usage=usage,
            cost=self._cost(usage),
            finish_reason=getattr(choice, "finish_reason", None),
        )

    def _split_reasoning(
        self, text: str | None, reasoning: str | None
    ) -> tuple[str | None, str | None]:
        """Resolve the (text, reasoning) split, honoring ``parse_thinking``.

        If the server already separated reasoning (``reasoning`` is set), keep that and leave
        the answer untouched. Otherwise, when ``parse_thinking`` is on, pull a leading inline
        ``<think>`` block out of ``text`` into ``reasoning``. With ``parse_thinking`` off, the
        text is returned verbatim.
        """
        if reasoning or not self.parse_thinking:
            return text, reasoning
        reasoning, answer = split_thinking(
            text
        )  # note: split_thinking is (reasoning, answer)
        return answer, reasoning

    def _cost(self, usage: dict[str, int]) -> float:
        return token_cost(usage, self.input_price, self.output_price)

    @staticmethod
    def _usage(response: Any) -> dict[str, int]:
        raw = getattr(response, "usage", None)
        if raw is None:
            return {}
        usage = {
            "prompt_tokens": getattr(raw, "prompt_tokens", 0) or 0,
            "completion_tokens": getattr(raw, "completion_tokens", 0) or 0,
            "total_tokens": getattr(raw, "total_tokens", 0) or 0,
        }
        # SGLang (when reasoning is parsed) breaks out the think-block subset of
        # completion_tokens here; absent on some builds, so surface it only when present.
        details = getattr(raw, "completion_tokens_details", None)
        reasoning = getattr(details, "reasoning_tokens", None) if details else None
        if reasoning:
            usage["reasoning_tokens"] = reasoning
        return usage


# What `backend: sglang` resolves to. A built-in declares itself exactly the way a plugin does
# (see nanoagent.inference.plugins), so build_backend has one code path and a plugin that subclasses this
# transport is not a special case.
BACKEND = SglangBackend
