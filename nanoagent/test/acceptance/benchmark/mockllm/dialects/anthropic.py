"""Anthropic Messages API (/messages), SSE or one JSON.

``input_tokens`` excludes cache reads and writes. The wire has no reasoning count, so it normalizes to 0.
"""

from __future__ import annotations

import json
from typing import Any

from ..engine import NormalizedUsage, ParsedRequest, Reply, ToolSpec, Usage
from . import Frames, auth_of, error_type, pieces, sse


class AnthropicMessages:
    name = "anthropic"
    path = "/messages"

    def parse(self, path: str, body: dict[str, Any], headers: Any) -> ParsedRequest:
        tools = [ToolSpec(t["name"], t.get("input_schema", {})) for t in body.get("tools") or []]
        header, key = auth_of(headers)
        return ParsedRequest(
            self.name, path, body.get("model", ""), body.get("messages", []), tools, bool(body.get("stream")), None, header, key, body
        )

    def normalized(self, usage: Usage) -> NormalizedUsage:
        return NormalizedUsage(usage.prompt, usage.cached, usage.cache_write, usage.completion, 0)

    def error_body(self, status: int, message: str) -> dict[str, Any]:
        return {"type": "error", "error": {"type": error_type(status), "message": message}}

    def _usage(self, usage: Usage, output: int | None = None) -> dict[str, Any]:
        return {
            "input_tokens": usage.prompt - usage.cached - usage.cache_write,
            "cache_creation_input_tokens": usage.cache_write,
            "cache_read_input_tokens": usage.cached,
            "output_tokens": usage.completion if output is None else output,
        }

    def _stop(self, reply: Reply) -> str:
        return "tool_use" if reply.tool_calls else "end_turn"

    def full(self, reply: Reply, model: str, usage: Usage) -> dict[str, Any]:
        content: list[dict[str, Any]] = []
        if reply.reasoning:
            content.append({"type": "thinking", "thinking": reply.reasoning, "signature": "mock-signature"})
        if reply.text:
            content.append({"type": "text", "text": reply.text})
        content += [{"type": "tool_use", "id": c.id, "name": c.name, "input": json.loads(c.arguments)} for c in reply.tool_calls]
        return {
            "id": "msg_mock",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": content,
            "stop_reason": self._stop(reply),
            "stop_sequence": None,
            "usage": self._usage(usage),
        }

    def frames(self, reply: Reply, model: str, usage: Usage, count: int) -> Frames:
        start = {
            "id": "msg_mock",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": self._usage(usage, 1),
        }
        head = [sse({"type": "message_start", "message": start}, "message_start"), sse({"type": "ping"}, "ping")]
        body: list[bytes] = []
        index = 0

        def block(content_block: dict[str, Any], deltas: list[dict[str, Any]]) -> None:
            nonlocal index
            body.append(sse({"type": "content_block_start", "index": index, "content_block": content_block}, "content_block_start"))
            body.extend(sse({"type": "content_block_delta", "index": index, "delta": delta}, "content_block_delta") for delta in deltas)
            body.append(sse({"type": "content_block_stop", "index": index}, "content_block_stop"))
            index += 1

        if reply.reasoning:
            deltas = [{"type": "thinking_delta", "thinking": p} for p in pieces(reply.reasoning, count)]
            block({"type": "thinking", "thinking": "", "signature": ""}, [*deltas, {"type": "signature_delta", "signature": "mock-signature"}])
        if reply.text:
            block({"type": "text", "text": ""}, [{"type": "text_delta", "text": p} for p in pieces(reply.text, count)])
        for call in reply.tool_calls:
            block(
                {"type": "tool_use", "id": call.id, "name": call.name, "input": {}},
                [{"type": "input_json_delta", "partial_json": p} for p in pieces(call.arguments, count)],
            )
        delta = {"type": "message_delta", "delta": {"stop_reason": self._stop(reply), "stop_sequence": None}, "usage": self._usage(usage)}
        # OpenRouter's Messages stream ends with message_stop and no `[DONE]` sentinel (that is the chat and responses endings).
        tail = [sse(delta, "message_delta"), sse({"type": "message_stop"}, "message_stop")]
        return Frames(head, body, tail)
