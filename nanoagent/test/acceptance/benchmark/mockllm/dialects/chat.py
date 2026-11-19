"""OpenAI Chat Completions (OpenRouter's /chat/completions), SSE or one JSON.

Cache writes are carried as OpenRouter does: ``prompt_tokens_details.cache_write_tokens``.
"""

from __future__ import annotations

import time
from typing import Any

from ..engine import NormalizedUsage, ParsedRequest, Reply, ToolSpec, Usage
from . import Frames, auth_of, error_type, pieces, sse


class ChatCompletions:
    name = "chat"
    path = "/chat/completions"

    def parse(self, path: str, body: dict[str, Any], headers: Any) -> ParsedRequest:
        tools = [ToolSpec(t["function"]["name"], t["function"].get("parameters", {})) for t in body.get("tools") or []]
        header, key = auth_of(headers)
        return ParsedRequest(
            self.name,
            path,
            body.get("model", ""),
            body.get("messages", []),
            tools,
            bool(body.get("stream")),
            body.get("stream_options"),
            header,
            key,
            body,
        )

    def normalized(self, usage: Usage) -> NormalizedUsage:
        return NormalizedUsage(usage.prompt, usage.cached, usage.cache_write, usage.completion, usage.reasoning)

    def error_body(self, status: int, message: str) -> dict[str, Any]:
        return {"error": {"message": message, "type": error_type(status), "code": status}}

    def _usage(self, usage: Usage) -> dict[str, Any]:
        return {
            "prompt_tokens": usage.prompt,
            "completion_tokens": usage.completion,
            "total_tokens": usage.prompt + usage.completion,
            "prompt_tokens_details": {"cached_tokens": usage.cached, "cache_write_tokens": usage.cache_write},
            "completion_tokens_details": {"reasoning_tokens": usage.reasoning},
        }

    def _chunk(self, model: str, delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
        return {
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }

    def full(self, reply: Reply, model: str, usage: Usage) -> dict[str, Any]:
        message: dict[str, Any] = {"role": "assistant", "content": reply.text or None}
        if reply.reasoning:
            message["reasoning"] = reply.reasoning
        if reply.tool_calls:
            message["tool_calls"] = [
                {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}} for c in reply.tool_calls
            ]
        finish = "tool_calls" if reply.tool_calls else "stop"
        return {
            "id": "chatcmpl-mock",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": self._usage(usage),
        }

    def frames(self, reply: Reply, model: str, usage: Usage, count: int) -> Frames:
        head = [sse(self._chunk(model, {"role": "assistant", "content": ""}))]
        body = [sse(self._chunk(model, {"reasoning": piece})) for piece in pieces(reply.reasoning, count)]
        body += [sse(self._chunk(model, {"content": piece})) for piece in pieces(reply.text, count)]
        for index, call in enumerate(reply.tool_calls):
            first = {"index": index, "id": call.id, "type": "function", "function": {"name": call.name, "arguments": ""}}
            body.append(sse(self._chunk(model, {"tool_calls": [first]})))
            body += [
                sse(self._chunk(model, {"tool_calls": [{"index": index, "function": {"arguments": piece}}]}))
                for piece in pieces(call.arguments, count)
            ]
        finish = "tool_calls" if reply.tool_calls else "stop"
        final = {
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "choices": [],
            "usage": self._usage(usage),
        }
        tail = [sse(self._chunk(model, {}, finish)), sse(final), sse("[DONE]")]
        return Frames(head, body, tail)
