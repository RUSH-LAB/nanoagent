"""Offline tests for the batch driver's per-rollout wall-clock cap (:func:`nanoagent.runtime.batch.run_batch`).

Everything is in-process — no model server is contacted. A scripted
:class:`~nanoagent.core.agent.ChatModel` either blocks on ``asyncio.sleep`` (to overrun the cap) or
answers immediately (the fast, no-cap path); each test drives :func:`~nanoagent.runtime.batch.run_batch`
over one task and asserts on the returned row plus the ``results.jsonl`` ledger under ``tmp_path``.

* ``test_batch_timeout_scores_zero`` — a slow rollout under ``timeout=0.05`` is killed and recorded
  as a score-zero ``error`` row (0 tokens, 0 cost); the ledger holds exactly that one row.
* ``test_batch_no_timeout_completes`` — the same harness with ``timeout=None`` answers normally,
  proving the wrapper is inert when no cap is set.
* ``test_batch_on_step_reports_per_task`` — the ``on_step`` callback fires with ``(task_id,
  result)`` for every task, each ending in its terminal (non-``running``) stop_reason, so a
  caller (the CLI's live per-task rows) can follow progress; an unwired ``on_step`` records nothing.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_batch.py -x -q
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from nanoagent.runtime import batch
from nanoagent.core.agent import Agent, Reply


class _ScriptedModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel`: optionally block, then answer in one turn.

    ``sleep`` > 0 makes the single model turn block on ``asyncio.sleep`` so a test can trip
    ``run_batch``'s wall-clock cap (the cap fires before this returns); ``sleep`` = 0 answers
    ``"DONE"`` immediately (the fast, no-cap path). No model server is contacted.
    """

    def __init__(self, *, sleep: float = 0.0) -> None:
        self._sleep = sleep

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        if self._sleep:
            await asyncio.sleep(self._sleep)
        return Reply(content="DONE", usage={"prompt_tokens": 1, "total_tokens": 1})


def _agent(*, sleep: float = 0.0) -> Agent:
    # No tools / no context_window — like the batch path's build_agent, but the model returns no
    # tool call so the very first turn is the final answer.
    return Agent(_ScriptedModel(sleep=sleep), [], system_prompt="SYS", max_steps=5)


async def test_batch_timeout_scores_zero(tmp_path: Path) -> None:
    # A rollout that would take 5s, capped at 0.05s: asyncio.wait_for kills it and the existing
    # error path records a score-zero row (the 5s sleep is cancelled, never actually awaited).
    rows = await batch.run_batch(
        [("t1", "go")], agent=_agent(sleep=5), output_dir=tmp_path, timeout=0.05
    )
    assert len(rows) == 1
    assert rows[0]["stop_reason"] == "error"
    assert rows[0]["total_tokens"] == 0
    assert rows[0]["cost"] == 0.0

    # The ledger holds exactly that one row, and it matches the returned row.
    ledger = (tmp_path / "results.jsonl").read_text().splitlines()
    assert len(ledger) == 1
    saved = json.loads(ledger[0])
    assert saved["task_id"] == "t1"
    assert saved["stop_reason"] == "error"
    assert saved["total_tokens"] == 0
    assert saved["cost"] == 0.0


async def test_batch_no_timeout_completes(tmp_path: Path) -> None:
    # Same harness, fast model, no cap: the wait_for wrapper is skipped and the rollout answers.
    rows = await batch.run_batch(
        [("t1", "go")], agent=_agent(), output_dir=tmp_path, timeout=None
    )
    assert len(rows) == 1
    assert rows[0]["stop_reason"] == "answer"


async def test_batch_on_step_reports_per_task(tmp_path: Path) -> None:
    # on_step must fire with (task_id, live result) so the CLI can render per-task progress;
    # the terminal call for each task carries its real stop_reason (not "running").
    seen: list[tuple[str, str]] = []
    rows = await batch.run_batch(
        [("t1", "go"), ("t2", "go")],
        agent=_agent(),
        output_dir=tmp_path,
        on_step=lambda tid, r: seen.append((tid, str(r.stop_reason))),
    )
    assert len(rows) == 2
    # Both tasks surfaced through on_step (empty if the callback were left unwired)...
    assert {tid for tid, _ in seen} == {"t1", "t2"}
    # ...each ending in its terminal answer (the snapshot the live row reads to mark it done).
    assert {tid for tid, reason in seen if reason == "answer"} == {"t1", "t2"}
