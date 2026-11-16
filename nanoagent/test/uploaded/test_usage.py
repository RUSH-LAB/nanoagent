from __future__ import annotations

from decimal import Decimal

import pytest

from nanoagent.uploaded.dialects import AssembledResponse, assemble_body, assemble_stream, split_sse
from nanoagent.uploaded.usage import NOT_DISPATCHED, MalformedUsageError, NormalizedUsage, aggregate, reconcile, usage_for

# The live experiment: every dialect returned 51 input and 6 output tokens at $0.00003.


def test_chat_exact_numbers_from_live_experiment():
    body = {"id": "gen-1", "usage": {"prompt_tokens": 51, "completion_tokens": 6, "total_tokens": 57, "cost": 0.00003}}
    usage = usage_for("chat_completions", body)
    assert (usage.input, usage.output, usage.total, usage.supplied_total, usage.cost_usd) == (51, 6, 57, 57, Decimal("0.00003"))
    assert usage.discrepancies == ()
    assert (usage.cache_read, usage.cache_write, usage.reasoning) == (None, None, None)
    assert usage.source_ids == ("gen-1",)


def test_responses_exact_numbers_from_live_experiment():
    usage = usage_for("responses", {"usage": {"input_tokens": 51, "output_tokens": 6, "cost": 0.00003}})
    assert (usage.input, usage.output, usage.total, usage.cost_usd) == (51, 6, 57, Decimal("0.00003"))


def test_anthropic_exact_numbers_from_live_experiment():
    usage = usage_for("anthropic_messages", {"usage": {"input_tokens": 51, "output_tokens": 6}})
    assert (usage.input, usage.output, usage.total, usage.cache_read, usage.cache_write) == (51, 6, 57, 0, 0)


def test_chat_cache_and_reasoning_are_parts_not_additions():
    usage = usage_for(
        "chat_completions",
        {
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 30,
                "prompt_tokens_details": {"cached_tokens": 60, "cache_write_tokens": 10},
                "completion_tokens_details": {"reasoning_tokens": 20},
            }
        },
    )
    assert (usage.input, usage.output, usage.total) == (100, 30, 130)
    assert (usage.cache_read, usage.cache_write, usage.reasoning) == (60, 10, 20)


def test_responses_cache_and_reasoning():
    usage = usage_for(
        "responses",
        {
            "usage": {
                "input_tokens": 100,
                "output_tokens": 30,
                "input_tokens_details": {"cached_tokens": 60, "cache_write_tokens": 5},
                "output_tokens_details": {"reasoning_tokens": 20},
            }
        },
    )
    assert (usage.total, usage.cache_read, usage.cache_write, usage.reasoning) == (130, 60, 5, 20)


def test_supplied_total_discrepancy_is_recorded():
    usage = usage_for("chat_completions", {"usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 99}})
    assert usage.total == 15 and usage.supplied_total == 99
    assert len(usage.discrepancies) == 1 and "99" in usage.discrepancies[0]


def test_missing_usage_stays_unknown():
    usage = usage_for("chat_completions", {"id": "x"})
    assert (usage.input, usage.output, usage.total, usage.cost_usd) == (None, None, None, None)
    assert usage.provenance.endswith("no_usage")


def test_invalid_count_is_rejected():
    with pytest.raises(MalformedUsageError):
        usage_for("chat_completions", {"usage": {"prompt_tokens": -1}})
    with pytest.raises(MalformedUsageError):
        usage_for("chat_completions", {"usage": {"prompt_tokens": "51"}})


def sse(data: str) -> bytes:
    return f"data: {data}\n\n".encode()


def test_chat_stream_usage_chunk_with_empty_choices_is_used():
    frames = split_sse(
        sse('{"id":"gen-1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}')
        + sse('{"id":"gen-1","choices":[],"usage":{"prompt_tokens":51,"completion_tokens":6,"cost":0.00003}}')
        + sse("[DONE]")
    )
    assembled = assemble_stream("chat_completions", frames)
    usage = usage_for("chat_completions", assembled)
    assert (usage.input, usage.output, usage.total, usage.cost_usd) == (51, 6, 57, Decimal("0.00003"))
    assert usage.provenance == "chat_completions:stream" and usage.source_ids == ("gen-1",)


def test_anthropic_cumulative_usage_across_lifecycle_with_cache():
    def event(name: str, payload: str) -> bytes:
        return f"event: {name}\ndata: {payload}\n\n".encode()

    frames = split_sse(
        event(
            "message_start",
            '{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3,"cache_read_input_tokens":40,'
            '"cache_creation_input_tokens":8,"output_tokens":1}}}',
        )
        + event("message_delta", '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}')
        + event("message_stop", '{"type":"message_stop"}')
    )
    usage = usage_for("anthropic_messages", assemble_stream("anthropic_messages", frames, {"X-Generation-Id": "gen-h"}))
    assert (usage.input, usage.output, usage.total) == (51, 6, 57)
    assert (usage.cache_read, usage.cache_write, usage.reasoning) == (40, 8, None)
    assert usage.source_ids == ("msg_1", "gen-h")


def test_usage_for_body_matches_assembled_body():
    body = {"id": "gen-2", "choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 2}}
    assembled: AssembledResponse = assemble_body("chat_completions", body)
    assert usage_for("chat_completions", assembled).total == usage_for("chat_completions", body).total == 3


def test_not_dispatched_is_all_zero():
    assert (NOT_DISPATCHED.input, NOT_DISPATCHED.output, NOT_DISPATCHED.total, NOT_DISPATCHED.cache_read) == (0, 0, 0, 0)
    assert NOT_DISPATCHED.provenance == "not_dispatched"


def test_aggregate_known_subtotal_and_missing_counts():
    a = usage_for("chat_completions", {"usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.5}})
    b = usage_for("chat_completions", {"usage": {"prompt_tokens": 7, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 3}}})
    c = usage_for("chat_completions", {})
    total = aggregate([a, b, c])
    assert total.calls == 3
    assert (total.input.known, total.input.missing) == (17, 1)
    assert (total.total.known, total.total.missing) == (23, 1)
    assert (total.cache_read.known, total.cache_read.missing) == (3, 2)
    assert (total.cost_usd.known, total.cost_usd.missing) == (Decimal("0.5"), 2)


def test_aggregate_of_empty_complete_attempt_is_zero_with_nothing_missing():
    total = aggregate([])
    assert total.calls == 0
    for field in ("input", "output", "total", "cache_read", "cache_write", "reasoning", "cost_usd"):
        assert (getattr(total, field).known, getattr(total, field).missing) == (0, 0)


def test_aggregate_includes_not_dispatched_as_zero():
    total = aggregate([NOT_DISPATCHED, usage_for("responses", {"usage": {"input_tokens": 4, "output_tokens": 1}})])
    assert (total.input.known, total.input.missing, total.cache_write.missing) == (4, 0, 1)


def test_reconcile_replaces_fields_keeps_earlier_values_and_ids():
    provisional = usage_for(
        "chat_completions",
        {"id": "gen-1", "usage": {"prompt_tokens": 51, "completion_tokens": 6, "prompt_tokens_details": {"cache_write_tokens": 2}}},
    )
    accounting = {
        "id": "gen-1",
        "native_tokens_prompt": 50,
        "native_tokens_completion": 7,
        "native_tokens_cached": 12,
        "native_tokens_reasoning": 3,
        "total_cost": 0.00004,
    }
    result = reconcile(provisional, accounting)
    assert (result.input, result.output, result.total, result.cache_read, result.reasoning) == (50, 7, 57, 12, 3)
    assert result.cache_write == 2  # not reported by the lookup, kept
    assert result.cost_usd == Decimal("0.00004")
    assert result.provenance == "generation_lookup"
    assert result.source_ids == ("gen-1",)
    assert result.earlier == (provisional,)
    assert aggregate([result]).total.known == 57  # one physical call, counted once


def test_reconcile_leaves_unavailable_values_unknown():
    provisional = NormalizedUsage(None, None, None, None, None, None, None, None, "x", source_ids=("msg_1",))
    result = reconcile(provisional, {"id": "gen-2", "native_tokens_prompt": 5, "native_tokens_completion": None})
    assert (result.input, result.output, result.total) == (5, None, None)
    assert result.source_ids == ("msg_1", "gen-2")
