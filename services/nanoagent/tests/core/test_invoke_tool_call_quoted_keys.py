"""Offline pin: invoke_tool_call recovers arg keys a tool-call parser wrapped in quotes.

Some served tool-call parsers (e.g. SGLang's gemma4 on quote-heavy values) emit the argument
NAME wrapped in literal quotes, so the raw ``arguments`` JSON is ``{"\\"query\\"": "..."}`` and
``json.loads`` yields the key ``"query"`` (quotes included). Without normalization
``tool.run(**args)`` raises ``TypeError: ... unexpected keyword argument '"query"'``;
:func:`nanoagent.core.agent._unquote_arg_keys` (applied in :func:`invoke_tool_call`) strips the
surrounding quote pair so the intended call dispatches. Well-formed keys are untouched.

No model / network / GPU — a pure-Python tool + direct invoke_tool_call call.

Run (from the repo root)::

    python3 -m pytest tests/core/test_invoke_tool_call_quoted_keys.py -x -q
"""

from __future__ import annotations

from nanoagent.core.agent import _unquote_arg_keys, invoke_tool_call, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _Search(Tool):
    NAME = "search"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    }

    def run(self, query: str) -> str:
        return f"searched: {query}"


def test_unquote_arg_keys_strips_only_wrapping_quotes() -> None:
    # A quote-wrapped key is unwrapped; a plain key and a value (even a quoted one) are untouched.
    assert _unquote_arg_keys({'"query"': "v"}) == {"query": "v"}
    assert _unquote_arg_keys({"'query'": "v"}) == {"query": "v"}
    assert _unquote_arg_keys({"query": '"v"'}) == {"query": '"v"'}  # value, not key, unchanged


async def test_invoke_tool_call_recovers_quoted_key() -> None:
    # Raw arguments whose KEY is the quoted string "query" (what the parser emitted) now dispatch.
    call = ToolCall(id="c1", name="search", arguments='{"\\"query\\"": "hello"}')
    text, is_error, args = await invoke_tool_call({"search": _Search()}, call)
    assert is_error is False
    assert text == "searched: hello"
    assert args == {"query": "hello"}


async def test_invoke_tool_call_wellformed_key_unaffected() -> None:
    # The ordinary case still works exactly as before.
    call = ToolCall(id="c2", name="search", arguments='{"query": "world"}')
    text, is_error, args = await invoke_tool_call({"search": _Search()}, call)
    assert (text, is_error, args) == ("searched: world", False, {"query": "world"})
