"""OpenAI Responses API (/responses), SSE or one JSON.

The wire has no cache-write count, so it normalizes to 0.
"""

from __future__ import annotations

import time
from typing import Any

from ..engine import NormalizedUsage, ParsedRequest, Reply, ToolSpec, Usage
from . import Frames, auth_of, error_type, pieces, sse


class Responses:
    name = "responses"
    path = "/responses"

    def parse(self, path: str, body: dict[str, Any], headers: Any) -> ParsedRequest:
        tools = [ToolSpec(t.get("name") or t.get("type", ""), t.get("parameters") or {}) for t in body.get("tools") or []]
        header, key = auth_of(headers)
        messages = body.get("input", [])
        return ParsedRequest(
            self.name,
            path,
            body.get("model", ""),
            messages if isinstance(messages, list) else [messages],
            tools,
            bool(body.get("stream")),
            None,
            header,
            key,
            body,
        )

    def normalized(self, usage: Usage) -> NormalizedUsage:
        return NormalizedUsage(usage.prompt, usage.cached, 0, usage.completion, usage.reasoning)

    def error_body(self, status: int, message: str) -> dict[str, Any]:
        return {"error": {"message": message, "type": error_type(status), "code": str(status), "param": None}}

    def _usage(self, usage: Usage) -> dict[str, Any]:
        return {
            "input_tokens": usage.prompt,
            "input_tokens_details": {"cached_tokens": usage.cached},
            "output_tokens": usage.completion,
            "output_tokens_details": {"reasoning_tokens": usage.reasoning},
            "total_tokens": usage.prompt + usage.completion,
        }

    def _items(self, reply: Reply, done: bool = True) -> list[dict[str, Any]]:
        status = "completed" if done else "in_progress"
        items: list[dict[str, Any]] = []
        if reply.reasoning:
            items.append({"id": "rs_0", "type": "reasoning", "summary": [{"type": "summary_text", "text": reply.reasoning}]})
        if reply.text:
            items.append(
                {
                    "id": "msg_0",
                    "type": "message",
                    "status": status,
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": reply.text, "annotations": []}],
                }
            )
        for call in reply.tool_calls:
            items.append(
                {"id": f"fc_{call.id}", "type": "function_call", "status": status, "call_id": call.id, "name": call.name, "arguments": call.arguments}
            )
        return items

    def _response(self, model: str, status: str, output: list[dict[str, Any]], usage: Usage | None) -> dict[str, Any]:
        return {
            "id": "resp_mock",
            "object": "response",
            "created_at": int(time.time()),
            "status": status,
            "model": model,
            "output": output,
            "parallel_tool_calls": True,
            "tool_choice": "auto",
            "tools": [],
            "error": None,
            "incomplete_details": None,
            "instructions": None,
            "metadata": {},
            "usage": self._usage(usage) if usage else None,
        }

    def full(self, reply: Reply, model: str, usage: Usage) -> dict[str, Any]:
        return self._response(model, "completed", self._items(reply), usage)

    def frames(self, reply: Reply, model: str, usage: Usage, count: int) -> Frames:
        seq = 0

        def ev(type_: str, **fields: Any) -> bytes:
            nonlocal seq
            seq += 1
            return sse({"type": type_, "sequence_number": seq, **fields}, type_)

        head = [
            ev("response.created", response=self._response(model, "in_progress", [], None)),
            ev("response.in_progress", response=self._response(model, "in_progress", [], None)),
        ]
        body: list[bytes] = []
        final = self._items(reply)
        out = 0
        for item in final:
            pending = {**item, "status": "in_progress"} if item["type"] != "reasoning" else {**item, "summary": []}
            if item["type"] == "message":
                pending["content"] = []
            if item["type"] == "function_call":
                pending["arguments"] = ""
            body.append(ev("response.output_item.added", output_index=out, item=pending))
            iid = item["id"]
            if item["type"] == "reasoning":
                text = item["summary"][0]["text"]
                body.append(
                    ev(
                        "response.reasoning_summary_part.added",
                        item_id=iid,
                        output_index=out,
                        summary_index=0,
                        part={"type": "summary_text", "text": ""},
                    )
                )
                body += [
                    ev("response.reasoning_summary_text.delta", item_id=iid, output_index=out, summary_index=0, delta=p) for p in pieces(text, count)
                ]
                body.append(ev("response.reasoning_summary_text.done", item_id=iid, output_index=out, summary_index=0, text=text))
                body.append(
                    ev(
                        "response.reasoning_summary_part.done",
                        item_id=iid,
                        output_index=out,
                        summary_index=0,
                        part={"type": "summary_text", "text": text},
                    )
                )
            elif item["type"] == "message":
                text = item["content"][0]["text"]
                body.append(
                    ev(
                        "response.content_part.added",
                        item_id=iid,
                        output_index=out,
                        content_index=0,
                        part={"type": "output_text", "text": "", "annotations": []},
                    )
                )
                body += [ev("response.output_text.delta", item_id=iid, output_index=out, content_index=0, delta=p) for p in pieces(text, count)]
                body.append(ev("response.output_text.done", item_id=iid, output_index=out, content_index=0, text=text))
                body.append(ev("response.content_part.done", item_id=iid, output_index=out, content_index=0, part=item["content"][0]))
            else:
                body += [
                    ev("response.function_call_arguments.delta", item_id=iid, output_index=out, delta=p) for p in pieces(item["arguments"], count)
                ]
                body.append(
                    ev("response.function_call_arguments.done", item_id=iid, output_index=out, name=item["name"], arguments=item["arguments"])
                )
            body.append(ev("response.output_item.done", output_index=out, item=item))
            out += 1
        # OpenRouter ends a Responses stream with `data: [DONE]` after response.completed, as it does a chat stream.
        tail = [ev("response.completed", response=self._response(model, "completed", final, usage)), sse("[DONE]")]
        return Frames(head, body, tail)
