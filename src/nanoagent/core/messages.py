"""Transcript helpers: rendering a turn back into the message list.

Extracted from :mod:`nanoagent.core.agent` so that file holds the loop. Both functions are
pure: they build or scan message dicts and never touch the model.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from nanoagent.core.agent import Reply


def assistant_message(reply: Reply) -> dict[str, Any]:
    """Convert a :class:`Reply` into a re-sendable assistant message dict.

    Preserves ``tool_calls`` so the next request shows the assistant's call right before its
    matching ``role="tool"`` results — the API requires that pairing.

    Also replays the turn's reasoning as ``reasoning_content``. A reasoning-parser server strips
    the trace out of ``content``, so dropping it here would hand the model back a turn in which
    it called a tool for no stated reason: it then re-derives the same plan from scratch every
    step instead of building on it. Both served chat templates expect the field (gemma-4 renders
    it as a `thought` channel; Muse Glimmer re-emits it as its `to=self` channel) and ignore it
    when absent, so the template — not this function — decides when a trace is in scope.
    """
    out: dict[str, Any] = {"role": "assistant", "content": reply.content}
    if reply.reasoning:
        out["reasoning_content"] = reply.reasoning
    if reply.tool_calls:
        out["tool_calls"] = [
            {
                "id": c.id,
                "type": "function",
                "function": {"name": c.name, "arguments": c.arguments},
            }
            for c in reply.tool_calls
        ]
    return out


def last_assistant_text(messages: list[dict[str, Any]]) -> str:
    """Best-effort answer when the loop stops without a clean final reply."""
    for msg in reversed(messages):
        if msg.get("role") == "assistant" and msg.get("content"):
            return str(msg["content"])
    return ""
