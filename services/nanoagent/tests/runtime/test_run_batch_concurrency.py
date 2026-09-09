"""Offline test for the batch driver's concurrency bound (:func:`nanoagent.runtime.batch.run_batch`).

``run_batch`` gates every rollout behind ``asyncio.Semaphore(concurrency)`` (``batch.py``,
acquired by ``async with semaphore`` at ``batch.py``) — the role map's BLOCK-3
"oversubscribe / keep more rollouts in flight than slots" throttle for the rollout-service
fan-out: no more than ``concurrency`` rollouts may be in flight at once. Everything here is
in-process — no model server, GPU, or network is contacted.

* ``test_run_batch_concurrency_caps_in_flight`` — drive ``run_batch`` over 6 tasks with
  ``concurrency=2`` using a scripted :class:`~nanoagent.core.agent.ChatModel` (the
  ``test_batch._ScriptedModel`` shape) whose single turn bumps a shared in-flight counter,
  records the running peak, sleeps briefly so co-admitted rollouts actually overlap inside
  the semaphore, then decrements and answers in one turn. Asserts the observed peak == 2 (it
  REACHES the cap — so the test isn't vacuous — and never EXCEEDS it) and that all 6 tasks
  complete (6 result rows, 6 ledger lines, 6 trajectory files).

Non-vacuity (mutation proof): replacing ``asyncio.Semaphore(concurrency)`` with
``asyncio.Semaphore(len(pending))`` (or any bound > ``concurrency``) at ``batch.py`` keeps
the rest of the suite green but makes this test's peak == 6, flipping it red. The
``concurrency`` parameter and the ``async with semaphore`` gate otherwise have zero
behavioral coverage.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_run_batch_concurrency.py -q
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from nanoagent.runtime import batch, trajectory
from nanoagent.core.agent import Agent, Reply


class _ConcurrencyProbeModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` that measures rollout overlap.

    Mirrors ``test_batch._ScriptedModel`` (one turn, no tool call, so the agent's first turn is
    the final answer), but instruments concurrency: each turn increments a shared in-flight
    counter, records the running ``peak``, sleeps so every rollout admitted alongside it enters
    its turn before any leaves, then decrements and answers ``"DONE"``. ``run_batch`` shares one
    agent/model across all tasks, so this single instance's ``peak`` is the high-water mark of
    simultaneously in-flight rollouts. The increment/decrement straddle the only ``await``, so
    they never interleave on the single-threaded event loop.
    """

    def __init__(self) -> None:
        self.in_flight = 0
        self.peak = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        try:
            # Sleep (not sleep(0)) so co-admitted rollouts all enter their turn before this one
            # leaves: the peak then reflects the semaphore's true ceiling, not scheduling luck.
            await asyncio.sleep(0.05)
        finally:
            self.in_flight -= 1
        return Reply(content="DONE", usage={"prompt_tokens": 1, "total_tokens": 1})


async def test_run_batch_concurrency_caps_in_flight(tmp_path: Path) -> None:
    # One shared agent/model over 6 tasks, admitted two at a time by concurrency=2.
    model = _ConcurrencyProbeModel()
    agent = Agent(model, [], system_prompt="SYS", max_steps=5)
    tasks = [(f"t{i}", "go") for i in range(6)]

    rows = await batch.run_batch(tasks, agent=agent, output_dir=tmp_path, concurrency=2)

    # Reaches the cap (not vacuous) and never exceeds it; the counter unwinds to 0.
    assert model.peak == 2
    assert model.in_flight == 0

    # All 6 rollouts completed: returned rows, ledger lines, and per-task trajectory files.
    assert len(rows) == 6
    assert all(r["stop_reason"] == "answer" for r in rows)
    ledger = (tmp_path / "results.jsonl").read_text().splitlines()
    assert len(ledger) == 6
    trajs = list((tmp_path / trajectory.TRAJECTORIES_DIRNAME).glob(f"*{trajectory.TRAJECTORY_SUFFIX}"))
    assert len(trajs) == 6
