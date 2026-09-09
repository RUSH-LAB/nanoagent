"""The tokenizer seam: what it promises, and the property that forces its shape.

Two things are pinned here. First the HuggingFace adapter's call into ``apply_chat_template`` /
``encode`` / ``decode`` — the three flags in those calls (``add_generation_prompt``,
``add_special_tokens=False``, ``skip_special_tokens=False``) are each a silent-corruption bug when
wrong, and none of them is visible in the output shape. ``transformers`` is a ``tokens``-extra
dependency, so it is stood in for rather than required, the same way ``conftest.hub`` stands in for
``huggingface_hub``.

Second, and the reason :class:`~nanoagent.inference.types.Tokens` keeps prompt and completion
apart instead of storing one flat sequence: tokenization does not distribute over concatenation.
"""

from __future__ import annotations

import sys
import types
from typing import Any

import pytest

from nanoagent.inference.tokenizer import HFTokenizer, load_tokenizer


class MergingTokenizer:
    """A toy tokenizer that merges across a boundary, which is the whole point of it.

    Greedy longest-match over a vocabulary in which ``"lo"`` is one token. Real BPE does the same
    thing on a far larger scale; three entries are enough to make the consequence reproducible
    without pulling in a vocabulary file.
    """

    name = "toy/merging"
    _vocab = {"lo": 1, "l": 2, "o": 3, "h": 4, "e": 5, " ": 6, "w": 7, "r": 8, "d": 9, "<bos>": 0}

    def render(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None) -> list[int]:
        return [0] + self.encode("".join(m.get("content", "") for m in messages))

    def encode(self, text: str) -> list[int]:
        ids, i = [], 0
        while i < len(text):
            if text[i : i + 2] in self._vocab:  # longest match first — this is the merge
                ids.append(self._vocab[text[i : i + 2]])
                i += 2
            else:
                ids.append(self._vocab[text[i]])
                i += 1
        return ids

    def decode(self, ids: list[int], *, skip_special: bool = False) -> str:
        back = {v: k for k, v in self._vocab.items()}
        return "".join(back[i] for i in ids if not (skip_special and i == 0))


def test_a_concatenated_encoding_is_not_the_encoding_of_the_concatenation() -> None:
    """Why Tokens keeps prompt_ids and completion_ids apart, and why a multi-turn sequence is
    built by APPENDING per-turn segments rather than by re-rendering the whole conversation.

    Re-rendering and diffing looks equivalent and is not: the merge rules run across the join, so
    the prefix of the re-rendered sequence is not the sequence that was actually sampled from.
    Every id after the boundary then shifts, and a per-token loss lands on the wrong tokens.
    """
    tk = MergingTokenizer()
    # The boundary falls INSIDE the "lo" merge: encoded apart, the l and the o stay two tokens;
    # encoded together they become one, and every id after that point shifts.
    assert tk.encode("hell") + tk.encode("o world") != tk.encode("hello world")


def test_the_toy_tokenizer_round_trips_so_the_test_above_is_about_merging_not_a_broken_stub() -> None:
    tk = MergingTokenizer()
    assert tk.decode(tk.encode("hello world")) == "hello world"


# ─── the HuggingFace adapter ─────────────────────────────────────────────────────────────────


class FakeAutoTokenizer:
    """Records the kwargs of each call, so the assertions are on the flags rather than the output."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def apply_chat_template(self, messages: list[dict[str, Any]], *, return_dict: bool = True, **kw: Any) -> Any:
        self.calls.append(("apply_chat_template", {"messages": messages, "return_dict": return_dict, **kw}))
        # Mirrors transformers 5, where return_dict defaults to True and the return is a
        # BatchEncoding mapping — iterating one yields its KEYS, not ids. A stub that always
        # returned a flat list would make a caller that inherits the default look correct here
        # and hand ["input_ids", "attention_mask"] to a real server.
        return {"input_ids": [1, 2, 3], "attention_mask": [1, 1, 1]} if return_dict else [1, 2, 3]

    def encode(self, text: str, **kw: Any) -> list[int]:
        self.calls.append(("encode", {"text": text, **kw}))
        return [4, 5]

    def decode(self, ids: list[int], **kw: Any) -> str:
        self.calls.append(("decode", {"ids": ids, **kw}))
        return "text"


@pytest.fixture
def transformers(monkeypatch):
    """A stand-in ``transformers`` whose ``AutoTokenizer.from_pretrained`` returns the recorder."""
    recorder = FakeAutoTokenizer()
    module = types.ModuleType("transformers")
    module.AutoTokenizer = types.SimpleNamespace(from_pretrained=lambda *_a, **_k: recorder)
    monkeypatch.setitem(sys.modules, "transformers", module)
    # The cache is keyed on the NAME, so an entry built against the stand-in would otherwise
    # outlive it and be handed to a later test as if it came from the real package.
    load_tokenizer.cache_clear()
    yield recorder
    load_tokenizer.cache_clear()


def test_render_asks_for_the_generation_prompt(transformers) -> None:
    """Without it the model is asked to continue the user's turn instead of answering it — which
    produces fluent, plausible output, so nothing downstream notices."""
    tk = HFTokenizer("org/m", transformers)
    assert tk.render([{"role": "user", "content": "q"}], [{"type": "function"}]) == [1, 2, 3]
    _name, kw = transformers.calls[0]
    assert kw["add_generation_prompt"] is True
    assert kw["tokenize"] is True
    assert kw["tools"] == [{"type": "function"}]


def test_render_pins_return_dict_because_its_default_moved(transformers) -> None:
    """transformers 4 returned a list of ids from apply_chat_template; 5 returns a BatchEncoding.
    Inherit that default and `list(...)` yields ["input_ids", "attention_mask"] — a prompt of two
    strings, which fails far from here (in a decode, or as a 400 off the wire) if at all.
    """
    tk = HFTokenizer("org/m", transformers)
    assert tk.render([{"role": "user", "content": "q"}]) == [1, 2, 3]
    assert transformers.calls[0][1]["return_dict"] is False


def test_encode_adds_no_special_tokens(transformers) -> None:
    """encode() is for a FRAGMENT of a sequence (a completion, a tool result). A BOS prepended to
    each fragment survives into the concatenation as a token the model never emitted."""
    HFTokenizer("org/m", transformers).encode("some completion")
    assert transformers.calls[0][1]["add_special_tokens"] is False


def test_decode_keeps_special_tokens_unless_asked(transformers) -> None:
    """A tool-call parser reads them — gemma emits `<|tool_call>` as a special token, and dropping
    it turns a parseable call into prose. Display is the case that wants them gone."""
    tk = HFTokenizer("org/m", transformers)
    tk.decode([1, 2])
    tk.decode([1, 2], skip_special=True)
    assert [c[1]["skip_special_tokens"] for c in transformers.calls] == [False, True]


def test_load_tokenizer_names_the_extra_when_transformers_is_absent(monkeypatch) -> None:
    """The failure a user actually hits: a config names a tokenizer on a base install."""
    monkeypatch.setitem(sys.modules, "transformers", None)  # import raises ImportError
    load_tokenizer.cache_clear()
    with pytest.raises(ImportError, match=r"nanoagent\[tokens\]"):
        load_tokenizer("org/m")
    load_tokenizer.cache_clear()


def test_the_loaded_tokenizer_is_cached_per_name(transformers) -> None:
    """A batch builds a backend per call; re-reading a multi-megabyte tokenizer.json per rollout
    would be a real cost for an immutable, shareable object."""
    assert load_tokenizer("org/m") is load_tokenizer("org/m")
