"""Parse a thinking model's ``<think>...</think>`` trace out of its raw answer.

Reasoning models such as qwen3.6-35b-a3b emit their chain of thought as a leading
``<think>`` block before the answer. A reasoning-parser-enabled SGLang server splits that
into a separate ``reasoning_content`` field for you, but a plain server returns it inline in
the content. :func:`split_thinking` recovers the split from inline text, so a caller gets the
answer without the trace (and the trace separately) regardless of how the server is
configured. Enable it per-call via ``config.parse_thinking``.
"""

from __future__ import annotations

# A leading (optionally whitespace-prefixed) think block: an optional opening <think> — some
# server templates inject it and only the model's close tag is generated — up to the first
# </think>. Everything after that first close tag is the answer.
_OPEN = "<think>"
_CLOSE = "</think>"
# Tag lengths precomputed once at import; split_thinking's slices use these, not len() per call.
_OPEN_LEN = len(_OPEN)
_CLOSE_LEN = len(_CLOSE)


def split_thinking(text: str | None) -> tuple[str | None, str | None]:
    """Split a leading ``<think>...</think>`` block out of ``text``.

    Returns ``(reasoning, answer)``. With no close tag the text is all answer:
    ``(None, text)`` unchanged. Reasoning precedes the answer (the model thinks first), so
    only a leading block is split; both halves are stripped of surrounding whitespace and an
    empty half becomes ``None``.
    """
    if not text:
        return None, text
    close = text.find(_CLOSE)
    if close == -1:
        return None, text
    answer = text[close + _CLOSE_LEN :].strip()
    head = text[:close].lstrip()  # strip leading whitespace before an optional <think> tag
    if head.startswith(_OPEN):  # drop a leading <think> open tag if present
        head = head[_OPEN_LEN :]
    reasoning = head.strip()
    return (reasoning or None, answer or None)
