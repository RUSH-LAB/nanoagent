"""The batch driver — pick the tasks, fan them out over one agent, write the ledger.

Everything the ``run`` subcommand's batch mode does apart from rendering it:

  * :func:`load_tasks` / :func:`filter_tasks` — read a tasks JSONL and narrow it (regex on id,
    ``a:b`` slice, seeded shuffle).
  * :func:`completed_ids` — the ``results.jsonl`` resume ledger, read back as a task_id set.
  * :func:`run_batch` — run every pending task concurrently over ONE shared
    :class:`~nanoagent.core.agent.Agent`, saving a trajectory per task and appending a slim
    ledger row as each finishes.

Progress rendering is :mod:`nanoagent.cli.progress`, reached only through ``run_batch``'s
``on_start`` / ``on_step`` / ``on_done`` callbacks — this module prints nothing.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from nanoagent.core.agent import Agent, AgentResult, StopReason
from nanoagent.runtime import log_capture
from nanoagent.runtime import trajectory
from nanoagent.runtime.taskselect import select_subset

logger: logging.Logger = logging.getLogger(__name__)


def load_tasks(path: str | Path) -> list[tuple[str, str]]:
    """Read tasks from a JSONL file (blank lines skipped).

    Each row needs an id and a prompt. The canonical keys are ``task_id`` / ``task``;
    BrowseComp-style ``query_id`` / ``problem`` are accepted as fallbacks so gold files
    (e.g. ``browsecomp_answerable_232_gold.jsonl``) can be fed without a conversion step.
    """
    tasks: list[tuple[str, str]] = []
    with Path(path).open(encoding="utf-8") as f:
        for index, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(
                    f"{path} line {index}: task row is not valid JSON: {e}"
                ) from e
            if not isinstance(row, dict):
                raise ValueError(
                    f"{path}: each row must be a JSON object, got {type(row).__name__}"
                )
            task_id = row.get("task_id", row.get("query_id"))
            task = row.get("task", row.get("problem"))
            if task_id is None or task is None:
                raise ValueError(
                    f"{path}: each row needs task_id/task (or query_id/problem); got keys {sorted(row)}"
                )
            tasks.append((str(task_id), str(task)))
    return tasks


def filter_tasks(
    tasks: list[tuple[str, str]],
    *,
    filter_re: str = "",
    slice_spec: str = "",
    shuffle: bool = False,
) -> list[tuple[str, str]]:
    """Select a subset of tasks: seeded shuffle, then regex on ``task_id``, then ``a:b`` slice."""
    return select_subset(
        tasks,
        key=lambda t: t[0],
        filter_re=filter_re,
        slice_spec=slice_spec,
        shuffle=shuffle,
    )


def completed_ids(results_path: Path) -> set[str]:
    """task_ids already recorded in an existing ``results.jsonl`` (empty if it doesn't exist)."""
    if not results_path.exists():
        return set()
    done: set[str] = set()
    with results_path.open(encoding="utf-8") as f:
        for index, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(
                    f"{results_path} line {index}: result row is not valid JSON: {e}"
                ) from e
            if not isinstance(row, dict):
                raise ValueError(
                    f"{results_path} line {index}: result row is not a JSON object "
                    f"(got {type(row).__name__})"
                )
            try:
                done.add(str(row["task_id"]))
            except KeyError:
                raise ValueError(
                    f'{results_path} line {index}: result row has no "task_id"; keys={sorted(row)}'
                ) from None
    return done


def _result_row(
    task_id: str,
    model_name: str | None,
    *,
    result: AgentResult | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    """One slim ledger row. The defaults describe a failure; a ``result`` fills in the rest.

    Both ``result`` and ``error`` may be supplied together: that is the partial-trajectory
    error path (``run_one``'s exception handler passes the last per-step snapshot AS the
    result so the row inherits real ``steps`` / ``total_tokens`` / wall-clock instead of
    the all-zero defaults). When both are set the row's numeric fields come from
    ``result``; ``stop_reason`` becomes ``ERROR`` and the ``error`` text is preserved.
    """
    row: dict[str, Any] = {
        "task_id": task_id,
        "model": model_name,
        "answer": "",
        "stop_reason": StopReason.ERROR,
        "steps": 0,
        "n_tool_calls": 0,
        "total_tokens": 0,
        "cost": 0.0,
        "model_time": 0.0,
        "tools_time": 0.0,
        "error": error,
    }
    if result is not None:
        row.update(
            answer=result.answer,
            # An explicit error wins — the snapshot's stop_reason is the LATEST per-step
            # status (often "running"), which would mis-classify a failed task as in-progress.
            stop_reason=StopReason.ERROR if error else result.stop_reason,
            steps=result.steps,
            n_tool_calls=len(result.tool_calls),
            total_tokens=result.usage.get("total_tokens", 0),
            cost=result.cost,
            # Wall-clock split: LLM (model query) vs tool dispatch (here: the search calls),
            # summed over the run's steps from result.step_durations.
            model_time=sum(d["model"] for d in result.step_durations),
            tools_time=sum(d["tools"] for d in result.step_durations),
            error=error,  # preserves the caller's text; None on the success path
        )
    return row


async def run_batch(
    tasks: list[tuple[str, str]],
    *,
    agent: Agent,
    output_dir: str | Path,
    concurrency: int = 8,
    model_name: str | None = None,
    redo: bool = False,
    timeout: float | None = None,
    on_start: Callable[[int], None] | None = None,
    on_step: Callable[[str, AgentResult], None] | None = None,
    on_done: Callable[[dict[str, Any]], None] | None = None,
) -> list[dict[str, Any]]:
    """Run ``agent`` over ``tasks`` concurrently, saving trajectories + a results ledger.

    Returns one result row per *pending* task (already-completed task_ids are skipped
    unless ``redo``). ``timeout`` (seconds), when set, caps each rollout's wall-clock: a task
    that overruns is cancelled and recorded as a score-zero ``error`` row; ``None`` (the
    default) imposes no cap. ``on_start`` (if given) is called
    once with the number of pending tasks before any run; ``on_step`` (if given) is called
    after every agent step with ``(task_id, result)`` — the live snapshot whose
    ``result.stop_reason`` is ``RUNNING`` until the terminal step — so a caller can render
    per-task progress; ``on_done`` (if given) is called with each row as it completes. ONE
    :class:`Agent` instance is shared across every concurrent rollout — ``Agent.run`` keeps no
    per-call state, which is what makes that safe.

    Each task's ``trajectories/<task_id>.traj.json`` (under ``output_dir``) is rewritten after
    every agent step (not just at the end), so a mid-run crash isn't lost and progress is
    tail-able / browse-able live; the slim ``results.jsonl`` ledger row, written at the top
    of ``output_dir``, is appended once when the task finishes.
    """
    out = Path(output_dir)
    traj_dir = out / trajectory.TRAJECTORIES_DIRNAME
    traj_dir.mkdir(parents=True, exist_ok=True)
    results_path = out / "results.jsonl"
    if redo:
        # redo = rerun every task, so the existing ledger rows are stale: drop it and rewrite a
        # clean one-row-per-task ledger (otherwise repeated redo runs append duplicate rows,
        # which double-counts task_ids for downstream readers like a scoring report).
        results_path.unlink(missing_ok=True)
    done = set() if redo else completed_ids(results_path)
    # Dedup within the input batch too, not just against the ledger: if the same task_id appears
    # twice in `tasks`, keep only its FIRST occurrence. Otherwise both copies are pending (neither
    # is in `done`) and run concurrently under the gather below — racing to write the same
    # <task_id>.traj.json and each appending a ledger row, leaving two rows for one task_id (the
    # double-count the redo-branch ledger-drop above guards against). Seeding `seen` from `done`
    # keeps resume-vs-ledger behavior unchanged; first-occurrence order is preserved, so a
    # duplicate-free input yields the same `pending` as the old comprehension.
    seen = set(done)
    pending: list[tuple[str, str]] = []
    for tid, task in tasks:
        if tid in seen:
            continue
        pending.append((tid, task))
        seen.add(tid)
    logger.info(
        "batch: %d task(s), %d already done, %d pending",
        len(tasks),
        len(tasks) - len(pending),  # selected tasks actually skipped, not the whole ledger
        len(pending),
    )
    if on_start is not None:
        on_start(len(pending))

    semaphore = asyncio.Semaphore(concurrency)
    write_lock = asyncio.Lock()

    async def run_one(task_id: str, task: str) -> dict[str, Any]:
        traj_path = traj_dir / f"{task_id}{trajectory.TRAJECTORY_SUFFIX}"
        meta = {"task_id": task_id, "task": task, "model": model_name}
        # Each task runs in its own asyncio context, so this buffer (and the WARNING+
        # records the collector appends to it) stays isolated to this task.
        logs = log_capture.start_capture()

        # Save after every step (not just at the end): the trajectory file always
        # reflects the latest turn, so a mid-run crash isn't lost and progress is
        # tail-able / browse-able live. The terminal ANSWER/MAX_STEPS/ERROR step
        # fires on_step too, so the last write is the complete trajectory. One
        # incremental writer per task encodes each message once (O(N)) instead of
        # re-serializing the whole growing transcript every step (O(N^2)), writing
        # the same bytes trajectory.save would.
        writer = trajectory.IncrementalTrajectoryWriter(traj_path)

        # The latest per-step snapshot — captured here so the error path below can build
        # the ledger row from the same partial data the trajectory file already carries
        # (steps, n_tool_calls, total_tokens, model_time, tools_time). Without this, an
        # error after N successful steps wrote `"steps": 0, "total_tokens": 0` into
        # results.jsonl even though the *.traj.json showed real work.
        last_snapshot: AgentResult | None = None

        def save_step(r: AgentResult) -> None:
            nonlocal last_snapshot
            last_snapshot = r
            writer.save(r, meta=meta, logs=logs)
            if on_step is not None:
                on_step(task_id, r)

        async with semaphore:
            try:
                # When a wall-clock cap is set, kill the rollout if it overruns; asyncio.wait_for
                # raises asyncio.TimeoutError (an Exception) into the handler below. timeout=None
                # skips the wrapper, leaving this the same single `await agent.run(...)` as before.
                if timeout is not None:
                    result = await asyncio.wait_for(
                        agent.run(task, on_step=save_step, label=task_id), timeout
                    )
                else:
                    result = await agent.run(task, on_step=save_step, label=task_id)
                row = _result_row(task_id, model_name, result=result)
            except Exception as e:
                logger.exception("task %s failed", task_id)
                # A wall-clock overrun surfaces as asyncio.TimeoutError — record it explicitly
                # (only when a cap was set, so an unrelated TimeoutError isn't mislabeled).
                error = (
                    f"timeout: exceeded {timeout}s"
                    if timeout is not None and isinstance(e, asyncio.TimeoutError)
                    else f"{type(e).__name__}: {e}"
                )
                # Build the row from the LAST snapshot the agent emitted via on_step (which
                # carries the partial usage / steps / tool_calls / step_durations the run
                # accumulated before the exception), then overlay the error + the terminal
                # ERROR stop_reason. If the very first step never completed there is no
                # snapshot — fall back to the all-defaults shape.
                row = _result_row(task_id, model_name, result=last_snapshot, error=error)
                # The logger.exception line above lands in `logs`; fold it into the last-saved
                # traj AND reconcile its terminal stop_reason/error to match this row. A timeout
                # kills the rollout via asyncio.CancelledError (a BaseException), which bypasses
                # agent.run's `except Exception`, so its ERROR step never saved — the traj would
                # otherwise stay at stop_reason="running". No further save_step runs once
                # agent.run has raised.
                trajectory.update_logs(
                    traj_path,
                    logs,
                    stop_reason=str(row["stop_reason"]),
                    error=row["error"],
                )
            async with write_lock:
                with results_path.open("a") as f:
                    f.write(json.dumps(row) + "\n")
            if on_done is not None:
                on_done(row)
            return row

    return list(await asyncio.gather(*(run_one(tid, task) for tid, task in pending)))
