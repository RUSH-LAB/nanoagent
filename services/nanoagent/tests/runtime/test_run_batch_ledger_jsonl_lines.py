"""Offline regression: ``run_batch``'s ``results.jsonl`` ledger stays one physical line per
task — even when an answer carries embedded newlines (real agent answers are multi-line prose).

nanoagent is the ROLLOUT layer that fans tasks out and records each finished rollout.
:func:`nanoagent.runtime.batch.run_batch` appends one slim ledger row per task to
``<output>/results.jsonl`` with ``f.write(json.dumps(row) + "\n")`` (``batch.py``). That
on-disk file is a JSONL contract: exactly one physical line per task, each independently
``json.loads``-able. Two downstream readers depend on it line-by-line — the resume reader
:func:`nanoagent.runtime.batch.completed_ids` (splits on newlines, ``json.loads`` per line, collects the
finished ``task_id`` set so a re-run skips them) and a downstream ``results.jsonl`` report. A real
model answer is multi-line prose, so the row's ``answer`` carries embedded ``\n``; ``json.dumps``
MUST escape those into the JSON string so the physical line stays whole.

No existing test observes a MULTI-LINE row on disk: every run_batch/ledger test
(``test_batch.py``, ``test_run_batch_resume.py``, ``test_run_batch_concurrency.py``,
``test_run_batch_traj_meta_stamped.py``) feeds a single-line ``"DONE"`` answer, so their
``splitlines()``-count assertions can never observe a row that fragments across physical lines;
``test_cli_result_row.py`` round-trips ``_result_row`` / ``json.dumps`` on the row dict in
isolation, never the on-disk write under multi-line content.

Everything is in-process — no model server, GPU, native ext, or network. A scripted
:class:`~nanoagent.core.agent.ChatModel` returns a multi-line ``Reply.content`` in one turn (no tool
call → that reply is the final answer), and a tool-less :class:`~nanoagent.core.agent.Agent` drives it
over 3 distinct tasks via :func:`~nanoagent.runtime.batch.run_batch`, exactly the
``test_batch._ScriptedModel`` shape.

Non-vacuity (mutation proof): un-escaping the ledger write in ``batch.py``
(``json.dumps(row)`` -> ``json.dumps(row).replace("\\n", "\n")``) writes the embedded newlines
raw, fragmenting each multi-line row across many physical lines — the ``splitlines() == 3``
assertion flips red and ``completed_ids`` raises on the now-broken lines, while the existing suite
(single-line answers, no ``\n`` to un-escape) stays green. The GOAL's
``json.dumps(row, indent=2)`` pretty-print also turns the new test red (rows span many physical
lines), but it additionally trips the single-line ``splitlines()`` asserts in ``test_batch.py`` /
``test_run_batch_resume.py``, so the un-escape mutation is the one that pins this test's UNIQUE
multi-line coverage.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_run_batch_ledger_jsonl_lines.py -q
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from nanoagent.runtime.batch import completed_ids
from nanoagent.runtime import batch
from nanoagent.core.agent import Agent, Reply

# A real agent answer is multi-line prose: a blank line (consecutive ``\n``) plus single ``\n``
# breaks, so writing it un-escaped would shatter the row across several physical lines.
_ANSWER = "First paragraph of the answer.\n\nSecond paragraph with details.\nAnd a final concluding line."


class _ScriptedModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel`: answer multi-line prose in one turn.

    No tool call → the agent's first turn is its final answer (``StopReason.ANSWER``), so
    ``result.answer`` is ``_ANSWER`` verbatim (embedded newlines and all) and rides into the
    ledger row. Mirrors the ``test_batch._ScriptedModel`` shape; no model server is contacted.
    """

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        return Reply(content=_ANSWER, usage={"prompt_tokens": 1, "total_tokens": 1})


async def test_run_batch_ledger_one_physical_line_per_multiline_answer(
    tmp_path: Path,
) -> None:
    # Guard: the payload must be genuinely multi-line, else every assertion below is vacuous.
    assert "\n" in _ANSWER

    # One shared tool-less agent over 3 distinct tasks, overlapping at concurrency=3.
    agent = Agent(_ScriptedModel(), [], system_prompt="SYS", max_steps=5)
    tasks = [("t0", "alpha"), ("t1", "beta"), ("t2", "gamma")]

    rows = await batch.run_batch(
        tasks,
        agent=agent,
        output_dir=tmp_path,
        concurrency=3,
        model_name="fake-model",
    )

    # The multi-line answer really rode into every returned row (so the on-disk assertions below
    # exercise a genuinely multi-line payload, not an empty/clipped one).
    assert len(rows) == 3
    assert all(r["answer"] == _ANSWER for r in rows)

    results_path = tmp_path / "results.jsonl"
    lines = results_path.read_text().splitlines()

    # THE KILLER ASSERTION: exactly one physical line per task, despite the embedded newlines.
    # (Writing the row with raw newlines — or json.dumps(row, indent=2) — flips this red.)
    assert len(lines) == 3

    # Each physical line is independently json.loads-able, and together they carry exactly the
    # 3 task_ids, each with the multi-line answer preserved verbatim.
    parsed = [json.loads(line) for line in lines]
    assert {row["task_id"] for row in parsed} == {"t0", "t1", "t2"}
    assert all(row["answer"] == _ANSWER for row in parsed)

    # Resume contract: the line-by-line reader recovers exactly the 3 finished task_ids (it
    # json.loads each physical line, so a row fragmented across lines would make it raise).
    assert completed_ids(results_path) == {"t0", "t1", "t2"}
