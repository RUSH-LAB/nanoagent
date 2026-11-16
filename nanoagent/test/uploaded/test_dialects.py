from __future__ import annotations

import json
from typing import Any

import pytest

from nanoagent.uploaded.dialects import (
    MalformedBodyError,
    MalformedFrameError,
    SseDecoder,
    assemble_body,
    assemble_stream,
    parse_request,
    split_sse,
)


def sse(data: Any, event: str | None = None) -> bytes:
    head = f"event: {event}\n" if event else ""
    return f"{head}data: {data if isinstance(data, str) else json.dumps(data)}\n\n".encode()


def stream(dialect: str, *frames: bytes, headers: dict[str, str] | None = None):
    return assemble_stream(dialect, split_sse(b"".join(frames)), headers)  # type: ignore[arg-type]


def chat_chunk(delta: dict[str, Any], finish: str | None = None, **extra: Any) -> bytes:
    return sse({"id": "gen-1", "model": "openai/gpt-4.1-mini", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}], **extra})


# --- SSE framing ---


def test_split_sse_handles_crlf_comments_multiline_and_done():
    raw = b": keepalive\r\n\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\ndata: [DONE]\n\n"
    frames = split_sse(raw)
    assert [f.data for f in frames] == [None, "a\nb", "[DONE]"]
    assert frames[0].comments == ("keepalive",)
    assert frames[1].event == "x"
    assert [f.index for f in frames] == [0, 1, 2]
    assert sum(f.byte_length for f in frames) == len(raw)


def test_decoder_is_incremental_safe_for_any_split_point():
    raw = b"event: a\r\ndata: 1\r\n\r\ndata: 2\n\n\n: hb\n\ndata: 3\r\rdata: 4\n\n"
    whole = split_sse(raw)
    for cut in range(len(raw) + 1):
        decoder = SseDecoder()
        frames = decoder.feed(raw[:cut]) + decoder.feed(raw[cut:])
        assert frames == whole


def test_split_sse_rejects_stream_ending_inside_a_frame():
    with pytest.raises(MalformedFrameError, match="ends inside frame 1"):
        split_sse(sse("a") + b"data: partial")


def test_decoder_reports_pending_for_a_cut_stream():
    decoder = SseDecoder()
    assert [f.data for f in decoder.feed(sse("a") + b"data: par")] == ["a"]
    assert decoder.pending


def test_non_utf8_line_is_malformed():
    with pytest.raises(MalformedFrameError, match="not UTF-8"):
        split_sse(b"data: \xff\n\n")


def test_event_data_that_is_not_json_is_malformed():
    with pytest.raises(MalformedFrameError, match="frame 0: data is not valid JSON"):
        stream("chat_completions", sse("{oops"))


# --- Chat ---


def test_chat_fragmented_parallel_tool_calls_with_final_usage_chunk():
    usage = {"prompt_tokens": 51, "completion_tokens": 6, "total_tokens": 57, "cost": 0.00003}
    result = stream(
        "chat_completions",
        chat_chunk({"role": "assistant", "content": ""}),
        chat_chunk({"tool_calls": [{"index": 0, "id": "call_a", "type": "function", "function": {"name": "read", "arguments": ""}}]}),
        chat_chunk({"tool_calls": [{"index": 1, "id": "call_b", "type": "function", "function": {"name": "grep", "arguments": ""}}]}),
        chat_chunk({"tool_calls": [{"index": 0, "function": {"arguments": '{"path":'}}]}),
        chat_chunk({"tool_calls": [{"index": 1, "function": {"arguments": '{"q": "x"}'}}]}),
        chat_chunk({"tool_calls": [{"index": 0, "function": {"arguments": ' "a.txt"}'}}]}),
        chat_chunk({}, "tool_calls", provider="OpenAI"),
        sse({"id": "gen-1", "model": "openai/gpt-4.1-mini", "choices": [], "usage": usage}),
        sse("[DONE]"),
    )
    assert result.status == "completed"
    assert result.finish_reason == "tool_calls"
    assert result.generation_id == "gen-1"
    assert result.provider == "OpenAI"
    assert result.usage == usage
    first, second = result.tool_proposals
    assert (first.call_id, first.name, first.arguments, first.choice_index, first.tool_index) == ("call_a", "read", {"path": "a.txt"}, 0, 0)
    assert (second.call_id, second.name, second.arguments, second.tool_index) == ("call_b", "grep", {"q": "x"}, 1)
    assert (first.started_frame, second.started_frame) == (1, 2)
    assert first.completed_frame == second.completed_frame == 6


def test_chat_malformed_arguments_are_reported_not_repaired():
    result = stream(
        "chat_completions",
        chat_chunk({"tool_calls": [{"index": 0, "id": "c", "function": {"name": "read", "arguments": '{"path": '}}]}),
        chat_chunk({}, "tool_calls"),
        sse("[DONE]"),
    )
    (proposal,) = result.tool_proposals
    assert proposal.raw_arguments == '{"path": '
    assert proposal.arguments is None
    assert "not valid JSON" in (proposal.arguments_error or "")


def test_chat_stream_cut_before_done_is_interrupted():
    result = stream("chat_completions", chat_chunk({"content": "hel"}), chat_chunk({"content": "lo"}))
    assert (result.status, result.text, result.terminal_frame) == ("interrupted", "hello", None)


def test_chat_midstream_error_chunk():
    error = {"code": 502, "message": "upstream died"}
    result = stream(
        "chat_completions",
        chat_chunk({"content": "hi"}),
        sse({"id": "gen-1", "error": error, "choices": [{"index": 0, "delta": {"content": ""}, "finish_reason": "error"}]}),
        sse("[DONE]"),
    )
    assert result.status == "error"
    assert json.loads(result.error or "") == error


def test_chat_length_finish_is_incomplete():
    result = stream("chat_completions", chat_chunk({"content": "x"}, "length"), sse("[DONE]"))
    assert result.status == "incomplete"


def test_chat_body_with_tool_call_and_provider():
    body = {
        "id": "gen-9",
        "model": "m",
        "provider": "Azure",
        "choices": [
            {
                "index": 0,
                "finish_reason": "tool_calls",
                "message": {"content": None, "tool_calls": [{"id": "c1", "function": {"name": "read", "arguments": '{"a": 1}'}}]},
            }
        ],
        "usage": {"prompt_tokens": 51, "completion_tokens": 6},
    }
    result = assemble_body("chat_completions", body, requested_model="req")
    assert (result.generation_id, result.provider, result.requested_model, result.status) == ("gen-9", "Azure", "req", "completed")
    assert result.tool_proposals[0].arguments == {"a": 1}


def test_chat_error_body():
    result = assemble_body("chat_completions", {"error": {"code": 429, "message": "slow down"}})
    assert result.status == "error"


# --- Responses ---


def responses_events(*events: tuple[str, dict[str, Any]]) -> list[bytes]:
    return [sse({"type": kind, **fields}, kind) for kind, fields in events]


def test_responses_parallel_function_calls_and_completed_usage():
    item_a = {"id": "fc_a", "type": "function_call", "call_id": "call_a", "name": "read", "arguments": ""}
    item_b = {"id": "fc_b", "type": "function_call", "call_id": "call_b", "name": "grep", "arguments": ""}
    usage = {"input_tokens": 51, "output_tokens": 6, "total_tokens": 57}
    result = stream(
        "responses",
        *responses_events(
            ("response.created", {"response": {"id": "gen-r1", "model": "m", "status": "in_progress"}}),
            ("response.output_item.added", {"output_index": 0, "item": item_a}),
            ("response.output_item.added", {"output_index": 1, "item": item_b}),
            ("response.function_call_arguments.delta", {"item_id": "fc_a", "output_index": 0, "delta": '{"path"'}),
            ("response.function_call_arguments.delta", {"item_id": "fc_b", "output_index": 1, "delta": '{"q":1}'}),
            ("response.function_call_arguments.delta", {"item_id": "fc_a", "output_index": 0, "delta": ': "a"}'}),
            ("response.function_call_arguments.done", {"item_id": "fc_a", "output_index": 0, "name": "read", "arguments": '{"path": "a"}'}),
            ("response.function_call_arguments.done", {"item_id": "fc_b", "output_index": 1, "name": "grep", "arguments": '{"q":1}'}),
            ("response.completed", {"response": {"id": "gen-r1", "model": "m", "status": "completed", "usage": usage}}),
        ),
    )
    assert (result.status, result.generation_id, result.usage) == ("completed", "gen-r1", usage)
    first, second = result.tool_proposals
    assert (first.item_id, first.call_id, first.arguments, first.output_index) == ("fc_a", "call_a", {"path": "a"}, 0)
    assert (second.item_id, second.call_id, second.arguments) == ("fc_b", "call_b", {"q": 1})
    assert (first.started_frame, first.completed_frame, second.completed_frame) == (1, 6, 7)


def test_responses_stream_ending_in_done_sentinel_is_completed():
    usage = {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7}
    result = stream(
        "responses",
        *responses_events(
            ("response.created", {"response": {"id": "gen-r2", "model": "m", "status": "in_progress"}}),
            ("response.completed", {"response": {"id": "gen-r2", "model": "m", "status": "completed", "usage": usage}}),
        ),
        b"data: [DONE]\n\n",
    )
    assert (result.status, result.generation_id, result.usage) == ("completed", "gen-r2", usage)


def test_responses_failed():
    result = stream(
        "responses",
        *responses_events(
            ("response.created", {"response": {"id": "resp_1"}}),
            ("response.failed", {"response": {"id": "resp_1", "error": {"code": "server_error", "message": "boom"}}}),
        ),
    )
    assert result.status == "failed"
    assert json.loads(result.error or "")["code"] == "server_error"
    assert result.generation_id is None


def test_responses_incomplete_reason_and_cut_stream():
    incomplete = stream(
        "responses",
        *responses_events(("response.incomplete", {"response": {"id": "r", "incomplete_details": {"reason": "max_output_tokens"}}})),
    )
    assert (incomplete.status, incomplete.finish_reason) == ("incomplete", "max_output_tokens")
    cut = stream("responses", *responses_events(("response.output_text.delta", {"delta": "hi"})))
    assert (cut.status, cut.text) == ("interrupted", "hi")


def test_responses_delta_for_unknown_item_is_malformed():
    with pytest.raises(MalformedFrameError, match="unknown output item 'fc_x'"):
        stream("responses", *responses_events(("response.function_call_arguments.delta", {"item_id": "fc_x", "delta": "{"})))


def test_responses_error_event_is_midstream_error():
    result = stream("responses", *responses_events(("error", {"error": {"message": "x"}})))
    assert result.status == "error"


def test_responses_body():
    body = {
        "id": "gen-b",
        "status": "completed",
        "model": "m",
        "output": [
            {"id": "msg_0", "type": "message", "content": [{"type": "output_text", "text": "ok"}]},
            {"id": "fc_1", "type": "function_call", "call_id": "c1", "name": "read", "arguments": '{"a":1}'},
        ],
        "usage": {"input_tokens": 51, "output_tokens": 6},
    }
    result = assemble_body("responses", body)
    assert (result.text, result.tool_proposals[0].call_id, result.tool_proposals[0].item_id) == ("ok", "c1", "fc_1")
    with pytest.raises(MalformedBodyError):
        assemble_body("responses", {**body, "status": "in_progress"})


# --- Anthropic ---


def anthropic_events(*events: dict[str, Any]) -> list[bytes]:
    return [sse(event, event["type"]) for event in events]


def anthropic_start(usage: dict[str, Any]) -> dict[str, Any]:
    return {"type": "message_start", "message": {"id": "msg_1", "model": "anthropic/claude", "usage": usage}}


def test_anthropic_parallel_tool_use_blocks_with_generation_header():
    result = stream(
        "anthropic_messages",
        *anthropic_events(
            anthropic_start({"input_tokens": 3, "cache_read_input_tokens": 40, "cache_creation_input_tokens": 8, "output_tokens": 1}),
            {"type": "ping"},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Looking"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "toolu_a", "name": "read", "input": {}}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"path":'}},
            {"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_b", "name": "grep", "input": {}}},
            {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": ' "a"}'}},
            {"type": "content_block_stop", "index": 1},
            {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "{}"}},
            {"type": "content_block_stop", "index": 2},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 6}},
            {"type": "message_stop"},
        ),
        headers={"X-Generation-Id": "gen-hdr"},
    )
    assert (result.status, result.response_id, result.generation_id, result.text) == ("completed", "msg_1", "gen-hdr", "Looking")
    assert result.finish_reason == "tool_use"
    assert result.usage == {"input_tokens": 3, "cache_read_input_tokens": 40, "cache_creation_input_tokens": 8, "output_tokens": 6}
    first, second = result.tool_proposals
    assert (first.block_index, first.call_id, first.arguments) == (1, "toolu_a", {"path": "a"})
    assert (second.block_index, second.call_id, second.arguments) == (2, "toolu_b", {})
    assert first.completed_frame == 9 and second.completed_frame == 11


def test_anthropic_cut_stream_and_error_event():
    cut = stream("anthropic_messages", *anthropic_events(anthropic_start({"input_tokens": 1})))
    assert cut.status == "interrupted"
    failed = stream(
        "anthropic_messages",
        *anthropic_events(anthropic_start({}), {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
    )
    assert failed.status == "error"
    assert "overloaded_error" in (failed.error or "")


def test_anthropic_body_and_error_body():
    body = {
        "id": "msg_2",
        "model": "m",
        "stop_reason": "tool_use",
        "content": [{"type": "tool_use", "id": "toolu_1", "name": "read", "input": {"a": 1}}],
        "usage": {"input_tokens": 51, "output_tokens": 6},
    }
    result = assemble_body("anthropic_messages", body, headers={"x-generation-id": "gen-z"})
    assert (result.response_id, result.generation_id, result.tool_proposals[0].arguments) == ("msg_2", "gen-z", {"a": 1})
    assert assemble_body("anthropic_messages", {"type": "error", "error": {"message": "x"}}).status == "error"


# --- Requests ---


def test_parse_chat_request_tool_results():
    body = {
        "model": "m",
        "stream": True,
        "tools": [{"type": "function", "function": {"name": "read"}}],
        "messages": [{"role": "user", "content": "x"}, {"role": "tool", "tool_call_id": "call_a", "content": "file text"}],
    }
    request = parse_request("chat_completions", body)
    assert (request.model, request.stream, request.tool_names) == ("m", True, ("read",))
    assert [(r.call_id, r.content, r.message_index) for r in request.tool_results] == [("call_a", "file text", 1)]


def test_parse_responses_request_tool_results():
    body = {"model": "m", "tools": [{"type": "function", "name": "read"}], "input": [{"type": "function_call_output", "call_id": "c1", "output": "o"}]}
    request = parse_request("responses", body)
    assert (request.stream, request.tool_names, request.tool_results[0].call_id) == (False, ("read",), "c1")


def test_parse_anthropic_request_tool_results_and_malformed():
    body = {
        "model": "m",
        "tools": [{"name": "read"}],
        "messages": [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "o"}]}],
    }
    request = parse_request("anthropic_messages", body)
    assert (request.tool_results[0].call_id, request.tool_results[0].content) == ("toolu_1", "o")
    with pytest.raises(MalformedBodyError):
        parse_request("chat_completions", {"messages": [{"role": "tool"}]})
