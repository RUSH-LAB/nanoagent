"""Tool-call dispatch: parse one model-emitted call and run it against the tool map.

Pure helpers extracted from :mod:`nanoagent.core.agent` so that file holds the loop:
argument recovery (:func:`_unquote_arg_keys`), malformation detection
(:func:`_is_arg_malformed`), and the never-raises entry point (:func:`invoke_tool_call`).
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from nanoagent.core.agent import ToolCall
    from nanoagent.core.tool import Tool


# Marker prefixes for tool-result text whose error stems from the model emitting a malformed
# call shape. These are the only errors a fresh re-query can plausibly fix (the model wrote the
# wrong call); a tool whose run() raised some OTHER exception would re-fire identically and is
# intentionally not retried — its error text goes back as a normal tool result instead.
_ARG_MALFORMED_PREFIXES = (
    "Error: invalid JSON arguments",
    "Error: tool arguments must be a JSON object",
    "Error: unknown tool ",
    "Error: TypeError:",  # arg-shape mismatch raised when calling tool.run(**args)
)


def _is_arg_malformed(text: str) -> bool:
    """True when ``text`` is a tool result whose error came from a malformed call shape."""
    return any(text.startswith(p) for p in _ARG_MALFORMED_PREFIXES)


def _unquote_arg_keys(args: dict[str, Any]) -> dict[str, Any]:
    """Strip a surrounding quote pair from each arg key (``'"query"'`` -> ``'query'``).

    Some served tool-call parsers (SGLang's gemma4 on quote-heavy argument values) emit the
    argument NAME wrapped in literal quotes, so ``json.loads`` yields ``{'"query"': ...}`` and
    ``tool.run(**args)`` then rejects an unknown kwarg. A real arg name never starts and ends
    with a quote, so unwrapping a matching pair recovers the call without affecting valid ones.
    """
    return {
        (
            k[1:-1]
            if isinstance(k, str) and len(k) >= 2 and k[0] == k[-1] and k[0] in "\"'"
            else k
        ): v
        for k, v in args.items()
    }


async def invoke_tool_call(
    tools: dict[str, Tool], call: ToolCall
) -> tuple[str, bool, dict[str, Any]]:
    """Parse a tool call's JSON arguments and dispatch it to the named tool.

    Returns ``(output_text, is_error, parsed_args)``. Bad JSON, arguments that aren't a JSON
    object, an unknown tool name, or a tool that reports failure all come back as
    ``is_error=True`` text (never raised) so the caller can feed the message back to the model;
    ``parsed_args`` is ``{}`` in the first three cases.
    """
    try:
        args = json.loads(call.arguments or "{}")
    except json.JSONDecodeError as e:
        return f"Error: invalid JSON arguments: {e}", True, {}
    if not isinstance(args, dict):
        return f"Error: tool arguments must be a JSON object, got {type(args).__name__}", True, {}
    args = _unquote_arg_keys(args)  # recover keys a tool-call parser wrapped in quotes
    tool = tools.get(call.name)
    if tool is None:
        return f"Error: unknown tool {call.name!r}; available: {', '.join(sorted(tools))}", True, {}
    text, is_error = await tool.invoke(**args)
    return text, is_error, args
