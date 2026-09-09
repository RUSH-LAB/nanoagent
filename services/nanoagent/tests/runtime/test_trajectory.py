"""Byte-identity + O(N) metric tests for the incremental trajectory writer.

Drives the REAL :class:`~nanoagent.core.agent.Agent` loop with an in-process scripted
``ChatModel`` (mirrors :mod:`...tests.test_context`'s mock — no model server is contacted),
and pins the two properties of
:class:`~nanoagent.runtime.trajectory.IncrementalTrajectoryWriter`:

* ``test_incremental_save_byte_identical`` — after every step its file is byte-for-byte equal
  to the one :func:`~nanoagent.runtime.trajectory.save` writes (behavior preserved). The run has tool
  calls whose arguments/output carry characters ``json.dumps`` must escape, so the test exercises
  real escaping in the ``messages`` splice (incl. the inlined per-step ``durations`` and per-result
  ``is_error``); ``..._no_tool_calls_...`` covers the answer-immediately case.
* ``test_incremental_save_is_linear`` — it JSON-encodes each transcript message exactly once over
  a run (O(N)), strictly fewer than ``save``'s re-encode-everything-each-step O(N^2).

Both tests import :class:`~nanoagent.runtime.trajectory.IncrementalTrajectoryWriter`, so they error
out (fail) on the un-optimized code and pass only once the writer exists.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_trajectory.py -x -q
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from nanoagent.runtime import trajectory
from nanoagent.core.agent import Agent, AgentResult, Reply, ToolCall
from nanoagent.core.tool import JsonSchema, Tool


class _NoopTool(Tool):
    """A no-op tool: gives the agent loop a tool call to dispatch on each tool step.

    Its output carries characters ``json.dumps`` must escape (quote, backslash, tab,
    newline, non-ASCII) so the byte-identity test exercises real escaping in the ``messages``
    splice (the tool result's ``content``) — including that an escaped newline stays inside its
    rendered block (``_indent`` only ever splits on structural newlines).
    """

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return 'ok: "quoted", tab\t newline\n unicode π backslash \\ end'


class _ScriptedModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel`: ``tool_steps`` ``noop`` turns then DONE.

    Mirrors ``test_context._MockModel`` but minimal: the first ``tool_steps`` turns each return
    one ``noop`` tool call; the next returns the final answer ``"DONE"``. No server is contacted.
    """

    def __init__(self, *, tool_steps: int) -> None:
        self._tool_steps = tool_steps
        self._turn = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self._turn += 1
        if self._turn <= self._tool_steps:
            return Reply(
                content=None,
                tool_calls=[ToolCall(id=f"c{self._turn}", name="noop", arguments="{}")],
                usage={"prompt_tokens": 1},
            )
        return Reply(content="DONE", usage={"prompt_tokens": 1})


def _agent(tool_steps: int) -> Agent:
    # No context_window -> compaction disabled, exactly as the batch path builds the agent, so
    # the transcript only grows by appending.
    return Agent(
        _ScriptedModel(tool_steps=tool_steps),
        [_NoopTool()],
        system_prompt="SYS",
        max_steps=20,
    )


async def _assert_byte_identical(tmp_path: Path, tool_steps: int) -> AgentResult:
    """Run the agent saving each step both ways; assert the files match byte-for-byte."""
    agent = _agent(tool_steps=tool_steps)
    meta = {"task_id": "t", "task": "go", "model": "scripted"}
    logs: list[dict[str, Any]] = []
    writer = trajectory.IncrementalTrajectoryWriter(tmp_path / "incr.traj.json")
    baseline_path = tmp_path / "baseline.traj.json"
    pairs: list[tuple[bytes, bytes]] = []

    # Compare bytes at EVERY step (record then assert after the run, so an AssertionError can't
    # be swallowed by Agent.run's except handler and re-emitted as an error step).
    def on_step(r: AgentResult) -> None:
        incr = writer.save(r, meta=meta, logs=logs)
        base = trajectory.save(r, baseline_path, meta=meta, logs=logs)
        pairs.append((incr.read_bytes(), base.read_bytes()))

    result = await agent.run("go", on_step=on_step)

    assert pairs, "on_step never fired"
    for i, (incr, base) in enumerate(pairs):
        assert incr == base, f"step {i}: incremental bytes differ from trajectory.save"
    # The final state is the last on_step, but assert it explicitly and that load() round-trips.
    final_incr = writer.save(result, meta=meta, logs=logs).read_bytes()
    final_base = trajectory.save(result, baseline_path, meta=meta, logs=logs).read_bytes()
    assert final_incr == final_base
    assert trajectory.load(writer.path)["answer"] == "DONE"
    return result


async def test_incremental_save_byte_identical(tmp_path: Path) -> None:
    # tool_steps=5 -> the transcript carries 5 tool turns, so byte-identity covers tool messages
    # (with escape-worthy content) and their inlined is_error alongside the assistant durations.
    result = await _assert_byte_identical(tmp_path, tool_steps=5)
    assert len(result.tool_calls) == 5, "must cover a run WITH tool calls"


async def test_incremental_save_no_tool_calls_byte_identical(tmp_path: Path) -> None:
    # tool_steps=0 -> the agent answers immediately (one assistant turn, no tool messages); the
    # single-message splice must still render byte-identically.
    result = await _assert_byte_identical(tmp_path, tool_steps=0)
    assert result.tool_calls == []


async def test_incremental_save_is_linear(tmp_path: Path) -> None:
    # 10 tool turns + 1 answer = 11 model turns; transcript = 2 seed + 2*10 + 1 = 23 messages.
    agent = _agent(tool_steps=10)
    meta = {"task_id": "t"}
    logs: list[dict[str, Any]] = []
    writer = trajectory.IncrementalTrajectoryWriter(tmp_path / "incr.traj.json")
    baseline_encodes = 0  # message objects json.dumps(to_dict(...)) re-encodes across saves

    # Count only; do not assert inside on_step — Agent.run runs it in its try block and would
    # swallow an AssertionError (see test_incremental_save_byte_identical). Assert after the run.
    def on_step(r: AgentResult) -> None:
        nonlocal baseline_encodes
        writer.save(r, meta=meta, logs=logs)
        baseline_encodes += len(r.messages)  # what trajectory.save would re-encode this step

    result = await agent.run("go", on_step=on_step)

    n = len(result.messages)
    assert n == 23
    # Incremental: each message encoded exactly once over the run (O(N)), durations/is_error and
    # all (a kept prefix message's inlined values are final, so its cached block is never redone).
    assert writer.messages_encoded == n == 23
    # Baseline re-encodes the growing transcript every step (O(N^2)): 4+6+...+22+23 = 153.
    assert baseline_encodes == 153
    assert writer.messages_encoded < baseline_encodes
