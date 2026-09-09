"""The token contract: who supplies ids, who reconstructs them, and who is told which happened.

The promise is that a reply carries tokens whichever transport produced it, and that the record
says whether they are the sampler's own. Everything here is about the seam that makes both true —
:func:`~nanoagent.inference.backends.build_backend`, which is the single place a backend is built
and therefore the single place the guarantee can be attached.
"""

from __future__ import annotations

from typing import Any

import pytest

from nanoagent.inference import Fidelity, LeanInferConfig
from nanoagent.inference.backends import build_backend
from nanoagent.inference.tokenizing import TokenizingBackend
from nanoagent.inference.types import Response, ToolCall

from tests.inference.test_tokenizer import MergingTokenizer


class TextBackend:
    """A chat transport: text out, no ids — what every OpenAI-compatible endpoint gives you."""

    fidelity = Fidelity.RECONSTRUCTED

    def __init__(self, response: Response | None = None) -> None:
        self.response = response or Response(text="hello world")
        self.closed = False

    async def generate(self, messages: list[dict[str, Any]], *, tools: Any = None, on_delta: Any = None) -> Response:
        return self.response

    async def aclose(self) -> None:
        self.closed = True


def _wrapped(response: Response | None = None) -> tuple[TokenizingBackend, TextBackend]:
    inner = TextBackend(response)
    return TokenizingBackend(inner, MergingTokenizer()), inner


# ─── reconstruction ──────────────────────────────────────────────────────────────────────────


async def test_a_text_only_reply_comes_back_with_tokens() -> None:
    backend, _ = _wrapped()
    out = await backend.generate([{"role": "user", "content": "hel"}])
    tk = MergingTokenizer()
    assert out.tokens is not None
    assert out.tokens.prompt_ids == tk.render([{"role": "user", "content": "hel"}])
    assert out.tokens.completion_ids == tk.encode("hello world")


async def test_reconstructed_tokens_say_so_and_name_their_vocabulary() -> None:
    """A slug behind a routing provider says nothing about which tokenizer was used, so the record
    has to carry the one that actually produced these ids."""
    backend, _ = _wrapped()
    out = await backend.generate([{"role": "user", "content": "hel"}])
    assert out.tokens.fidelity is Fidelity.RECONSTRUCTED
    assert out.tokens.tokenizer == "toy/merging"


async def test_a_reconstructed_record_carries_no_logprobs() -> None:
    """There is nowhere to get them: a chat API reports counts, not per-token probabilities. An
    empty list would read as "the model was certain about nothing"."""
    backend, _ = _wrapped()
    out = await backend.generate([{"role": "user", "content": "hel"}])
    assert out.tokens.logprobs is None


async def test_a_failed_request_gets_no_tokens() -> None:
    """There is no completion to encode, and a prompt-only record is just a second copy of the
    request wearing a name that suggests a result."""
    backend, _ = _wrapped(Response(error="upstream 503"))
    out = await backend.generate([{"role": "user", "content": "hel"}])
    assert out.tokens is None


async def test_a_tool_call_turn_is_reconstructed_from_the_text_alone() -> None:
    """Pinning the known incompleteness rather than pretending it away. The call the model emitted
    WAS generated tokens, but the chat API hands it back as a parsed field with its delimiters
    gone, so there is no honest way to place it in the sequence — which is the third reason
    RECONSTRUCTED means "do not compute a loss against this"."""
    reply = Response(text="hello", tool_calls=[ToolCall(id="c1", name="search", arguments='{"q":"x"}')])
    backend, _ = _wrapped(reply)
    out = await backend.generate([{"role": "user", "content": "hel"}])
    assert out.tokens.completion_ids == MergingTokenizer().encode("hello")


async def test_closing_the_wrapper_closes_the_transport_underneath() -> None:
    backend, inner = _wrapped()
    await backend.aclose()
    assert inner.closed


# ─── who gets wrapped ────────────────────────────────────────────────────────────────────────


def _build(monkeypatch, cls: type, **cfg: Any):
    """build_backend against a stand-in transport, with the tokenizer load stubbed out."""
    monkeypatch.setattr("nanoagent.inference.backends.load_backend_class", lambda *_a: cls)
    monkeypatch.setattr("nanoagent.inference.tokenizer.load_tokenizer", lambda _name: MergingTokenizer())
    return build_backend(LeanInferConfig(**cfg))


class ConfigurableText(TextBackend):
    @classmethod
    def from_config(cls, cfg: LeanInferConfig) -> TextBackend:
        return cls()


class NativeBackend(TextBackend):
    fidelity = Fidelity.NATIVE

    @classmethod
    def from_config(cls, cfg: LeanInferConfig) -> TextBackend:
        return cls()


class UnannotatedBackend:
    """A plugin transport written before `fidelity` existed — which means an OpenAI-compatible one.

    Deliberately not a TextBackend subclass: inheriting one would inherit the very attribute this
    is here to be missing.
    """

    @classmethod
    def from_config(cls, cfg: LeanInferConfig) -> UnannotatedBackend:
        return cls()

    async def generate(self, messages: list[dict[str, Any]], *, tools: Any = None, on_delta: Any = None) -> Response:
        return Response(text="hello world")

    async def aclose(self) -> None:
        pass


def test_no_tokenizer_means_no_wrapper_and_no_tokens(monkeypatch) -> None:
    """The default path is untouched: an install that only ever sends text pays nothing, and gets
    tokens=None rather than a guess."""
    backend = _build(monkeypatch, ConfigurableText, tokenizer=None)
    assert isinstance(backend, ConfigurableText)


def test_naming_a_tokenizer_wraps_a_chat_transport(monkeypatch) -> None:
    backend = _build(monkeypatch, ConfigurableText, tokenizer="toy/merging")
    assert isinstance(backend, TokenizingBackend)


def test_a_native_transport_is_never_wrapped(monkeypatch) -> None:
    """Re-encoding its text would overwrite an exact record with an approximate one — the one
    outcome worse than having no ids at all."""
    backend = _build(monkeypatch, NativeBackend, tokenizer="toy/merging")
    assert isinstance(backend, NativeBackend)


def test_a_transport_that_declares_nothing_is_treated_as_a_chat_one(monkeypatch) -> None:
    """The safe reading, and the one that keeps an existing site plugin working unchanged."""
    backend = _build(monkeypatch, UnannotatedBackend, tokenizer="toy/merging")
    assert isinstance(backend, TokenizingBackend)


def test_the_shipped_chat_transport_declares_itself_reconstructed() -> None:
    """SGLang's own /v1 endpoint is on the text side of the line, same as OpenRouter — the split
    is /generate vs /v1, not local vs hosted."""
    from nanoagent.inference.backends.sglang import SglangBackend

    assert SglangBackend.fidelity is Fidelity.RECONSTRUCTED


def test_a_native_config_without_a_tokenizer_is_refused() -> None:
    """It sends input_ids, so the chat template is applied client-side and there is no server-side
    default to fall back on — a run that starts anyway would be templating nothing at all."""
    from nanoagent.inference.backends.sglang_native import SglangNativeBackend

    with pytest.raises(ValueError, match="tokenizer"):
        SglangNativeBackend.from_config(LeanInferConfig(base_url="http://h:1/v1", tokenizer=None))
