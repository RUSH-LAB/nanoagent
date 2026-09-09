"""Offline test: the batch driver stamps each saved trajectory's meta with its task attribution.

nanoagent is the ROLLOUT layer that fans tasks out and captures the agent's LLM calls as the
trajectory. When :func:`nanoagent.runtime.batch.run_batch` fans a
batch out it writes one ``<task_id>.traj.json`` per task and stamps that file's ``meta`` with the
per-task attribution — ``run_one`` builds ``meta = {"task_id": task_id, "task": task, "model":
model_name}`` (``batch.py``) and threads it into the incremental trajectory writer
(``writer.save(r, meta=meta, ...)``). The downstream consumers (a scorer, a trainer)
read that ``meta`` to attribute a trajectory file back to its task and to the
model/policy that produced it, so the stamp is the seam that makes a fanned-out rollout
traceable.

No existing test pins this batch-path ``meta``: ``test_batch.py`` /
``test_run_batch_concurrency.py`` / ``test_run_batch_resume.py`` only assert the ledger or that
the trajectory files exist (never load and check their ``meta``);
``test_run_batch_timeout_traj_stop_reason.py`` loads a traj but asserts only the cancelled-path
``stop_reason``/``error``/transcript; ``test_run_and_save.py`` asserts a ``meta`` but for the
SINGLE (``run_and_save``) path, whose shape is ``{task, model}`` — it has NO ``task_id``. So the
batch-path attribution stamp (with ``task_id``) is unpinned.

Everything is in-process — no model server, GPU, native ext, or network. A scripted
:class:`~nanoagent.core.agent.ChatModel` answers ``"DONE"`` in one turn (no tool call → that reply is
the final answer) and a tool-less :class:`~nanoagent.core.agent.Agent` drives it, exactly the
``test_batch._ScriptedModel`` shape.

* ``test_run_batch_stamps_per_task_traj_meta`` — drive ``run_batch`` over 3 distinct tasks at
  ``concurrency=3`` (so the rollouts overlap), then :func:`~nanoagent.runtime.trajectory.load` each
  ``<task_id>.traj.json`` FROM DISK and assert its ``meta`` EQUALS the exact
  ``{"task_id", "task", "model"}`` dict the source builds for that task — the right task_id/task
  landing in the right file (so overlapping rollouts can't cross-contaminate each other's meta) —
  with ``stop_reason == "answer"`` (the clean arm, not the error/timeout arm).

Non-vacuity (mutation proof): dropping ``task_id`` from ``run_one``'s ``meta`` in ``batch.py``
(``meta = {"task": task, "model": model_name}``) keeps the entire existing suite green but flips
the ``meta ==`` equality here red. The batch-path meta stamp otherwise has zero coverage.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_run_batch_traj_meta_stamped.py -q
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from nanoagent.runtime import batch, trajectory
from nanoagent.core.agent import Agent, Reply, StopReason


class _ScriptedModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel`: answer ``"DONE"`` in one turn.

    No tool call → the agent's first turn is its final answer (``StopReason.ANSWER``), so the
    terminal per-step save writes each trajectory with ``run_batch``'s per-task ``meta``. Mirrors
    the ``test_batch._ScriptedModel`` shape (``query(messages, tools, *, on_delta=...)``); no
    model server is contacted.
    """

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        return Reply(content="DONE", usage={"prompt_tokens": 1, "total_tokens": 1})


async def test_run_batch_stamps_per_task_traj_meta(tmp_path: Path) -> None:
    # One shared tool-less agent over 3 distinct tasks, all admitted at once by concurrency=3 so
    # the rollouts genuinely overlap — any cross-task meta contamination would surface as a wrong
    # task_id/task in some file.
    model_name = "fake-model"
    agent = Agent(_ScriptedModel(), [], system_prompt="SYS", max_steps=5)
    tasks = [("t0", "alpha task"), ("t1", "beta task"), ("t2", "gamma task")]

    rows = await batch.run_batch(
        tasks,
        agent=agent,
        output_dir=tmp_path,
        concurrency=3,
        model_name=model_name,
    )

    # Every rollout answered cleanly (the clean arm — not the error/timeout arm).
    assert len(rows) == 3
    assert all(r["stop_reason"] == StopReason.ANSWER for r in rows)

    # Each <task_id>.traj.json on disk carries EXACTLY the per-task attribution the source builds:
    # {"task_id", "task", "model"}, with the right task/task_id in the right file (no contamination
    # across the overlapping rollouts).
    for task_id, task in tasks:
        data = trajectory.load(tmp_path / trajectory.TRAJECTORIES_DIRNAME / f"{task_id}{trajectory.TRAJECTORY_SUFFIX}")
        assert data["meta"] == {"task_id": task_id, "task": task, "model": model_name}
        # And it really is the clean-answer trajectory, not a partial/error one.
        assert data["stop_reason"] == StopReason.ANSWER
