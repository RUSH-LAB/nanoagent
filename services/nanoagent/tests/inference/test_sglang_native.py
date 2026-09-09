"""The native /generate transport: what goes on the wire, and what the reply becomes.

This is the token-in / token-out path, so the two things worth pinning are that the request really
carries ``input_ids`` (not a templated string the server would template again) and that the ids
coming back are the server's, not a local re-encode. The HTTP client is replaced with a recorder,
so no server is needed and the assertions are on the exact body.
"""

from __future__ import annotations

from types import SimpleNamespace as NS
from typing import Any

import pytest

from nanoagent.inference import Fidelity, LeanInferConfig
from nanoagent.inference.backends import sglang_native as native_mod
from nanoagent.inference.backends.sglang_native import FatalHTTPError, SglangNativeBackend

from tests.inference.test_tokenizer import MergingTokenizer


def _reply(
    *,
    text: str = "hi",
    output_logprobs: list[list[Any]] | None = ((-0.1, 11, None), (-0.2, 12, None)),
    finish_reason: Any = None,
    prompt_tokens: int = 5,
    completion_tokens: int = 2,
) -> dict[str, Any]:
    """One /generate reply, in SGLang's native JSON shape."""
    meta: dict[str, Any] = {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}
    if output_logprobs is not None:
        meta["output_token_logprobs"] = [list(e) for e in output_logprobs]
    meta["finish_reason"] = finish_reason if finish_reason is not None else {"type": "stop", "matched": 106}
    return {"text": text, "meta_info": meta}


@pytest.fixture
def wire(monkeypatch):
    """Replaces the async HTTP client with a recorder. ``wire.sent`` is each POST body; set
    ``wire.reply`` to the JSON to answer with, or ``wire.status`` to fail instead."""
    recorder = NS(sent=[], reply=_reply(), status=200, closed=False)

    async def post(url: str, *, json: dict[str, Any]) -> Any:
        recorder.sent.append(json)
        recorder.url = url

        def raise_for_status() -> None:
            if recorder.status >= 400:
                raise RuntimeError(f"{recorder.status}")

        return NS(status_code=recorder.status, text="boom", json=lambda: recorder.reply, raise_for_status=raise_for_status)

    async def aclose() -> None:
        recorder.closed = True

    monkeypatch.setattr(
        native_mod,
        "_httpx",
        NS(AsyncClient=lambda **_kw: NS(post=post, aclose=aclose), Limits=lambda **kw: kw, Timeout=lambda *a, **kw: (a, kw)),
    )
    return recorder


def _backend(**kw: Any) -> SglangNativeBackend:
    return SglangNativeBackend(base_url="http://h:1/v1", tokenizer=MergingTokenizer(), **kw)


MESSAGES = [{"role": "user", "content": "hello"}]


# ─── the request ─────────────────────────────────────────────────────────────────────────────


async def test_the_request_carries_input_ids_not_text(wire) -> None:
    """The whole point: the server templates nothing, so the prompt the model sees is exactly the
    one the client rendered — and a trainer rendering the same way cannot drift from it."""
    await _backend().generate(MESSAGES)
    assert wire.sent[0]["input_ids"] == MergingTokenizer().render(MESSAGES)
    assert "text" not in wire.sent[0]


async def test_the_endpoint_is_the_server_root_even_when_the_config_names_v1(wire) -> None:
    """Every config in the wild writes base_url as the OpenAI-compatible `.../v1`; /generate hangs
    off the root. Dropping the suffix is what lets one config switch transports by name alone."""
    await _backend().generate(MESSAGES)
    assert wire.url == "http://h:1/generate"


async def test_logprobs_are_always_requested(wire) -> None:
    """They are the only channel the sampled ids come back through, so this is not an option here."""
    await _backend().generate(MESSAGES)
    assert wire.sent[0]["return_logprob"] is True


async def test_the_token_budget_uses_the_native_name(wire) -> None:
    """/generate calls it max_new_tokens; sending OpenAI's max_tokens would be silently ignored and
    the run would generate to the server's own limit instead."""
    await _backend(max_tokens=64, temperature=0.7).generate(MESSAGES)
    assert wire.sent[0]["sampling_params"] == {"max_new_tokens": 64, "temperature": 0.7}


async def test_extra_body_sampling_passes_through_verbatim(wire) -> None:
    await _backend(extra_body={"top_k": 20, "skip_special_tokens": False, "off": None}).generate(MESSAGES)
    assert wire.sent[0]["sampling_params"] == {"top_k": 20, "skip_special_tokens": False, "temperature": 0.0}


async def test_offering_tools_is_refused_rather_than_silently_ignored(wire) -> None:
    """An empty tool_calls on every turn looks to an agent loop like a model that never calls a
    tool — a wrong result that runs to completion, which is worse than not starting."""
    with pytest.raises(NotImplementedError, match="tool calls"):
        await _backend().generate(MESSAGES, tools=[{"type": "function"}])


# ─── the reply ───────────────────────────────────────────────────────────────────────────────


async def test_the_sampled_ids_and_logprobs_come_back_as_native_tokens(wire) -> None:
    out = await _backend().generate(MESSAGES)
    assert out.tokens.completion_ids == [11, 12]
    assert out.tokens.logprobs == [-0.1, -0.2]
    assert out.tokens.fidelity is Fidelity.NATIVE
    assert out.tokens.prompt_ids == MergingTokenizer().render(MESSAGES)
    assert out.tokens.tokenizer == "toy/merging"


async def test_a_server_that_reports_no_ids_is_an_error_not_a_local_re_encode(wire) -> None:
    """Falling back to tokenizing the text would produce a RECONSTRUCTED record wearing a NATIVE
    label, which is the one failure this whole distinction exists to prevent."""
    wire.reply = _reply(output_logprobs=None)
    with pytest.raises(ValueError, match="output_token_logprobs"):
        await _backend().generate(MESSAGES)


async def test_the_finish_reason_is_flattened_to_the_string_the_chat_path_reports(wire) -> None:
    """/generate reports {"type": "stop", ...} where /v1 reports "stop"; callers switch on it
    without caring which transport ran."""
    out = await _backend().generate(MESSAGES)
    assert out.finish_reason == "stop"


async def test_usage_is_reported_and_priced(wire) -> None:
    out = await _backend(input_price=1.0, output_price=2.0).generate(MESSAGES)
    assert out.usage == {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}
    assert out.cost == pytest.approx((5 * 1.0 + 2 * 2.0) / 1e6)


async def test_parse_thinking_splits_an_inline_block(wire) -> None:
    """/generate has no reasoning parser to defer to — it returns whatever the model emitted,
    tags and all."""
    wire.reply = _reply(text="<think>weighing it</think>the answer")
    out = await _backend(parse_thinking=True).generate(MESSAGES)
    assert (out.text, out.reasoning) == ("the answer", "weighing it")


async def test_on_delta_fires_once_with_the_whole_answer(wire) -> None:
    """The fallback the Backend protocol allows for a transport that does not stream — an
    interactive caller gets the answer rather than nothing."""
    seen: list[tuple[str, str]] = []
    await _backend().generate(MESSAGES, on_delta=lambda k, t: seen.append((k, t)))
    assert seen == [("content", "hi")]


# ─── errors and construction ─────────────────────────────────────────────────────────────────


async def test_a_4xx_is_not_retried(wire) -> None:
    """A malformed body fails identically every time; there is no typed SDK exception here, only a
    status code, so the fail-fast class is made from it. No sleep patch: an aborted call never
    reaches the backoff, which is the assertion."""
    wire.status = 422
    with pytest.raises(FatalHTTPError):
        await _backend(max_retries=3).generate(MESSAGES)
    assert len(wire.sent) == 1


async def test_a_5xx_is_retried(wire, monkeypatch) -> None:
    slept: list[float] = []

    async def fake_sleep(d: float) -> None:
        slept.append(d)

    monkeypatch.setattr("nanoagent.inference.backend.asyncio.sleep", fake_sleep)
    wire.status = 503
    with pytest.raises(RuntimeError):
        await _backend(max_retries=2).generate(MESSAGES)
    assert len(wire.sent) == 3  # the initial call plus max_retries


async def test_aclose_releases_the_pool(wire) -> None:
    backend = _backend()
    await backend.aclose()
    assert wire.closed


def test_a_native_config_without_an_endpoint_is_refused(wire) -> None:
    with pytest.raises(ValueError, match="base_url"):
        SglangNativeBackend.from_config(LeanInferConfig(backend="sglang_native", base_url=None, tokenizer="org/m"))
