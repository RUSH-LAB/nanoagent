"""The sglang transport: what goes on the wire, and what comes back as a Response.

Every request in the package goes through this module, so the two things pinned here are the
request body it builds and the normalization of the reply — including the two shapes SGLang
produces that plain OpenAI does not (a separated reasoning field, and an inline ``<think>`` block).
The OpenAI client is replaced with a recorder, so no server is needed and the assertions are on
the exact kwargs rather than on a mock's call count.
"""

from __future__ import annotations

from types import SimpleNamespace as NS
from typing import Any

import httpx
import openai
import pytest

from nanoagent.inference import LeanInferConfig
from nanoagent.inference.backends import sglang as sglang_mod
from nanoagent.inference.backends.sglang import SglangBackend


def _completion(
    *,
    content: str | None = "hi",
    reasoning: str | None = None,
    reasoning_field: str = "reasoning_content",
    tool_calls: list[Any] | None = None,
    usage: Any = None,
    finish_reason: str = "stop",
) -> NS:
    """One non-streamed chat completion, in the SDK's attribute shape."""
    message = NS(content=content, tool_calls=tool_calls, model_extra=None)
    if reasoning is not None:
        setattr(message, reasoning_field, reasoning)
    return NS(choices=[NS(message=message, finish_reason=finish_reason)], usage=usage)


def _tool_call(id_: str, name: str, arguments: str) -> NS:
    return NS(id=id_, function=NS(name=name, arguments=arguments))


class FakeStream:
    """An OpenAI AsyncStream stand-in: iterable once, and records whether it was closed."""

    def __init__(self, chunks: list[Any]) -> None:
        self.chunks = chunks
        self.closed = False

    async def __aiter__(self):
        for c in self.chunks:
            yield c

    async def close(self) -> None:
        self.closed = True


@pytest.fixture
def wire(monkeypatch):
    """Replaces AsyncOpenAI with a recorder. ``wire.sent`` is the kwargs of each create() call;
    set ``wire.reply`` to the object (or exception) create() should produce."""
    recorder = NS(sent=[], reply=_completion(), closed=False)

    async def create(**kwargs: Any) -> Any:
        recorder.sent.append(kwargs)
        if isinstance(recorder.reply, BaseException):
            raise recorder.reply
        return recorder.reply

    async def close() -> None:
        recorder.closed = True

    client = NS(chat=NS(completions=NS(create=create)), close=close)
    monkeypatch.setattr(sglang_mod, "AsyncOpenAI", lambda **_kw: client)
    monkeypatch.setattr(sglang_mod, "DefaultAsyncHttpxClient", lambda **_kw: None)
    return recorder


def _backend(**kw: Any) -> SglangBackend:
    return SglangBackend("org/m", base_url="http://h:1/v1", **kw)


# ─── the request body ────────────────────────────────────────────────────────────────────────


async def test_the_request_carries_the_model_messages_and_sampling(wire) -> None:
    await _backend(temperature=0.7, max_tokens=64).generate([{"role": "user", "content": "q"}])
    sent = wire.sent[0]
    assert sent["model"] == "org/m"
    assert sent["messages"] == [{"role": "user", "content": "q"}]
    assert (sent["temperature"], sent["max_tokens"]) == (0.7, 64)


async def test_an_unset_max_tokens_is_omitted_rather_than_sent_as_null(wire) -> None:
    """`max_tokens: null` means "the server's own limit"; sending the key as None would instead
    be a request the server has to interpret."""
    await _backend(max_tokens=None).generate([{"role": "user", "content": "q"}])
    assert "max_tokens" not in wire.sent[0]


async def test_extra_body_sampling_passes_through_verbatim(wire) -> None:
    """The non-OpenAI knobs (top_k, min_p, repetition_penalty) are exactly why extra_body exists —
    nanoagent.inference must not have an opinion about their names."""
    await _backend(extra_body={"top_k": 20, "min_p": 0.0}).generate([{"role": "user", "content": "q"}])
    assert wire.sent[0]["extra_body"] == {"top_k": 20, "min_p": 0.0}


async def test_tools_are_sent_only_when_the_caller_has_any(wire) -> None:
    """A bare `tools: []` changes how some servers template the prompt, so the plain batch path
    must not send the key at all."""
    backend = _backend()
    await backend.generate([{"role": "user", "content": "q"}])
    await backend.generate([{"role": "user", "content": "q"}], tools=[{"type": "function"}])
    assert "tools" not in wire.sent[0]
    assert wire.sent[1]["tools"] == [{"type": "function"}]


async def test_the_batch_path_does_not_stream(wire) -> None:
    await _backend().generate([{"role": "user", "content": "q"}])
    assert "stream" not in wire.sent[0]


# ─── the reply ───────────────────────────────────────────────────────────────────────────────


async def test_a_plain_reply_becomes_text_and_finish_reason(wire) -> None:
    wire.reply = _completion(content="the answer", finish_reason="length")
    out = await _backend().generate([{"role": "user", "content": "q"}])
    assert (out.text, out.finish_reason, out.error) == ("the answer", "length", None)


async def test_tool_calls_are_normalized_away_from_the_sdk_shape(wire) -> None:
    wire.reply = _completion(content=None, tool_calls=[_tool_call("c1", "search", '{"q":"x"}')])
    out = await _backend().generate([{"role": "user", "content": "q"}])
    assert [(c.id, c.name, c.arguments) for c in out.tool_calls] == [("c1", "search", '{"q":"x"}')]
    assert out.text is None  # a pure tool turn has no answer text


async def test_usage_is_reported_and_priced(wire) -> None:
    wire.reply = _completion(usage=NS(prompt_tokens=1000, completion_tokens=2000, total_tokens=3000))
    out = await _backend(input_price=1.0, output_price=2.0).generate([{"role": "user", "content": "q"}])
    assert out.usage == {"prompt_tokens": 1000, "completion_tokens": 2000, "total_tokens": 3000}
    assert out.cost == pytest.approx((1000 * 1.0 + 2000 * 2.0) / 1e6)


async def test_reasoning_tokens_are_surfaced_only_when_the_server_breaks_them_out(wire) -> None:
    """`completion_tokens_details` is absent on some SGLang builds; a missing key must not become
    a reasoning_tokens: 0 that reads as "the model didn't think"."""
    base = NS(prompt_tokens=1, completion_tokens=2, total_tokens=3)
    wire.reply = _completion(usage=base)
    assert "reasoning_tokens" not in (await _backend().generate([])).usage

    base.completion_tokens_details = NS(reasoning_tokens=7)
    wire.reply = _completion(usage=base)
    assert (await _backend().generate([])).usage["reasoning_tokens"] == 7


async def test_a_reply_without_usage_costs_nothing_instead_of_raising(wire) -> None:
    wire.reply = _completion(usage=None)
    out = await _backend(input_price=5.0).generate([{"role": "user", "content": "q"}])
    assert (out.usage, out.cost) == ({}, 0.0)


# ─── reasoning ───────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("field", ["reasoning_content", "reasoning"])
async def test_a_server_separated_trace_is_read_under_either_field_name(wire, field: str) -> None:
    """The field is not in the OpenAI schema, so its name varies by model/build."""
    wire.reply = _completion(content="answer", reasoning="thinking", reasoning_field=field)
    out = await _backend().generate([{"role": "user", "content": "q"}])
    assert (out.text, out.reasoning) == ("answer", "thinking")


async def test_a_trace_hiding_in_model_extra_is_still_found(wire) -> None:
    """Where the SDK actually parks unknown fields when it has no typed attribute for them."""
    message = NS(content="answer", tool_calls=None, model_extra={"reasoning_content": "thinking"})
    wire.reply = NS(choices=[NS(message=message, finish_reason="stop")], usage=None)
    out = await _backend().generate([{"role": "user", "content": "q"}])
    assert (out.text, out.reasoning) == ("answer", "thinking")


async def test_parse_thinking_splits_an_inline_block_the_server_left_in_the_text(wire) -> None:
    wire.reply = _completion(content="<think>weighing it</think>the answer")
    out = await _backend(parse_thinking=True).generate([{"role": "user", "content": "q"}])
    assert (out.text, out.reasoning) == ("the answer", "weighing it")


async def test_parse_thinking_off_leaves_the_text_verbatim(wire) -> None:
    wire.reply = _completion(content="<think>weighing it</think>the answer")
    out = await _backend(parse_thinking=False).generate([{"role": "user", "content": "q"}])
    assert out.text == "<think>weighing it</think>the answer"
    assert out.reasoning is None


async def test_a_server_separated_trace_is_not_re_split(wire) -> None:
    """With both parse_thinking on AND the server separating the trace, the answer must not be
    searched for a `<think>` block it never contained."""
    wire.reply = _completion(content="answer </think> mentioning the tag", reasoning="thinking")
    out = await _backend(parse_thinking=True).generate([{"role": "user", "content": "q"}])
    assert (out.text, out.reasoning) == ("answer </think> mentioning the tag", "thinking")


# ─── streaming ───────────────────────────────────────────────────────────────────────────────


def _chunk(*, content: str | None = None, reasoning: str | None = None, tool_calls: list[Any] | None = None,
           finish_reason: str | None = None) -> NS:
    delta = NS(content=content, tool_calls=tool_calls, model_extra=None)
    if reasoning is not None:
        delta.reasoning_content = reasoning
    return NS(choices=[NS(delta=delta, finish_reason=finish_reason)], usage=None)


def _fragment(index: int, *, id_: str = "", name: str = "", arguments: str = "") -> NS:
    return NS(index=index, id=id_, function=NS(name=name, arguments=arguments))


async def test_streaming_asks_for_usage_on_the_final_chunk(wire) -> None:
    """Without stream_options the streamed path would report no tokens and no cost at all."""
    wire.reply = FakeStream([])
    await _backend().generate([{"role": "user", "content": "q"}], on_delta=lambda *_: None)
    assert wire.sent[0]["stream"] is True
    assert wire.sent[0]["stream_options"] == {"include_usage": True}


async def test_deltas_fire_live_and_reassemble_into_the_same_response(wire) -> None:
    wire.reply = FakeStream(
        [
            _chunk(reasoning="wei"),
            _chunk(reasoning="ghing"),
            _chunk(content="the "),
            _chunk(content="answer", finish_reason="stop"),
            NS(choices=[], usage=NS(prompt_tokens=3, completion_tokens=4, total_tokens=7)),
        ]
    )
    seen: list[tuple[str, str]] = []
    out = await _backend().generate([{"role": "user", "content": "q"}], on_delta=lambda k, t: seen.append((k, t)))
    assert seen == [("reasoning", "wei"), ("reasoning", "ghing"), ("content", "the "), ("content", "answer")]
    assert (out.text, out.reasoning, out.finish_reason) == ("the answer", "weighing", "stop")
    assert out.usage["total_tokens"] == 7  # the terminal empty-choices chunk


async def test_streamed_tool_call_fragments_are_reassembled_by_index(wire) -> None:
    """Arguments arrive a few characters at a time, interleaved across parallel calls; only the
    index ties the pieces together."""
    wire.reply = FakeStream(
        [
            _chunk(tool_calls=[_fragment(0, id_="c0", name="search", arguments='{"q":')]),
            _chunk(tool_calls=[_fragment(1, id_="c1", name="fetch", arguments='{"u":')]),
            _chunk(tool_calls=[_fragment(0, arguments='"x"}')]),
            _chunk(tool_calls=[_fragment(1, arguments='"y"}')]),
        ]
    )
    out = await _backend().generate([{"role": "user", "content": "q"}], on_delta=lambda *_: None)
    assert [(c.id, c.name, c.arguments) for c in out.tool_calls] == [
        ("c0", "search", '{"q":"x"}'),
        ("c1", "fetch", '{"u":"y"}'),
    ]


async def test_an_abandoned_stream_is_closed_so_its_connection_returns_to_the_pool(wire) -> None:
    """The pool is sized to concurrency, so a connection left checked out by an unread body costs
    a permanent concurrency slot — the batch degrades run after run instead of failing."""
    stream = FakeStream([_chunk(content="a"), _chunk(content="b")])
    wire.reply = stream

    def explode(_kind: str, _text: str) -> None:
        raise RuntimeError("the consumer blew up")

    with pytest.raises(RuntimeError, match="blew up"):
        await _backend().generate([{"role": "user", "content": "q"}], on_delta=explode)
    assert stream.closed


async def test_a_fully_drained_stream_is_not_closed_twice(wire) -> None:
    stream = FakeStream([_chunk(content="a")])
    wire.reply = stream
    await _backend().generate([{"role": "user", "content": "q"}], on_delta=lambda *_: None)
    assert not stream.closed  # draining already released the connection


# ─── errors and construction ─────────────────────────────────────────────────────────────────


def _api_error(cls: type, status: int) -> Exception:
    request = httpx.Request("POST", "http://h:1/v1/chat/completions")
    return cls("boom", response=httpx.Response(status, request=request), body=None)


async def test_a_4xx_is_not_retried(wire, monkeypatch) -> None:
    """A malformed request or a rejected key fails identically every time; retrying it just makes
    the caller wait out the whole backoff schedule for the same error."""
    slept: list[float] = []

    async def fake_sleep(d: float) -> None:
        slept.append(d)

    monkeypatch.setattr("nanoagent.inference.backend.asyncio.sleep", fake_sleep)
    wire.reply = _api_error(openai.BadRequestError, 400)
    with pytest.raises(openai.BadRequestError):
        await _backend(max_retries=3).generate([{"role": "user", "content": "q"}])
    assert (len(wire.sent), slept) == (1, [])


async def test_a_5xx_is_retried(wire, monkeypatch) -> None:
    slept: list[float] = []

    async def fake_sleep(d: float) -> None:
        slept.append(d)

    monkeypatch.setattr("nanoagent.inference.backend.asyncio.sleep", fake_sleep)
    wire.reply = _api_error(openai.InternalServerError, 503)
    with pytest.raises(openai.InternalServerError):
        await _backend(max_retries=2, retry_base_delay=1.0).generate([{"role": "user", "content": "q"}])
    assert len(wire.sent) == 3  # the initial call plus max_retries


async def test_aclose_releases_the_pool(wire) -> None:
    backend = _backend()
    await backend.aclose()
    assert wire.closed


def test_a_sglang_config_without_an_endpoint_is_refused(wire) -> None:
    """base_url is what makes an sglang config an sglang config; the SDK's own error would name
    an env var this package never reads."""
    with pytest.raises(ValueError, match="base_url"):
        SglangBackend.from_config(LeanInferConfig(base_url=None))


def test_the_connection_pool_is_sized_to_the_configured_concurrency(wire) -> None:
    """If the pool were smaller than the semaphore, admitted requests would queue on a connection
    and the concurrency knob would silently stop meaning anything."""
    backend = SglangBackend.from_config(LeanInferConfig(base_url="http://h:1/v1", concurrency=37))
    assert backend._limits.max_connections == 37
    assert backend._limits.max_keepalive_connections == 37


def test_a_null_extra_body_param_is_dropped_rather_than_sent(wire) -> None:
    """`extra_body: {}` MERGES onto an inherited base under OmegaConf instead of replacing it, so
    null is the only way a config can switch off a sampling knob its parent set. Sending
    an SGLang-only knob to a stricter gateway is a 400 on every request."""
    backend = SglangBackend.from_config(
        LeanInferConfig(base_url="http://h:1/v1", extra_body={"repetition_penalty": None, "top_k": 20})
    )
    assert backend._base_kwargs["extra_body"] == {"top_k": 20}


def test_an_all_null_extra_body_sends_no_extra_body_at_all(wire) -> None:
    backend = SglangBackend.from_config(
        LeanInferConfig(base_url="http://h:1/v1", extra_body={"repetition_penalty": None})
    )
    assert "extra_body" not in backend._base_kwargs


def test_a_subclass_can_rename_the_token_budget_field(wire) -> None:
    """OpenAI deprecated `max_tokens` for `max_completion_tokens` and gateways disagree about
    which they take — one that 400s on the old name is otherwise unreachable without a second
    copy of the request builder."""

    class Renamed(SglangBackend):
        token_budget_param = "max_completion_tokens"

    backend = Renamed.from_config(LeanInferConfig(base_url="http://h:1/v1", max_tokens=256))
    assert backend._base_kwargs["max_completion_tokens"] == 256
    assert "max_tokens" not in backend._base_kwargs


def test_a_null_temperature_is_omitted_from_the_request(wire) -> None:
    """A reasoning deployment rejects an explicit temperature once reasoning_effort is set (gpt-5*
    wants it absent, Claude wants exactly 1), so a temperature that is always sent puts those
    models out of reach entirely."""
    backend = SglangBackend.from_config(
        LeanInferConfig(base_url="http://h:1/v1", temperature=None)
    )
    assert "temperature" not in backend._base_kwargs


def test_a_zero_temperature_is_still_sent(wire) -> None:
    """Greedy decoding is the default and the reason most batches are reproducible — 0.0 must stay
    an explicit request, not be mistaken for "unset" and dropped."""
    backend = SglangBackend.from_config(
        LeanInferConfig(base_url="http://h:1/v1", temperature=0.0)
    )
    assert backend._base_kwargs["temperature"] == 0.0


def test_the_pool_settings_come_from_the_httpx_the_installed_sdk_uses() -> None:
    """openai 1.x/2.x builds on `httpx`, openai >=3 on the renamed `httpx2`. Handing the client a
    Timeout from the OTHER one is not a clean failure: it dies inside the connection pool as
    "unsupported operand type(s) for +: 'float' and 'Timeout'", which the SDK wraps as a bare
    APIConnectionError on every request — indistinguishable from an unreachable endpoint. So
    assert the objects are the SDK's own types rather than that they merely have the right
    fields, which is exactly the check a duck-typed Limits would pass while Timeout did not."""
    import importlib

    # Resolved from the real SDK, not from sglang_mod._httpx, which would only assert that the
    # module the backend picked is the module the backend picked. No `wire` fixture either: it
    # replaces DefaultAsyncHttpxClient, and a real AsyncOpenAI opens no connection at construction.
    sdk_httpx = importlib.import_module(
        openai.DefaultAsyncHttpxClient.__mro__[1].__module__.partition(".")[0]
    )
    backend = SglangBackend.from_config(LeanInferConfig(base_url="http://h:1/v1"))
    assert isinstance(backend._timeout, sdk_httpx.Timeout)
    assert isinstance(backend._limits, sdk_httpx.Limits)
