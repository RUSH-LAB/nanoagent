"""Offline tests for :func:`nanoagent.runtime.batch.run_batch`'s resume ledger, ``redo``, error
labelling, and progress callbacks — the caps/timeouts + resume arms the rollout layer needs.

Everything is in-process — no model server, GPU, or network. A scripted
:class:`~nanoagent.core.agent.ChatModel` answers in one turn, blocks on ``asyncio.sleep`` (to
overrun a wall-clock cap), or raises; each test drives :func:`~nanoagent.runtime.batch.run_batch`
over tasks under ``tmp_path`` and asserts on the returned rows, the ``results.jsonl``
ledger, the per-task trajectory files, and the callback invocations. These arms are
unhit by ``test_batch.py`` (one task, ``redo`` never set, callbacks ``None``, the error
string never asserted).

* ``test_resume_skips_completed_and_preserves_ledger`` — a pre-seeded ``t1`` is skipped
  (``redo=False``): only ``t2`` is returned/ran, no ``t1`` trajectory is written, the
  pre-seeded ledger row is preserved and ``t2`` appended, and ``on_start`` sees the
  *pending* count (1, not the total 2).
* ``test_redo_reruns_completed`` — ``redo=True`` drops the stale ledger and re-runs the
  pre-seeded ``t1`` (both tasks returned, a ``t1`` trajectory now exists, the ledger is
  rewritten clean — one fresh row per task, the old seed gone, not appended-to).
* ``test_callbacks_fire_once_and_per_task`` — ``on_start`` once with the pending count,
  ``on_done`` once per finished task.
* ``test_timeout_error_label`` — a rollout killed by ``timeout`` carries
  ``error == "timeout: exceeded {timeout}s"``.
* ``test_non_timeout_error_label_with_cap_set`` — a non-``TimeoutError`` exception, even
  with a ``timeout`` cap set, carries the generic ``"{ExcType}: {msg}"`` label (not the
  timeout one), exercising the ``isinstance`` half of the conditional.
* ``test_unrelated_timeout_error_not_mislabeled_without_cap`` — a ``TimeoutError`` raised
  by the rollout itself with NO cap set (``timeout=None``) gets the generic
  ``"{ExcType}: {msg}"`` label, not ``"timeout: exceeded None s"``, exercising the
  ``timeout is not None`` half of the conditional.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_run_batch_resume.py -q
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from nanoagent.runtime import batch, trajectory
from nanoagent.core.agent import Agent, Reply


class _ScriptedModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel`: answer in one turn, block, or raise.

    ``raises`` (if set) is raised on the model turn; otherwise ``sleep`` > 0 blocks on
    ``asyncio.sleep`` (long enough to trip a wall-clock cap) before the model answers
    ``"DONE"`` in a single turn (no tool call → that reply is the final answer). No model
    server is contacted.
    """

    def __init__(self, *, sleep: float = 0.0, raises: Exception | None = None) -> None:
        self._sleep = sleep
        self._raises = raises

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        if self._raises is not None:
            raise self._raises
        if self._sleep:
            await asyncio.sleep(self._sleep)
        return Reply(content="DONE", usage={"prompt_tokens": 1, "total_tokens": 1})


def _agent(*, sleep: float = 0.0, raises: Exception | None = None) -> Agent:
    # Like the batch path's build_agent but tool-less: the model returns no tool call, so
    # the very first turn is the final answer.
    model = _ScriptedModel(sleep=sleep, raises=raises)
    return Agent(model, [], system_prompt="SYS", max_steps=5)


def _seed_ledger(out: Path, *, task_id: str, answer: str) -> None:
    """Pre-seed a ``results.jsonl`` resume ledger with one finished row (as ``_result_row`` writes it)."""
    row = {
        "task_id": task_id,
        "model": "m",
        "answer": answer,
        "stop_reason": "answer",
        "steps": 1,
        "n_tool_calls": 0,
        "total_tokens": 5,
        "cost": 0.0,
        "error": None,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.jsonl").write_text(json.dumps(row) + "\n")


def _ledger_task_ids(out: Path) -> list[str]:
    lines = (out / "results.jsonl").read_text().splitlines()
    return [json.loads(line)["task_id"] for line in lines]


def _traj(out: Path, task_id: str) -> Path:
    return out / trajectory.TRAJECTORIES_DIRNAME / f"{task_id}{trajectory.TRAJECTORY_SUFFIX}"


async def test_resume_skips_completed_and_preserves_ledger(tmp_path: Path) -> None:
    # t1 is already in the ledger; redo=False must skip it and run only t2.
    _seed_ledger(tmp_path, task_id="t1", answer="OLD")
    starts: list[int] = []
    rows = await batch.run_batch(
        [("t1", "a"), ("t2", "b")],
        agent=_agent(),
        output_dir=tmp_path,
        redo=False,
        model_name="m",
        on_start=starts.append,
    )

    # Only the pending task is run and returned.
    assert [r["task_id"] for r in rows] == ["t2"]
    assert rows[0]["stop_reason"] == "answer"
    # on_start sees the PENDING count (1), not the total task count (2).
    assert starts == [1]
    # The skipped task's rollout never ran → no new trajectory; the pending one did.
    assert not _traj(tmp_path, "t1").exists()
    assert _traj(tmp_path, "t2").exists()
    # The ledger keeps the original t1 row verbatim and appends t2 (append, not rewrite).
    lines = (tmp_path / "results.jsonl").read_text().splitlines()
    assert [json.loads(line)["task_id"] for line in lines] == ["t1", "t2"]
    assert json.loads(lines[0])["answer"] == "OLD"


async def test_redo_reruns_completed(tmp_path: Path) -> None:
    # Same pre-seeded ledger, but redo=True ignores it and re-runs every task.
    _seed_ledger(tmp_path, task_id="t1", answer="OLD")
    rows = await batch.run_batch(
        [("t1", "a"), ("t2", "b")],
        agent=_agent(),
        output_dir=tmp_path,
        redo=True,
        model_name="m",
    )

    # Both tasks ran (gather preserves the pending order); t1 was re-run.
    assert [r["task_id"] for r in rows] == ["t1", "t2"]
    assert _traj(tmp_path, "t1").exists()
    # redo drops the stale ledger first, then rewrites it clean — exactly one fresh row per
    # task, no leftover seed duplicate (so repeated redo runs don't pile up rows).
    assert sorted(_ledger_task_ids(tmp_path)) == ["t1", "t2"]
    # The t1 row is the fresh rerun ("DONE"), not the dropped seed ("OLD").
    t1_row = next(json.loads(line) for line in (tmp_path / "results.jsonl").read_text().splitlines() if json.loads(line)["task_id"] == "t1")
    assert t1_row["answer"] == "DONE"


async def test_callbacks_fire_once_and_per_task(tmp_path: Path) -> None:
    # Fresh dir: both tasks pending. on_start once with the count; on_done once per task.
    starts: list[int] = []
    dones: list[dict[str, Any]] = []
    rows = await batch.run_batch(
        [("t1", "a"), ("t2", "b")],
        agent=_agent(),
        output_dir=tmp_path,
        on_start=starts.append,
        on_done=dones.append,
    )

    assert starts == [2]
    assert len(dones) == 2
    # Each finished row was handed to on_done exactly once.
    assert {r["task_id"] for r in dones} == {"t1", "t2"}
    assert {r["task_id"] for r in dones} == {r["task_id"] for r in rows}


async def test_timeout_error_label(tmp_path: Path) -> None:
    # A 5s rollout capped at 0.05s: asyncio.wait_for raises asyncio.TimeoutError, labelled explicitly.
    rows = await batch.run_batch(
        [("t1", "go")], agent=_agent(sleep=5), output_dir=tmp_path, timeout=0.05
    )
    assert rows[0]["stop_reason"] == "error"
    assert rows[0]["error"] == "timeout: exceeded 0.05s"


async def test_non_timeout_error_label_with_cap_set(tmp_path: Path) -> None:
    # The model raises a non-TimeoutError. Even with a timeout cap set, the generic
    # "{ExcType}: {msg}" label is used — this kills the isinstance half of the conditional.
    rows = await batch.run_batch(
        [("t1", "go")],
        agent=_agent(raises=RuntimeError("boom")),
        output_dir=tmp_path,
        timeout=30,
    )
    assert rows[0]["stop_reason"] == "error"
    assert rows[0]["error"] == "RuntimeError: boom"


async def test_unrelated_timeout_error_not_mislabeled_without_cap(tmp_path: Path) -> None:
    # A TimeoutError raised by the rollout itself, with NO cap set (timeout=None), must get
    # the generic label — not "timeout: exceeded None s". This kills the `timeout is not None`
    # half of the conditional (the guard that stops an unrelated TimeoutError being mislabeled).
    rows = await batch.run_batch(
        [("t1", "go")],
        agent=_agent(raises=asyncio.TimeoutError("stalled")),
        output_dir=tmp_path,
        timeout=None,
    )
    assert rows[0]["stop_reason"] == "error"
    assert rows[0]["error"] == "TimeoutError: stalled"
