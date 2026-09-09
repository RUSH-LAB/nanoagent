"""The tokenizer seam: the one place that knows how a conversation becomes token ids.

Two things a chat API normally does on the server, this module does on the client:

  1. **the chat template** — turning ``[{"role": ..., "content": ...}]`` plus the tool specs into
     one string of special tokens and text, ending in the generation prompt;
  2. **tokenization** — that string into ids.

Moving both here is what makes token-in / token-out possible at all. Sending ``input_ids`` to
SGLang's native ``/generate`` means the server templates nothing, so the prompt the model sees is
exactly the one :meth:`Tokenizer.render` produced — and a trainer that renders with the same
object cannot drift from the sampler, which is the usual source of silent train/serve skew.

It is a Protocol, not a class hierarchy, because the only thing anything here needs is three
methods. :class:`HFTokenizer` is the implementation, over ``transformers.AutoTokenizer`` (the
``tokens`` extra); ``transformers`` is imported inside :func:`load_tokenizer` so an install that
never names a tokenizer never pays for it.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any, Protocol


class Tokenizer(Protocol):
    """Render a conversation to ids, and move between text and ids in both directions."""

    #: What vocabulary these ids belong to — recorded on every
    #: :class:`~nanoagent.inference.types.Tokens` so a saved trajectory is self-describing.
    name: str

    def render(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> list[int]:
        """The conversation as prompt ids, ending in the generation prompt (ready to sample from)."""
        ...

    def encode(self, text: str) -> list[int]:
        """``text`` as ids, with NO special tokens added — this encodes a fragment, not a prompt."""
        ...

    def decode(self, ids: list[int], *, skip_special: bool = False) -> str:
        """``ids`` back to text. Special tokens are KEPT by default; see :class:`HFTokenizer`."""
        ...


class HFTokenizer:
    """A :class:`Tokenizer` over a HuggingFace ``AutoTokenizer`` — its chat template included."""

    def __init__(self, name: str, tokenizer: Any) -> None:
        self.name = name
        self._tk = tokenizer

    def render(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
    ) -> list[int]:
        # add_generation_prompt=True appends the assistant header the model completes FROM; without
        # it the model is asked to continue the user's turn instead of answering it.
        #
        # return_dict is passed EXPLICITLY because its default flipped between transformers 4 and
        # 5 (False -> True). Inherit it and this returns a BatchEncoding on one and a list of ids
        # on the other, so `list(...)` yields ["input_ids", "attention_mask"] — a two-element
        # prompt of strings that only fails later, in the decode or on the wire.
        return list(
            self._tk.apply_chat_template(
                messages,
                tools=tools,
                add_generation_prompt=True,
                tokenize=True,
                return_dict=False,
            )
        )

    def encode(self, text: str) -> list[int]:
        # add_special_tokens=False: the caller is encoding a piece of a sequence (a completion,
        # a tool result), and a BOS prepended to each piece would corrupt the concatenation.
        return list(self._tk.encode(text, add_special_tokens=False))

    def decode(self, ids: list[int], *, skip_special: bool = False) -> str:
        # Special tokens are kept by default because a tool-call parser reads them: gemma emits
        # `<|tool_call>` as one, and dropping it turns a parseable call into prose. Displaying the
        # text to a human is the case that wants them gone, and it passes skip_special=True.
        return str(self._tk.decode(ids, skip_special_tokens=skip_special))


@lru_cache(maxsize=None)
def load_tokenizer(name_or_path: str) -> Tokenizer:
    """Load the tokenizer named by a HuggingFace repo id or a local directory.

    Cached on the name: a batch builds a backend per call and reading a multi-megabyte
    ``tokenizer.json`` per rollout would be a real cost for an object that is immutable and
    shared. ``transformers`` is imported here rather than at module scope, so importing this
    module (which the package does eagerly) stays free.
    """
    try:
        from transformers import AutoTokenizer
    except ImportError as e:  # pragma: no cover — depends on what is installed
        raise ImportError(
            "a tokenizer was configured but `transformers` is not installed; "
            "install nanoagent[tokens]"
        ) from e
    return HFTokenizer(
        name_or_path, AutoTokenizer.from_pretrained(name_or_path, trust_remote_code=False)
    )
