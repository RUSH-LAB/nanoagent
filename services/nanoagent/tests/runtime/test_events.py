"""Offline tests for :mod:`nanoagent.runtime.events` — the run mirrored as an NDJSON stream.

Four properties:

* **the line sequence is the run** — a scripted two-step run (one tool call, then an answer)
  produces exactly ``tool, step, done``, in that order, with the tool event before the step it
  belongs to.
* **every line stands alone** — each is independently ``json.loads``-able, which is the whole
  contract for a watcher tailing the file. Line buffering is what makes it true mid-run.
* **a delta carries only its fragment** — never the message so far. The cumulative form is
  quadratic in the reply length, and Pi removed it in 0.84.0 for exactly that reason.
* **concurrent rollouts stay separable** — two runs sharing one writer interleave in the file but
  each line is stamped with its own ``label`` and no line is torn.

Fully offline: scripted in-process models, ``tmp_path``, no server or network.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_events.py -x -q
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from nanoagent.core.agent import Agent, Reply, ToolCall
from nanoagent.runtime.events import EventWriter
from nanoagent.core.tool import JsonSchema, Tool


class _Echo(Tool):
    """Echo the text back."""

    NAME = "echo"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    }

    def run(self, text: str) -> str:
        return text


class _CallsThenAnswers:
    """Turn 1 calls ``echo``; turn 2 answers. Streams two fragments when asked to."""

    def __init__(self, answer: str = "done") -> None:
        self._answer = answer

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        if not any(m.get("role") == "tool" for m in messages):
            return Reply(content=None, tool_calls=[ToolCall("c1", "echo", '{"text": "hi"}')])
        if on_delta is not None:
            on_delta("content", "he")
            on_delta("content", "llo")
        return Reply(content=self._answer, usage={"total_tokens": 7})


def _lines(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


async def test_a_run_is_the_expected_line_sequence(tmp_path: Path) -> None:
    out = tmp_path / "events.jsonl"
    agent = Agent(
        _CallsThenAnswers(), [_Echo()], system_prompt="SYS", events=EventWriter(out), max_steps=4
    )
    await agent.run("go", label="t1")

    events = _lines(out)
    assert [e["type"] for e in events] == ["tool", "step", "done"]
    tool, step, done = events
    assert tool["name"] == "echo" and tool["output"] == "hi" and tool["is_error"] is False
    assert step["step"] == 1  # the tool event precedes the step that produced it
    assert done["stop_reason"] == "answer" and done["answer"] == "done"
    assert done["usage"]["total_tokens"] == 7 and done["error"] is None
    assert all(e["label"] == "t1" for e in events)


async def test_deltas_carry_only_the_fragment(tmp_path: Path) -> None:
    # on_delta is teed ONLY when the caller passed one, so this is the REPL's shape.
    out = tmp_path / "events.jsonl"
    agent = Agent(
        _CallsThenAnswers(), [_Echo()], system_prompt="SYS", events=EventWriter(out), max_steps=4
    )
    seen: list[tuple[str, str]] = []
    await agent.run("go", on_delta=lambda k, t: seen.append((k, t)))

    deltas = [e for e in _lines(out) if e["type"] == "delta"]
    # The fragments as sent, NOT "he" then "hello": a cumulative stream is quadratic in the reply.
    assert [d["text"] for d in deltas] == ["he", "llo"]
    assert seen == [("content", "he"), ("content", "llo")]  # the caller's callback still ran


async def test_no_writer_means_no_stream_and_no_deltas(tmp_path: Path) -> None:
    # The off path: nothing is written, and the model is NOT switched into streaming.
    agent = Agent(_CallsThenAnswers(), [_Echo()], system_prompt="SYS", max_steps=4)
    result = await agent.run("go")
    assert result.answer == "done"
    assert list(tmp_path.iterdir()) == []


async def test_concurrent_rollouts_share_one_file_without_tearing(tmp_path: Path) -> None:
    # One writer, one Agent, two rollouts at once — the batch shape. Each line must be whole and
    # attributable, and each run's tool cursor must be its own (a shared one would drop a row).
    out = tmp_path / "events.jsonl"
    agent = Agent(
        _CallsThenAnswers(), [_Echo()], system_prompt="SYS", events=EventWriter(out), max_steps=4
    )
    await asyncio.gather(agent.run("a", label="t1"), agent.run("b", label="t2"))

    events = _lines(out)  # json.loads on every line: a torn write fails here
    assert len(events) == 6
    for label in ("t1", "t2"):
        assert [e["type"] for e in events if e["label"] == label] == ["tool", "step", "done"]
