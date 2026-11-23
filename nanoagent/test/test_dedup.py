"""The MinHash redundancy filter (nanoagent.core.dedup) and its place in the agent loop."""

from __future__ import annotations

import asyncio
import json

import pytest

from nanoagent.core.agent import Agent, Reply, ToolCall
from nanoagent.core.dedup import (  # and stop_after, the other harness_eval flag
    PREFIX,
    DedupConfig,
    MinHasher,
    RedundancyFilter,
    changes,
    dedup_enabled,
    flatten,
    jaccard,
    normalize,
    shingles,
)
from nanoagent.core.tool import Tool


def record(n: int, *, changed: int | None = None) -> str:
    """A tool result like the plugins' (one JSON line): n rows, row ``changed`` (if any) different."""
    rows = [{"query_id": f"mbpp-{i}", "retrieved": [f"mbpp-{i + 1}", f"mbpp-{i + 2}"], "latency_ms": 0.1 * i} for i in range(n)]
    if changed is not None:
        rows[changed]["latency_ms"] = 99.0
    return json.dumps({"run_id": "run-02", "k": 5, "queries": rows})


def test_normalize_prints_json_one_field_per_line_and_leaves_text() -> None:
    assert normalize('{"b": 1, "a": [1, 2]}') == '{\n "a": [\n  1,\n  2\n ],\n "b": 1\n}'
    assert normalize("  plain text \n") == "plain text"
    assert normalize("3") == "3"


def test_flatten_and_changes_name_each_leaf_by_its_path() -> None:
    old = flatten({"a": {"b": [1, 2]}, "c": [], "d": "x"})
    assert old == {"a.b[0]": "1", "a.b[1]": "2", "c": "[]", "d": '"x"'}
    new = flatten({"a": {"b": [1, 3, 4]}, "c": []})
    assert changes(old, new) == ["a.b[1]: 2 -> 3", "+ a.b[2]: 4", "- d"]


def test_text_that_is_not_json_is_diffed_by_line() -> None:
    f = RedundancyFilter()
    base = "\n".join(f"assert f({i}) == {i * i}  # passed" for i in range(30))
    f.apply("c1", "run_tests", base)
    sent = f.apply("c2", "run_tests", base.replace("f(7) == 49  # passed", "f(7) == 49  # FAILED: got 48"))
    assert sent.startswith(PREFIX) and "+assert f(7) == 49  # FAILED: got 48" in sent and "-assert f(7) == 49  # passed" in sent


def test_minhash_estimates_jaccard_and_is_reproducible() -> None:
    a = shingles(normalize(record(30)), 5)
    b = shingles(normalize(record(30, changed=3)), 5)
    hasher = MinHasher(256, seed=1)
    sig_a, sig_b = hasher.signature(a), hasher.signature(b)
    estimate = sum(x == y for x, y in zip(sig_a, sig_b, strict=True)) / 256
    assert abs(estimate - jaccard(a, b)) < 0.1
    assert MinHasher(256, seed=1).signature(a) == sig_a


def test_a_repeated_result_becomes_a_pointer() -> None:
    f = RedundancyFilter()
    assert f.apply("c1", "get_run", record(10)) == record(10)
    sent = f.apply("c2", "get_run", record(10))
    assert sent.startswith(PREFIX) and "c1" in sent and "get_run" in sent
    assert f.stats["exact"] == 1 and f.stats["near"] == 0


def test_the_same_data_in_another_key_order_is_a_repeat() -> None:
    f = RedundancyFilter()
    f.apply("c1", "t", json.dumps({"a": list(range(60)), "b": "x" * 50}))
    assert f.apply("c2", "t", json.dumps({"b": "x" * 50, "a": list(range(60))})).startswith(PREFIX)


def test_a_near_duplicate_is_sent_as_a_diff_that_names_what_changed() -> None:
    f = RedundancyFilter()
    f.apply("c1", "get_run", record(20))
    sent = f.apply("c2", "get_run", record(20, changed=7))
    assert sent.startswith(PREFIX) and "tool call c1" in sent
    assert sent.endswith("queries[7].latency_ms: 0.7000000000000001 -> 99.0")
    assert len(sent) < 0.3 * len(record(20))
    assert f.stats["near"] == 1


def test_a_different_result_is_sent_whole_and_short_ones_are_left_alone() -> None:
    f = RedundancyFilter()
    f.apply("c1", "get_run", record(20))
    other = json.dumps({"problem": "Write a function to remove the first and last occurrence of a given character from the string.",
                        "tests": ["assert remove_Occ('hello','l') == 'heo'", "assert remove_Occ('abcda','a') == 'bcd'"]})
    assert f.apply("c2", "get_problem", other) == other
    assert f.apply("c3", "submit", "Submitted.") == "Submitted."
    assert f.apply("c4", "submit", "Submitted.") == "Submitted."
    assert f.stats == {**f.stats, "exact": 0, "near": 0, "results": 4}


def test_a_diff_is_only_taken_when_it_is_short_enough() -> None:
    f = RedundancyFilter(DedupConfig(threshold=0.1, max_ratio=0.05))
    f.apply("c1", "t", record(20))
    assert f.apply("c2", "t", record(20, changed=7)) == record(20, changed=7)


def test_stats_count_what_was_saved() -> None:
    f = RedundancyFilter()
    f.apply("c1", "t", record(20))
    f.apply("c2", "t", record(20))
    summary = f.summary()
    assert summary["results"] == 2 and summary["chars_in"] == 2 * len(record(20))
    assert summary["tokens_saved_per_send"] == summary["tokens_in"] - summary["tokens_out"] > 0


def test_dedup_enabled_reads_the_flag_then_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NANOAGENT_DEDUP", raising=False)
    assert dedup_enabled(None) is False and dedup_enabled(True) is True
    monkeypatch.setenv("NANOAGENT_DEDUP", "1")
    assert dedup_enabled(None) is True and dedup_enabled(False) is False


class GetRun(Tool):
    """Returns a run's record; the same every time it is asked."""

    NAME = "get_run"
    PARAMETERS = {"type": "object", "properties": {"run_id": {"type": "string"}}, "required": ["run_id"]}

    def run(self, run_id: str) -> str:
        return record(20)


class Loop:
    """Calls get_run twice, then answers: the second result is a repeat of the first."""

    def __init__(self) -> None:
        self.seen: list[list[dict]] = []

    async def query(self, messages, tools, **_):
        self.seen.append([dict(m) for m in messages])
        calls = sum(1 for m in messages if m["role"] == "tool")
        if calls < 2:
            return Reply(content=None, tool_calls=[ToolCall(f"call-{calls + 1}", "get_run", '{"run_id": "run-02"}')],
                         usage={"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11})
        return Reply(content="done", usage={"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11})


@pytest.mark.parametrize("on", [False, True])
def test_the_loop_sends_a_repeat_as_a_pointer_only_when_on(on: bool, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NANOAGENT_DEDUP", raising=False)
    model = Loop()
    result = asyncio.run(Agent(model, [GetRun()], system_prompt="s", max_steps=5, dedup=on).run("go"))
    assert result.answer == "done"
    second = [m["content"] for m in model.seen[-1] if m["role"] == "tool"][1]
    assert second.startswith(PREFIX) is on
    # Whatever the model was sent, the call log (what a trajectory and a verifier read) keeps the full output.
    assert [row["output"] for row in result.tool_calls] == [record(20), record(20)]
    assert (result.dedup is not None) is on
    if on:
        assert result.dedup["exact"] == 1
    # Earlier messages are never rewritten: every prompt is a prefix of the next (a provider's cache stays valid).
    for before, after in zip(model.seen, model.seen[1:]):
        assert after[: len(before)] == before


class Submit(Tool):
    """Takes the answer; refuses an empty one, as a task's submit refuses an output that does not build."""

    NAME = "submit"
    PARAMETERS = {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}

    def run(self, value: str) -> str:
        if not value:
            raise ValueError("empty answer")
        return "Submitted."


class Submitter:
    """Submits ``values`` in turn, one per step, then closes with a chat message (the turn stop_after saves)."""

    def __init__(self, *values: str) -> None:
        self.values, self.calls = list(values), 0

    async def query(self, messages, tools, **_):
        self.calls += 1
        if self.values:
            value = self.values.pop(0)
            return Reply(content=None, tool_calls=[ToolCall(f"s{self.calls}", "submit", json.dumps({"value": value}))])
        return Reply(content="All done: the answer is submitted.")


@pytest.mark.parametrize(("stop_after", "calls"), [(None, 2), (["submit"], 1)])
def test_stop_after_ends_the_run_once_submit_succeeds(stop_after, calls, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NANOAGENT_STOP_AFTER", raising=False)
    model = Submitter("42")
    result = asyncio.run(Agent(model, [Submit()], system_prompt="s", max_steps=5, stop_after=stop_after).run("go"))
    assert model.calls == calls and result.stop_reason == "answer"
    assert result.tool_calls[0]["output"] == "Submitted."


def test_a_failed_submit_does_not_end_the_run() -> None:
    model = Submitter("", "42")  # the first submit errors, the second succeeds
    result = asyncio.run(Agent(model, [Submit()], system_prompt="s", max_steps=5, stop_after=["submit"]).run("go"))
    assert model.calls == 2 and [row["is_error"] for row in result.tool_calls] == [True, False]


def test_stop_after_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NANOAGENT_STOP_AFTER", "submit, ")
    model = Submitter("42")
    asyncio.run(Agent(model, [Submit()], system_prompt="s", max_steps=5).run("go"))
    assert model.calls == 1
