"""Offline test: :func:`nanoagent.runtime.batch.run_batch` ISOLATES a failing task — one rollout that
raises does NOT sink its siblings (the contract a trainer's deferred batch relies on — a single
bad rollout must not lose a whole batch).

Everything is in-process — no model server, GPU, or network. A scripted
:class:`~nanoagent.core.agent.ChatModel` answers ``"DONE"`` in one turn, except for the one task whose
user turn (``messages[-1]["content"]``) is ``"boom?"``, on which it raises ``RuntimeError``. The
single test drives :func:`~nanoagent.runtime.batch.run_batch` over a 3-task batch at ``concurrency=3`` (the
MIDDLE task booms) under ``tmp_path`` and asserts the failed task is recorded as an ``error`` row
while BOTH siblings still complete with ``answer`` — the isolation ``run_one``'s ``try/except``
gives ``asyncio.gather``.

This arm is unhit by the other nanoagent batch tests: every test where the model RAISES drives a
SINGLE-task list (``test_run_batch_resume.py``, ``test_batch.py`` timeout cases) and every
MULTI-task batch test uses a model that always succeeds (``test_batch.py``,
``test_run_batch_concurrency.py``) — none combines a raising task with succeeding siblings.
A benchmark runner's equivalent is pinned on its own side, but
nanoagent's distinct ``run_batch`` fan-out was not.

Non-vacuity (verified by in-place mutation of batch.py, then reverted): make ``run_one``'s
``except Exception`` re-``raise`` so ``asyncio.gather`` propagates — ``run_batch`` raises and the
whole batch is sunk — and this test goes RED.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_run_batch_error_isolation.py -q
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from nanoagent.runtime import batch, trajectory
from nanoagent.core.agent import Agent, Reply


class _OneBoomsModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel`: raise on the ``boom?`` task, else answer.

    The task whose user turn (``messages[-1]["content"]``) is ``"boom?"`` raises ``RuntimeError``
    on the model turn; every other task answers ``"DONE"`` in a single turn (no tool call → that
    reply is the final answer). No model server is contacted.
    """

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        if messages[-1]["content"] == "boom?":
            raise RuntimeError("model boom")
        return Reply(content="DONE", usage={"prompt_tokens": 1, "total_tokens": 1})


def _traj(out: Path, task_id: str) -> Path:
    return out / trajectory.TRAJECTORIES_DIRNAME / f"{task_id}{trajectory.TRAJECTORY_SUFFIX}"


async def test_run_batch_isolates_failing_task(tmp_path: Path) -> None:
    # 3-task batch run concurrently; the MIDDLE task's model raises. The two siblings must still
    # complete, and the failed one is recorded as an error row (run_one's try/except feeds
    # asyncio.gather) — one bad rollout doesn't sink the batch.
    tasks = [("ok1", "capital of france?"), ("bad", "boom?"), ("ok2", "2+2?")]
    agent = Agent(_OneBoomsModel(), [], system_prompt="answer briefly", max_steps=5)

    rows = await batch.run_batch(tasks, agent=agent, output_dir=tmp_path, concurrency=3, model_name="mock")

    # Exactly one row per input task — the failure dropped none of them.
    assert len(rows) == 3
    by_id = {r["task_id"]: r for r in rows}
    assert set(by_id) == {"ok1", "bad", "ok2"}

    # The failed task is isolated as an error row carrying the exception label.
    assert by_id["bad"]["stop_reason"] == "error"
    assert by_id["bad"]["error"] == "RuntimeError: model boom"

    # The isolation claim: BOTH siblings completed despite the sibling's failure.
    assert by_id["ok1"]["stop_reason"] == "answer"
    assert by_id["ok2"]["stop_reason"] == "answer"
    assert by_id["ok1"]["answer"] == "DONE"
    assert by_id["ok2"]["answer"] == "DONE"

    # All 3 rows persisted to the ledger, and every task (including the failed one) wrote a
    # trajectory file — agent.run emits the terminal ERROR step before re-raising.
    ledger = [json.loads(ln) for ln in (tmp_path / "results.jsonl").read_text().splitlines() if ln.strip()]
    assert {r["task_id"] for r in ledger} == {"ok1", "bad", "ok2"}
    assert all(_traj(tmp_path, tid).exists() for tid in ("ok1", "bad", "ok2"))
