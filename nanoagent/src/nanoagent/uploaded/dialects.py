"""Deterministic parsing of captured OpenRouter traffic: SSE framing, per-dialect response assembly and request parsing.

Pure functions over bytes and JSON. Nothing is repaired: a frame or body that does not parse raises
[MalformedCaptureError], and a stream that ends without its terminal event is reported as ``interrupted``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

Dialect = Literal["chat_completions", "responses", "anthropic_messages"]
Status = Literal["completed", "failed", "incomplete", "interrupted", "error"]

DIALECTS: tuple[Dialect, ...] = ("chat_completions", "responses", "anthropic_messages")


class MalformedCaptureError(ValueError):
    """Captured traffic that cannot be parsed as its dialect."""


class MalformedFrameError(MalformedCaptureError):
    """An SSE frame, or the event JSON it carries, is malformed."""


class MalformedBodyError(MalformedCaptureError):
    """A request or response body is malformed."""


@dataclass(frozen=True)
class SseFrame:
    """One server-sent event. ``data`` is None for a frame with no data line (a comment or heartbeat)."""

    index: int
    event: str | None
    data: str | None
    byte_length: int
    comments: tuple[str, ...] = ()


class SseDecoder:
    """Incremental SSE framing. Every input byte lands in exactly one frame's ``byte_length`` or in [pending]."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._count = 0
        self._size = 0
        self._event: str | None = None
        self._data: list[str] | None = None
        self._comments: list[str] = []

    @property
    def pending(self) -> bool:
        """True while bytes of an unterminated frame are held."""
        return bool(self._buffer) or bool(self._event or self._data is not None or self._comments)

    def feed(self, chunk: bytes) -> list[SseFrame]:
        self._buffer += chunk
        frames: list[SseFrame] = []
        while (line := self._next_line()) is not None:
            raw, length = line
            self._size += length
            if frame := self._line(raw):
                frames.append(frame)
        return frames

    def _next_line(self) -> tuple[bytes, int] | None:
        buffer = self._buffer
        for position, byte in enumerate(buffer):
            if byte == 0x0A:
                end = position + 1
            elif byte == 0x0D:
                if position + 1 == len(buffer):
                    return None  # a trailing CR may be the first half of CRLF
                end = position + 2 if buffer[position + 1] == 0x0A else position + 1
            else:
                continue
            raw = bytes(buffer[:position])
            del buffer[:end]
            return raw, end
        return None

    def _line(self, raw: bytes) -> SseFrame | None:
        try:
            line = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise MalformedFrameError(f"frame {self._count}: line is not UTF-8: {error}") from error
        if not line:
            return self._dispatch()
        if line.startswith(":"):
            self._comments.append(line[1:].removeprefix(" "))
            return None
        name, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if name == "event":
            self._event = value
        elif name == "data":
            self._data = [*(self._data or []), value]
        return None

    def _dispatch(self) -> SseFrame | None:
        if self._event is None and self._data is None and not self._comments:
            return None  # stray blank line: its bytes carry into the next frame
        frame = SseFrame(
            index=self._count,
            event=self._event,
            data="\n".join(self._data) if self._data is not None else None,
            byte_length=self._size,
            comments=tuple(self._comments),
        )
        self._count += 1
        self._size = 0
        self._event, self._data, self._comments = None, None, []
        return frame


def split_sse(data: bytes) -> list[SseFrame]:
    """Frame a complete capture. Raises [MalformedFrameError] when it ends inside a frame."""
    decoder = SseDecoder()
    frames = decoder.feed(data)
    if decoder.pending:
        raise MalformedFrameError(f"stream ends inside frame {len(frames)} without its blank-line terminator")
    return frames


@dataclass(frozen=True)
class ToolProposal:
    """A tool call the model proposed, with the dialect-native IDs it arrived under."""

    name: str
    call_id: str | None
    raw_arguments: str
    arguments: dict[str, Any] | None
    arguments_error: str | None
    started_frame: int | None
    completed_frame: int | None
    choice_index: int | None = None  # Chat
    tool_index: int | None = None  # Chat
    item_id: str | None = None  # Responses output item
    output_index: int | None = None  # Responses
    block_index: int | None = None  # Anthropic content block


@dataclass(frozen=True)
class AssembledResponse:
    """One physical response. ``usage`` is the raw provider usage object (merged across Anthropic events)."""

    dialect: Dialect
    response_id: str | None
    generation_id: str | None
    requested_model: str | None
    resolved_model: str | None
    provider: str | None
    text: str
    status: Status
    error: str | None
    finish_reason: str | None
    tool_proposals: tuple[ToolProposal, ...]
    usage: Mapping[str, Any] | None
    frame_count: int | None  # None for a non-streaming body
    terminal_frame: int | None


@dataclass(frozen=True)
class ToolResultSent:
    """A tool result carried in a model request, to be linked to the earlier proposal with the same ``call_id``."""

    call_id: str
    content: Any
    message_index: int


@dataclass(frozen=True)
class ParsedModelRequest:
    dialect: Dialect
    model: str | None
    stream: bool
    tool_names: tuple[str, ...]
    tool_results: tuple[ToolResultSent, ...]


def _generation_id(value: str | None) -> str | None:
    return value if value and value.startswith("gen-") else None


def _error_text(error: Any) -> str:
    return json.dumps(error, sort_keys=True)


def _parse_arguments(raw: str) -> tuple[dict[str, Any] | None, str | None]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        return None, f"arguments are not valid JSON: {error}"
    if not isinstance(parsed, dict):
        return None, f"arguments are not a JSON object: {type(parsed).__name__}"
    return parsed, None


def _event(frame: SseFrame) -> dict[str, Any]:
    try:
        event = json.loads(frame.data or "")
    except json.JSONDecodeError as error:
        raise MalformedFrameError(f"frame {frame.index}: data is not valid JSON: {error}") from error
    if not isinstance(event, dict):
        raise MalformedFrameError(f"frame {frame.index}: data is not a JSON object")
    return event


def _data_frames(frames: Sequence[SseFrame]) -> list[SseFrame]:
    return [frame for frame in frames if frame.data is not None]


class _Proposal:
    """Mutable proposal under assembly."""

    def __init__(self, started: int | None, **ids: Any) -> None:
        self.ids = ids
        self.name = ""
        self.call_id: str | None = None
        self.fragments: list[str] = []
        self.arguments: str | None = None  # an authoritative complete value, when the dialect sends one
        self.started = started
        self.completed: int | None = None

    def freeze(self) -> ToolProposal:
        raw = self.arguments if self.arguments is not None else "".join(self.fragments)
        parsed, error = _parse_arguments(raw)
        return ToolProposal(
            name=self.name,
            call_id=self.call_id,
            raw_arguments=raw,
            arguments=parsed,
            arguments_error=error,
            started_frame=self.started,
            completed_frame=self.completed,
            **self.ids,
        )


def _header(headers: Mapping[str, str] | None, name: str) -> str | None:
    return next((value for key, value in (headers or {}).items() if key.lower() == name), None)


def _response(dialect: Dialect, headers: Mapping[str, str] | None, requested_model: str | None, **fields: Any) -> AssembledResponse:
    response_id = fields.pop("response_id", None)
    header_generation = _header(headers, "x-generation-id")
    defaults: dict[str, Any] = {
        "resolved_model": None,
        "provider": None,
        "text": "",
        "error": None,
        "finish_reason": None,
        "tool_proposals": (),
        "usage": None,
        "frame_count": None,
        "terminal_frame": None,
    }
    return AssembledResponse(
        dialect=dialect,
        response_id=response_id,
        generation_id=_generation_id(response_id) or header_generation,
        requested_model=requested_model,
        **{**defaults, **fields},
    )


# --- Chat Completions ---------------------------------------------------------------------------------------------


def _chat_status(error: str | None, done: bool, finish: str | None) -> Status:
    if error is not None or finish == "error":
        return "error"
    if not done:
        return "interrupted"
    return "incomplete" if finish == "length" else "completed"


def _assemble_chat_stream(frames: Sequence[SseFrame], headers: Mapping[str, str] | None, requested_model: str | None) -> AssembledResponse:
    response_id = resolved = provider = error = finish = None
    done_frame: int | None = None
    text: dict[int, list[str]] = {}
    proposals: dict[tuple[int, int], _Proposal] = {}
    finish_frames: dict[int, int] = {}
    usage: Mapping[str, Any] | None = None
    for frame in _data_frames(frames):
        if frame.data == "[DONE]":
            done_frame = frame.index
            continue
        chunk = _event(frame)
        response_id = response_id or chunk.get("id")
        resolved = chunk.get("model") or resolved
        provider = chunk.get("provider") or provider
        if "error" in chunk:
            error = _error_text(chunk["error"])
        if chunk.get("usage") is not None:
            usage = chunk["usage"]  # the final usage chunk has empty ``choices`` and must still be retained
        for position, choice in enumerate(chunk.get("choices") or []):
            index = choice.get("index", position)
            delta = choice.get("delta") or {}
            if delta.get("content"):
                text.setdefault(index, []).append(delta["content"])
            for fragment in delta.get("tool_calls") or []:
                _chat_fragment(proposals, index, fragment, frame.index)
            if choice.get("finish_reason"):
                finish = finish or choice["finish_reason"]
                finish_frames[index] = frame.index
    for (index, _), proposal in proposals.items():
        proposal.completed = finish_frames.get(index)
    return _response(
        "chat_completions",
        headers,
        requested_model,
        response_id=response_id,
        resolved_model=resolved,
        provider=provider,
        text="".join("".join(text[index]) for index in sorted(text)),
        status=_chat_status(error, done_frame is not None, finish),
        error=error,
        finish_reason=finish,
        tool_proposals=tuple(proposal.freeze() for proposal in proposals.values()),
        usage=usage,
        frame_count=len(frames),
        terminal_frame=done_frame,
    )


def _chat_fragment(proposals: dict[tuple[int, int], _Proposal], choice: int, fragment: dict[str, Any], frame: int) -> None:
    tool = fragment.get("index")
    if not isinstance(tool, int):
        raise MalformedFrameError(f"frame {frame}: tool call fragment has no integer index")
    proposal = proposals.setdefault((choice, tool), _Proposal(frame, choice_index=choice, tool_index=tool))
    function = fragment.get("function") or {}
    proposal.call_id = proposal.call_id or fragment.get("id")
    proposal.name = proposal.name or function.get("name") or ""
    proposal.fragments.append(function.get("arguments") or "")


def _chat_proposals(choice: int, calls: Sequence[dict[str, Any]]) -> list[ToolProposal]:
    proposals = []
    for position, call in enumerate(calls):
        function = call.get("function") or {}
        proposal = _Proposal(None, choice_index=choice, tool_index=position)
        proposal.call_id = call.get("id")
        proposal.name = function.get("name") or ""
        proposal.arguments = function.get("arguments") or ""
        proposals.append(proposal.freeze())
    return proposals


def _assemble_chat_body(body: Mapping[str, Any], headers: Mapping[str, str] | None, requested_model: str | None) -> AssembledResponse:
    error = _error_text(body["error"]) if "error" in body else None
    text: list[str] = []
    proposals: list[ToolProposal] = []
    finish = None
    for position, choice in enumerate(body.get("choices") or []):
        message = choice.get("message") or {}
        if isinstance(message.get("content"), str):
            text.append(message["content"])
        proposals += _chat_proposals(choice.get("index", position), message.get("tool_calls") or [])
        finish = finish or choice.get("finish_reason")
    return _response(
        "chat_completions",
        headers,
        requested_model,
        response_id=body.get("id"),
        resolved_model=body.get("model"),
        provider=body.get("provider"),
        text="".join(text),
        status=_chat_status(error, True, finish),
        error=error,
        finish_reason=finish,
        tool_proposals=tuple(proposals),
        usage=body.get("usage"),
    )


# --- Responses ----------------------------------------------------------------------------------------------------


_RESPONSES_TERMINAL: dict[str, Status] = {
    "response.completed": "completed",
    "response.failed": "failed",
    "response.incomplete": "incomplete",
    "error": "error",
}


def _responses_item(output_index: int, item: Mapping[str, Any], frame: int | None) -> _Proposal:
    proposal = _Proposal(frame, item_id=item.get("id"), output_index=output_index)
    proposal.call_id = item.get("call_id")
    proposal.name = item.get("name") or ""
    return proposal


def _assemble_responses_stream(frames: Sequence[SseFrame], headers: Mapping[str, str] | None, requested_model: str | None) -> AssembledResponse:
    response_id = resolved = error = finish = None
    status: Status = "interrupted"
    terminal: int | None = None
    usage: Mapping[str, Any] | None = None
    text: list[str] = []
    by_item: dict[str, _Proposal] = {}
    for frame in _data_frames(frames):
        # OpenRouter ends a Responses stream with the chat-completions `[DONE]` sentinel after `response.completed`.
        if frame.data == "[DONE]":
            continue
        event = _event(frame)
        kind = event.get("type")
        response = event.get("response") or {}
        response_id = response_id or response.get("id")
        resolved = response.get("model") or resolved
        if kind == "response.output_item.added" and (event.get("item") or {}).get("type") == "function_call":
            item = event["item"]
            by_item[item["id"]] = _responses_item(event["output_index"], item, frame.index)
        elif kind in ("response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done"):
            _responses_progress(by_item, kind, event, frame.index)
        elif kind == "response.output_text.delta":
            text.append(event.get("delta") or "")
        elif kind in _RESPONSES_TERMINAL:
            status, terminal = _RESPONSES_TERMINAL[kind], frame.index
            usage = response.get("usage") or usage
            if kind == "response.failed":
                error = _error_text(response.get("error"))
            elif kind == "response.incomplete":
                finish = (response.get("incomplete_details") or {}).get("reason")
            elif kind == "error":
                error = _error_text(event.get("error") or event)
    return _response(
        "responses",
        headers,
        requested_model,
        response_id=response_id,
        resolved_model=resolved,
        text="".join(text),
        status=status,
        error=error,
        finish_reason=finish,
        tool_proposals=tuple(proposal.freeze() for proposal in sorted(by_item.values(), key=lambda p: p.ids["output_index"])),
        usage=usage,
        frame_count=len(frames),
        terminal_frame=terminal,
    )


def _responses_progress(by_item: dict[str, _Proposal], kind: str, event: Mapping[str, Any], frame: int) -> None:
    item_id = event.get("item_id") or (event.get("item") or {}).get("id")
    if item_id not in by_item:
        if kind == "response.output_item.done":
            return  # a message or reasoning item
        raise MalformedFrameError(f"frame {frame}: {kind} for unknown output item {item_id!r}")
    proposal = by_item[item_id]
    if kind == "response.function_call_arguments.delta":
        proposal.fragments.append(event.get("delta") or "")
        return
    if kind == "response.function_call_arguments.done":
        proposal.arguments = event.get("arguments")
        proposal.name = event.get("name") or proposal.name
    else:
        item = event["item"]
        proposal.arguments = item.get("arguments", proposal.arguments)
        proposal.call_id = item.get("call_id") or proposal.call_id
        proposal.name = item.get("name") or proposal.name
    if proposal.completed is None:
        proposal.completed = frame


def _assemble_responses_body(body: Mapping[str, Any], headers: Mapping[str, str] | None, requested_model: str | None) -> AssembledResponse:
    if "error" in body and body.get("status") is None:
        status: Status = "error"
    else:
        status = {"completed": "completed", "failed": "failed", "incomplete": "incomplete"}.get(body.get("status"))  # type: ignore[assignment]
        if status is None:
            raise MalformedBodyError(f"response has non-terminal or unknown status {body.get('status')!r}")
    text: list[str] = []
    proposals: list[ToolProposal] = []
    for output_index, item in enumerate(body.get("output") or []):
        if item.get("type") == "function_call":
            proposal = _responses_item(output_index, item, None)
            proposal.arguments = item.get("arguments") or ""
            proposals.append(proposal.freeze())
        elif item.get("type") == "message":
            text += [part.get("text", "") for part in item.get("content") or [] if part.get("type") == "output_text"]
    return _response(
        "responses",
        headers,
        requested_model,
        response_id=body.get("id"),
        resolved_model=body.get("model"),
        text="".join(text),
        status=status,
        error=_error_text(body["error"]) if body.get("error") else None,
        finish_reason=(body.get("incomplete_details") or {}).get("reason"),
        tool_proposals=tuple(proposals),
        usage=body.get("usage"),
    )


# --- Anthropic Messages -------------------------------------------------------------------------------------------


def _anthropic_status(stop_reason: str | None) -> Status:
    return "incomplete" if stop_reason == "max_tokens" else "completed"


def _merge_usage(merged: dict[str, Any], usage: Mapping[str, Any] | None) -> None:
    merged.update({key: value for key, value in (usage or {}).items() if value is not None})  # latest authoritative value per field


def _assemble_anthropic_stream(frames: Sequence[SseFrame], headers: Mapping[str, str] | None, requested_model: str | None) -> AssembledResponse:
    response_id = resolved = error = stop = None
    status: Status = "interrupted"
    terminal: int | None = None
    usage: dict[str, Any] = {}
    text: list[str] = []
    blocks: dict[int, _Proposal] = {}
    for frame in _data_frames(frames):
        event = _event(frame)
        kind = event.get("type")
        if kind == "message_start":
            message = event.get("message") or {}
            response_id, resolved = message.get("id"), message.get("model")
            _merge_usage(usage, message.get("usage"))
        elif kind == "content_block_start" and (event.get("content_block") or {}).get("type") == "tool_use":
            block = event["content_block"]
            proposal = _Proposal(frame.index, block_index=event["index"])
            proposal.call_id, proposal.name = block.get("id"), block.get("name") or ""
            if block.get("input"):
                proposal.arguments = json.dumps(block["input"])
            blocks[event["index"]] = proposal
        elif kind == "content_block_delta":
            _anthropic_delta(blocks, text, event, frame.index)
        elif kind == "content_block_stop" and event.get("index") in blocks:
            blocks[event["index"]].completed = frame.index
        elif kind == "message_delta":
            stop = (event.get("delta") or {}).get("stop_reason") or stop
            _merge_usage(usage, event.get("usage"))
        elif kind == "message_stop":
            status, terminal = _anthropic_status(stop), frame.index
        elif kind == "error":
            status, terminal, error = "error", frame.index, _error_text(event.get("error") or event)
    return _response(
        "anthropic_messages",
        headers,
        requested_model,
        response_id=response_id,
        resolved_model=resolved,
        text="".join(text),
        status=status,
        error=error,
        finish_reason=stop,
        tool_proposals=tuple(blocks[index].freeze() for index in sorted(blocks)),
        usage=usage or None,
        frame_count=len(frames),
        terminal_frame=terminal,
    )


def _anthropic_delta(blocks: dict[int, _Proposal], text: list[str], event: Mapping[str, Any], frame: int) -> None:
    delta = event.get("delta") or {}
    if delta.get("type") == "text_delta":
        text.append(delta.get("text") or "")
    elif delta.get("type") == "input_json_delta":
        if event.get("index") not in blocks:
            raise MalformedFrameError(f"frame {frame}: input_json_delta for unknown content block {event.get('index')!r}")
        blocks[event["index"]].fragments.append(delta.get("partial_json") or "")


def _assemble_anthropic_body(body: Mapping[str, Any], headers: Mapping[str, str] | None, requested_model: str | None) -> AssembledResponse:
    if body.get("type") == "error":
        return _response("anthropic_messages", headers, requested_model, status="error", error=_error_text(body.get("error")))
    text: list[str] = []
    proposals: list[ToolProposal] = []
    for index, block in enumerate(body.get("content") or []):
        if block.get("type") == "text":
            text.append(block.get("text") or "")
        elif block.get("type") == "tool_use":
            proposal = _Proposal(None, block_index=index)
            proposal.call_id, proposal.name = block.get("id"), block.get("name") or ""
            proposal.arguments = json.dumps(block.get("input"))
            proposals.append(proposal.freeze())
    return _response(
        "anthropic_messages",
        headers,
        requested_model,
        response_id=body.get("id"),
        resolved_model=body.get("model"),
        text="".join(text),
        status=_anthropic_status(body.get("stop_reason")),
        finish_reason=body.get("stop_reason"),
        tool_proposals=tuple(proposals),
        usage=body.get("usage"),
    )


_STREAMS = {
    "chat_completions": _assemble_chat_stream,
    "responses": _assemble_responses_stream,
    "anthropic_messages": _assemble_anthropic_stream,
}
_BODIES = {
    "chat_completions": _assemble_chat_body,
    "responses": _assemble_responses_body,
    "anthropic_messages": _assemble_anthropic_body,
}


def assemble_stream(
    dialect: Dialect, frames: Sequence[SseFrame], headers: Mapping[str, str] | None = None, requested_model: str | None = None
) -> AssembledResponse:
    """Assemble a streamed response from its frames in arrival order."""
    return _STREAMS[dialect](frames, headers, requested_model)


def assemble_body(
    dialect: Dialect, body: Mapping[str, Any], headers: Mapping[str, str] | None = None, requested_model: str | None = None
) -> AssembledResponse:
    """Assemble a non-streaming JSON response body."""
    return _BODIES[dialect](body, headers, requested_model)


# --- Requests -----------------------------------------------------------------------------------------------------


def _id(value: Any) -> str:
    if not isinstance(value, str):
        raise TypeError(f"a tool call id must be a string, got {type(value).__name__}")
    return value


def _chat_request(body: Mapping[str, Any]) -> tuple[list[str], list[ToolResultSent]]:
    names = [tool["function"]["name"] for tool in body.get("tools") or []]
    results = [
        ToolResultSent(_id(message["tool_call_id"]), message.get("content"), index)
        for index, message in enumerate(body.get("messages") or [])
        if message.get("role") == "tool"
    ]
    return names, results


def _responses_request(body: Mapping[str, Any]) -> tuple[list[str], list[ToolResultSent]]:
    names = [tool["name"] for tool in body.get("tools") or []]
    items = body.get("input")
    results = [
        ToolResultSent(_id(item["call_id"]), item.get("output"), index)
        for index, item in enumerate(items if isinstance(items, list) else [])
        if isinstance(item, dict) and item.get("type") == "function_call_output"
    ]
    return names, results


def _anthropic_request(body: Mapping[str, Any]) -> tuple[list[str], list[ToolResultSent]]:
    names = [tool["name"] for tool in body.get("tools") or []]
    results = [
        ToolResultSent(_id(block["tool_use_id"]), block.get("content"), index)
        for index, message in enumerate(body.get("messages") or [])
        if isinstance(message.get("content"), list)
        for block in message["content"]
        if block.get("type") == "tool_result"
    ]
    return names, results


_REQUESTS = {"chat_completions": _chat_request, "responses": _responses_request, "anthropic_messages": _anthropic_request}


def parse_request(dialect: Dialect, body: Mapping[str, Any]) -> ParsedModelRequest:
    """Extract the model, stream flag, declared tool names and tool results sent back to the model."""
    try:
        names, results = _REQUESTS[dialect](body)
    except (KeyError, TypeError, AttributeError) as error:
        raise MalformedBodyError(f"{dialect} request is malformed: {error!r}") from error
    return ParsedModelRequest(dialect, body.get("model"), bool(body.get("stream")), tuple(names), tuple(results))


def append_system(dialect: Dialect, body: dict[str, Any], text: str) -> None:
    """Add ``text`` to ``body``'s system prompt in place, after the agent's own: appended after a blank line to a string, as a text
    block to a block list, and set (a leading system message for Chat Completions) when there is none."""
    if dialect == "responses":
        existing = body.get("instructions")
        body["instructions"] = text if existing is None else f"{existing}\n\n{text}"
    elif dialect == "anthropic_messages":
        existing = body.get("system")
        if isinstance(existing, list):
            existing.append({"type": "text", "text": text})
        else:
            body["system"] = text if existing is None else f"{existing}\n\n{text}"
    else:
        messages = body.get("messages")
        if not isinstance(messages, list):
            return
        first = messages[0] if messages and isinstance(messages[0], dict) else None
        if first is None or first.get("role") != "system":
            messages.insert(0, {"role": "system", "content": text})
        elif isinstance(first.get("content"), list):
            first["content"].append({"type": "text", "text": text})
        else:
            first["content"] = text if first.get("content") is None else f"{first['content']}\n\n{text}"
