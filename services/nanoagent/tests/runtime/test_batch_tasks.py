"""Offline unit tests for the CLI batch task-selection helpers
(:func:`nanoagent.runtime.batch.load_tasks` and :func:`nanoagent.runtime.batch.filter_tasks`).

nanoagent's batch run mode (the rollout fan-out) picks which tasks to run with two pure helpers in :mod:`nanoagent.runtime.batch`: ``load_tasks`` reads a JSONL of tasks and
``filter_tasks`` narrows it (regex on id, ``a:b`` slice, seeded shuffle). ``test_batch.py`` only
exercises ``run_batch``; these two were untested. Everything here is in-process — no model,
network, or GPU — using ``tmp_path`` files and the helpers' own return values.

* ``test_load_tasks_happy_path`` — a ``{task_id, task}`` JSONL → list of ``(str, str)`` tuples;
  blank lines skipped, non-string ids/tasks str()-ified.
* ``test_load_tasks_accepts_browsecomp_keys`` — ``{query_id, problem}`` rows are accepted as
  fallbacks, and the canonical ``task_id``/``task`` win when both are present.
* ``test_load_tasks_missing_keys_raises`` — a row with neither id nor task key raises
  ``ValueError`` whose message names the file path and the offending (sorted) keys.
* ``test_load_tasks_missing_one_key_raises`` — a row missing only the id (or only the task) also
  raises (the guard is ``task_id is None or task is None``).
* ``test_filter_tasks_regex_keeps_matching_ids`` — ``filter_re`` keeps ids matching the pattern
  via ``re.search`` (an empty pattern is a no-op).
* ``test_filter_tasks_slice_selects_subrange`` — ``slice_spec`` selects ``out[slice(*parts)]``
  (``a:b`` plus open-ended / stepped forms; an empty spec is a no-op).
* ``test_filter_tasks_shuffle_is_seeded_permutation`` — ``shuffle=True`` is deterministic
  (sort by id, then seed ``_SHUFFLE_SEED``) and a permutation of the input.
* ``test_filter_tasks_filter_then_slice_compose_in_order`` — combined, the filter runs before the
  slice.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_batch_tasks.py -x -q
"""

from __future__ import annotations

import random
from collections import Counter
from pathlib import Path

import pytest

from nanoagent.runtime.batch import filter_tasks, load_tasks
from nanoagent.runtime.taskselect import _SHUFFLE_SEED


def test_load_tasks_happy_path(tmp_path: Path) -> None:
    # Canonical {task_id, task} rows -> (str, str) tuples. A blank line in the middle is skipped,
    # and a non-string id/task is str()-ified.
    path = tmp_path / "tasks.jsonl"
    path.write_text(
        '{"task_id": "a1", "task": "list the python files"}\n'
        "\n"
        '{"task_id": 2, "task": 3}\n'
    )
    assert load_tasks(path) == [("a1", "list the python files"), ("2", "3")]


def test_load_tasks_accepts_browsecomp_keys(tmp_path: Path) -> None:
    # BrowseComp gold files use {query_id, problem}; these are accepted as fallbacks. When both
    # the canonical and the fallback keys are present, the canonical task_id/task win.
    path = tmp_path / "gold.jsonl"
    path.write_text(
        '{"query_id": "q1", "problem": "find X"}\n'
        '{"task_id": "canon", "query_id": "fallback", "task": "T", "problem": "P"}\n'
    )
    assert load_tasks(path) == [("q1", "find X"), ("canon", "T")]


def test_load_tasks_missing_keys_raises(tmp_path: Path) -> None:
    # A row with neither id nor task key -> ValueError; the message names the file path and the
    # offending row's (sorted) keys.
    path = tmp_path / "bad.jsonl"
    path.write_text('{"foo": "bar", "baz": 1}\n')
    with pytest.raises(ValueError) as excinfo:
        load_tasks(path)
    msg = str(excinfo.value)
    assert str(path) in msg
    assert "task_id" in msg
    assert "baz" in msg and "foo" in msg


def test_load_tasks_missing_one_key_raises(tmp_path: Path) -> None:
    # The guard is `task_id is None or task is None`, so a row missing EITHER required field
    # raises -- not only rows missing both.
    no_id = tmp_path / "no_id.jsonl"
    no_id.write_text('{"task": "orphan task"}\n')
    with pytest.raises(ValueError):
        load_tasks(no_id)

    no_task = tmp_path / "no_task.jsonl"
    no_task.write_text('{"task_id": "x"}\n')
    with pytest.raises(ValueError):
        load_tasks(no_task)


def test_filter_tasks_regex_keeps_matching_ids() -> None:
    tasks = [("gsm_1", "a"), ("gsm_2", "b"), ("bc_1", "c"), ("aime_3", "d")]
    # filter_re keeps only ids matching the pattern, preserving their input order.
    assert filter_tasks(tasks, filter_re="^gsm_") == [("gsm_1", "a"), ("gsm_2", "b")]
    # It uses re.search (not re.match), so an unanchored pattern matches anywhere in the id.
    assert filter_tasks([("xgsm", "v")], filter_re="gsm") == [("xgsm", "v")]
    # An empty pattern is falsy -> no filtering; the whole list passes through unchanged.
    assert filter_tasks(tasks, filter_re="") == tasks


def test_filter_tasks_slice_selects_subrange() -> None:
    tasks = [(str(i), f"t{i}") for i in range(5)]  # ids "0".."4"
    assert filter_tasks(tasks, slice_spec="1:3") == tasks[1:3]
    assert filter_tasks(tasks, slice_spec=":3") == tasks[:3]  # open start
    assert filter_tasks(tasks, slice_spec="2:") == tasks[2:]  # open end
    # parts feed slice(*parts), so a third field is the step.
    assert filter_tasks(tasks, slice_spec="0:5:2") == tasks[0:5:2]
    # An empty spec is falsy -> no slicing.
    assert filter_tasks(tasks, slice_spec="") == tasks


def test_filter_tasks_shuffle_is_seeded_permutation() -> None:
    tasks = [(f"id_{i:02d}", f"t{i}") for i in range(20)]

    # This test deliberately perturbs and reseeds the process-global RNG (to prove filter_tasks
    # re-seeds internally); capture/restore it so no mutation leaks to later-collected tests.
    rng_state = random.getstate()
    try:
        result = filter_tasks(tasks, shuffle=True)

        # Deterministic, and independent of ambient random state: filter_tasks re-seeds with
        # _SHUFFLE_SEED before shuffling, so a same-input call always returns the same order.
        random.seed(999)
        random.random()
        assert filter_tasks(tasks, shuffle=True) == result

        # A permutation of the input -- nothing dropped or duplicated.
        assert Counter(result) == Counter(tasks)

        # Exactly the documented order: sort by id, then seed _SHUFFLE_SEED and shuffle in place.
        expected = sorted(tasks, key=lambda t: t[0])
        random.seed(_SHUFFLE_SEED)
        random.shuffle(expected)
        assert result == expected

        # Because it sorts by id first, the result is independent of the input's ordering.
        assert filter_tasks(list(reversed(tasks)), shuffle=True) == result
    finally:
        random.setstate(rng_state)


def test_filter_tasks_filter_then_slice_compose_in_order() -> None:
    tasks = [
        ("gsm_0", "a"),
        ("bc_0", "b"),
        ("gsm_1", "c"),
        ("bc_1", "d"),
        ("gsm_2", "e"),
    ]
    # filter runs before slice: first keep the gsm_* survivors, THEN take [:2] of those.
    survivors = [("gsm_0", "a"), ("gsm_1", "c"), ("gsm_2", "e")]
    assert filter_tasks(tasks, filter_re="^gsm_", slice_spec=":2") == survivors[:2]
