"""SGLang's NATIVE ``/generate`` endpoint: ids in, ids out.

The same server as :mod:`nanoagent.inference.backends.sglang`, through the other door. The
``/v1`` chat endpoint templates the conversation itself and answers in text; ``/generate`` takes
``input_ids`` and — with ``return_logprob`` — answers with the ids it sampled and their logprobs.
So this is the only transport in the package whose
:class:`~nanoagent.inference.types.Tokens` are :attr:`~nanoagent.inference.types.Fidelity.NATIVE`,
and the only one an RL trainer can compute a per-token loss against.

The trade, and it is the whole trade: **the client owns the chat template**. ``config.tokenizer``
is required, :meth:`Tokenizer.render` produces the prompt, and the server applies nothing. That
removes the usual train/serve skew — a trainer rendering with the same tokenizer object cannot
drift from the sampler — and it moves two jobs client-side that ``/v1`` used to do:

  * **tool calling is not implemented here.** ``/generate`` returns raw text with no
    ``tool_calls``, so the model's call has to be parsed out of the completion, and the format is
    per-model (hermes / pythonic / llama3-json / gemma's ``<|tool_call>`` special token) rather
    than per-server. Passing ``tools`` raises instead of silently returning an empty
    :attr:`Response.tool_calls`, which would look to an agent loop like a model that never calls
    a tool.
  * **streaming is not implemented here** either; ``on_delta`` fires once with the whole answer,
    which is the fallback the :class:`~nanoagent.inference.backend.Backend` protocol allows.

So: use this to generate or score a batch (:func:`~nanoagent.inference.engine.infer`), and the
``/v1`` transport to drive an agent.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from nanoagent.inference.backend import retry_async, token_cost
from nanoagent.inference.config import LeanInferConfig
from nanoagent.inference.http import httpx as _httpx
from nanoagent.inference.thinking import split_thinking
from nanoagent.inference.tokenizer import Tokenizer, load_tokenizer
from nanoagent.inference.types import Fidelity, Response, Tokens

# Same reasoning as the /v1 transport: keep idle pooled connections alive across a batch, and
# decorrelate concurrent retries with full jitter.
_KEEPALIVE_EXPIRY: float = 60.0
_RETRY_JITTER: float = 1.0
_DEFAULT_MAX_CONNECTIONS: int = 100


class FatalHTTPError(Exception):
    """A 4xx from ``/generate`` — a malformed request, which fails the same way on every retry.

    The ``/v1`` transport gets this for free from the SDK's typed exception hierarchy
    (``BadRequestError`` and friends). Talking to the native endpoint over a plain HTTP client
    there is no hierarchy, only a status code, so the fail-fast class is made here and handed to
    :func:`~nanoagent.inference.backend.retry_async` as an abort error.
    """


class SglangNativeBackend:
    """Async backend over SGLang's ``/generate``: renders ids locally, returns the sampled ids."""

    fidelity = Fidelity.NATIVE

    def __init__(
        self,
        *,
        base_url: str,
        tokenizer: Tokenizer,
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
        self._tokenizer = tokenizer
        self.parse_thinking = parse_thinking
        self.input_price = input_price
        self.output_price = output_price
        self.max_retries = max_retries
        self.retry_base_delay = retry_base_delay
        self.retry_max_delay = retry_max_delay
        # `/generate` hangs off the server ROOT, while every config in the wild writes base_url as
        # the OpenAI-compatible `.../v1`. Dropping that suffix is what lets one config switch
        # between the two transports by changing `backend:` and nothing else.
        self._url = base_url.rstrip("/").removesuffix("/v1") + "/generate"
        # Native sampling params, NOT the OpenAI ones: the budget is `max_new_tokens` here. A None
        # value is omitted rather than sent, for the same reason as on the /v1 side (an explicit
        # null is a request the server has to interpret). extra_body rides along verbatim, which
        # is how top_k / min_p / stop / skip_special_tokens are reached.
        sampling: dict[str, Any] = {
            k: v for k, v in (extra_body or {}).items() if v is not None
        }
        if temperature is not None:
            sampling["temperature"] = temperature
        if max_tokens is not None:
            sampling["max_new_tokens"] = max_tokens
        self._sampling = sampling
        self._client = _httpx.AsyncClient(
            limits=_httpx.Limits(
                max_connections=max_connections,
                max_keepalive_connections=max_connections,
                keepalive_expiry=_KEEPALIVE_EXPIRY,
            ),
            timeout=_httpx.Timeout(request_timeout, connect=30.0, pool=5.0),
        )

    @classmethod
    def from_config(cls, cfg: LeanInferConfig) -> SglangNativeBackend:
        """Build from a ``backend: sglang_native`` config; both endpoint and tokenizer are required."""
        if cfg.base_url is None:
            raise ValueError(
                "backend='sglang_native' requires config.base_url (an SGLang endpoint)"
            )
        if cfg.tokenizer is None:
            raise ValueError(
                "backend='sglang_native' requires config.tokenizer: this transport sends input_ids, "
                "so the chat template is applied HERE and there is no server-side default to fall back on"
            )
        return cls(
            base_url=cfg.base_url,
            tokenizer=load_tokenizer(cfg.tokenizer),
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
            max_connections=max(1, cfg.concurrency),
        )

    async def generate(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        on_delta: Callable[[str, str], None] | None = None,
    ) -> Response:
        """Render ``messages`` to ids, sample, and return the reply with its NATIVE tokens."""
        if tools:
            raise NotImplementedError(
                "backend='sglang_native' does not parse tool calls: /generate returns raw text, and "
                "the call format is per-model. Use backend='sglang' (the /v1 endpoint) for an agent loop"
            )
        prompt_ids = self._tokenizer.render(messages)
        payload = {
            "input_ids": prompt_ids,
            "sampling_params": self._sampling,
            # The ONLY way ids come back: /generate's `text` is detokenized, and the sampled ids
            # ride along in meta_info.output_token_logprobs. Not an optional extra here — without
            # it this transport has nothing that the /v1 one does not already do better.
            "return_logprob": True,
        }
        data = await retry_async(
            lambda: self._post(payload),
            max_retries=self.max_retries,
            base_delay=self.retry_base_delay,
            max_delay=self.retry_max_delay,
            jitter=_RETRY_JITTER,
            abort_errors=(FatalHTTPError,),
        )
        response = self._to_response(prompt_ids, data)
        if on_delta is not None and response.text:  # no SSE here: one delta, at the end
            on_delta("content", response.text)
        return response

    async def _post(self, payload: dict[str, Any]) -> Any:
        reply = await self._client.post(self._url, json=payload)
        if 400 <= reply.status_code < 500:
            raise FatalHTTPError(f"{reply.status_code} from {self._url}: {reply.text}")
        reply.raise_for_status()
        return reply.json()

    async def aclose(self) -> None:
        """Close the underlying HTTP client, releasing its pooled connections."""
        await self._client.aclose()

    def _to_response(self, prompt_ids: list[int], data: Any) -> Response:
        meta = data.get("meta_info") or {}
        # [logprob, token_id, token_text] per sampled token — SGLang's wire shape for
        # output_token_logprobs. Absent means the server ignored return_logprob (an old build, or
        # a proxy that dropped the field), and there is nothing to fall back on but a local
        # re-encode, which would be a RECONSTRUCTED record wearing a NATIVE label. Refuse instead.
        entries = meta.get("output_token_logprobs")
        if entries is None:
            raise ValueError(
                f"{self._url} returned no output_token_logprobs; this transport exists to report the "
                "sampled ids, and this server did not (check it accepts return_logprob)"
            )
        usage = {
            "prompt_tokens": int(meta.get("prompt_tokens", len(prompt_ids))),
            "completion_tokens": int(meta.get("completion_tokens", len(entries))),
        }
        usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
        text, reasoning = self._split_reasoning(data.get("text") or None)
        return Response(
            text=text,
            reasoning=reasoning,
            usage=usage,
            cost=token_cost(usage, self.input_price, self.output_price),
            finish_reason=_finish_reason(meta.get("finish_reason")),
            tokens=Tokens(
                prompt_ids=prompt_ids,
                completion_ids=[int(e[1]) for e in entries],
                fidelity=Fidelity.NATIVE,
                tokenizer=self._tokenizer.name,
                logprobs=[float(e[0]) for e in entries],
            ),
        )

    def _split_reasoning(self, text: str | None) -> tuple[str | None, str | None]:
        """Pull a leading inline ``<think>`` block out of the text when ``parse_thinking`` is on.

        Unlike the ``/v1`` path there is no server-separated reasoning field to prefer:
        ``/generate`` returns whatever the model emitted, tags and all.
        """
        if not self.parse_thinking:
            return text, None
        reasoning, answer = split_thinking(text)
        return answer, reasoning


def _finish_reason(raw: Any) -> str | None:
    """Normalize ``/generate``'s finish reason to the string the ``/v1`` path reports.

    The native endpoint reports a dict (``{"type": "stop", "matched": 106}``) where the chat one
    reports ``"stop"``. Callers switch on :attr:`Response.finish_reason` without caring which
    transport produced it, so the difference is flattened here rather than at every use.
    """
    if isinstance(raw, dict):
        return raw.get("type")
    return raw


BACKEND = SglangNativeBackend
