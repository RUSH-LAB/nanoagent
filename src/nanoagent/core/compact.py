"""Context compaction: summarize the middle of a transcript to reclaim context.

Extracted from :mod:`nanoagent.core.agent` so that file holds the loop. The policy
(``compact=True`` summarizes at 80% of ``context_window``; ``False`` hard-stops) is owned
by the loop; everything about *how* to shrink lives here.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from nanoagent.core.agent import ChatModel, Reply


# Compact the history once a reply's prompt_tokens crosses this fraction of context_window —
# 0.8 leaves headroom for the next turn. Only used when the agent is built with compact=True.
_COMPACT_THRESHOLD = 0.8
# Messages kept verbatim at the tail when compacting (the most recent exchange); grown
# backwards over leading tool messages so an assistant tool-call is never split from its
# results (see compact_messages).
_COMPACT_KEEP_RECENT = 2
_COMPACT_PROMPT = (
    "Summarize the conversation so far. Preserve: key findings, decisions made, "
    "tool results that matter, and any outstanding tasks. Be concise."
)


def needs_compaction(context_window: int | None, prompt_tokens: int) -> bool:
    """True when ``prompt_tokens`` has crossed the compaction threshold for ``context_window``.

    ``context_window`` of ``None`` disables compaction entirely.
    """
    return context_window is not None and prompt_tokens > context_window * _COMPACT_THRESHOLD


async def compact_messages(
    model: ChatModel,
    messages: list[dict[str, Any]],
    *,
    on_reply: Callable[[Reply], None] | None = None,
) -> list[dict[str, Any]]:
    """Summarize the middle of ``messages`` to reclaim context, preserving both ends.

    Keeps the system prompt (``messages[0]``) and the most recent exchange verbatim, asks
    ``model`` to summarize everything in between, and splices that summary back in as one
    ``user`` message. The model is queried with no tools so it can only write prose, never try
    to act mid-summary. The kept tail is extended backwards over any leading ``role="tool"``
    messages so an assistant's tool call is never separated from its results (the chat API
    rejects that pairing). Returns ``messages`` unchanged unless at least two messages sit
    between the system prompt and the kept tail: folding fewer cannot shrink the list and would
    only burn a model call and lossily rewrite the original task. The summarization turn's own
    tokens are intentionally not added to the run's usage/cost — it is bookkeeping, not task
    work. NOTE: size ``context_window`` above the system prompt plus one full exchange; a
    tighter budget keeps the kept tail itself over the threshold, so compaction then runs every
    turn (still bounded and valid, just costlier).
    """
    keep_from = len(messages) - _COMPACT_KEEP_RECENT
    while keep_from > 1 and messages[keep_from].get("role") == "tool":
        keep_from -= 1
    if keep_from <= 2:
        return messages
    middle = messages[1:keep_from]
    reply = await model.query([*middle, {"role": "user", "content": _COMPACT_PROMPT}], [])
    if on_reply is not None:
        on_reply(reply)
    summary = {
        "role": "user",
        "content": f"Summary of earlier conversation:\n{reply.content or ''}",
    }
    return [messages[0], summary, *messages[keep_from:]]
