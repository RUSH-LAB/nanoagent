"""Wire dialects: each owns one API's request parsing, reply framing and usage fields, nothing else."""

from __future__ import annotations

import json
from typing import Any, Protocol

from ..engine import NormalizedUsage, ParsedRequest, Reply, Usage


class Frames:
    """A streamed reply: ``head`` leaves at the first byte, ``body`` is split into the scenario's chunks, ``tail`` ends it."""

    def __init__(self, head: list[bytes], body: list[bytes], tail: list[bytes]) -> None:
        self.head = head
        self.body = body
        self.tail = tail


class Dialect(Protocol):
    name: str
    path: str  # under the run's base url

    def parse(self, path: str, body: dict[str, Any], headers: Any) -> ParsedRequest: ...

    def normalized(self, usage: Usage) -> NormalizedUsage: ...

    def error_body(self, status: int, message: str) -> dict[str, Any]: ...

    def full(self, reply: Reply, model: str, usage: Usage) -> dict[str, Any]: ...

    def frames(self, reply: Reply, model: str, usage: Usage, pieces: int) -> Frames: ...


def sse(data: Any, event: str | None = None) -> bytes:
    head = f"event: {event}\n" if event else ""
    return f"{head}data: {json.dumps(data) if not isinstance(data, str) else data}\n\n".encode()


def pieces(text: str, count: int) -> list[str]:
    """``text`` cut into at most ``count`` consecutive non-empty fragments (none for empty text)."""
    if not text:
        return []
    size = -(-len(text) // max(count, 1))
    return [text[i : i + size] for i in range(0, len(text), size)]


def auth_of(headers: Any) -> tuple[str, str]:
    if key := headers.get("x-api-key"):
        return "x-api-key", key
    if bearer := headers.get("authorization"):
        return "authorization", bearer.removeprefix("Bearer ").strip()
    return "", ""


def error_type(status: int) -> str:
    return {400: "invalid_request_error", 401: "authentication_error", 404: "not_found_error", 429: "rate_limit_error"}.get(status, "api_error")


def all_dialects() -> dict[str, Dialect]:
    from .anthropic import AnthropicMessages
    from .chat import ChatCompletions
    from .responses import Responses

    return {d.path: d for d in (ChatCompletions(), AnthropicMessages(), Responses())}
