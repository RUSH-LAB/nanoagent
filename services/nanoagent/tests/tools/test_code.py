"""Offline unit tests for :class:`nanoagent.tools.code.CodeExec` — the code-execution tool.

``CodeExec`` lets the model write Python that runs in one subprocess sandbox per ``invoke``,
doing many operations with no model round-trip per operation, while only what the code PRINTS
(its stdout, capped) re-enters the model's context. These tests pin every clause of that
contract directly (no model, network, or GPU — only tiny stdlib programs):

* selective return — code builds a 100k-element intermediate but prints a tiny summary; the
  tool returns the tiny summary and the large intermediate provably does NOT appear.
* capping — an oversized print is truncated to ``max_output_chars`` (context can't be flooded).
* many ops, one call — a >100-iteration loop runs inside a single ``invoke`` (one subprocess).
* cross-turn handoff — one ``invoke`` writes a file the next ``invoke`` reads back; ``reset``
  wipes the per-task dir so the state is gone afterward. The default temp dir is created lazily
  and removed by ``reset``.
* error feedback — a raising program and a runaway (timeout) program both come back as a
  recoverable ``(text, is_error=True)`` via the ``invoke`` contract, never raised out.
* decoupling — the module imports nothing outside the stdlib (not even nanoagent's own deps); the
  optional ``preamble`` injection point ships empty and is exercised with a trivial preamble.

Run (from the repo root)::

    python3 -m pytest tests/tools/test_code.py -x -q
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from nanoagent.tools import code
from nanoagent.tools.code import CodeExec, CodeExecutionError

# A real ``import``/``from`` of a non-stdlib package at line start (so the docstring's prose
# mentions of those names never false-trip this). These are nanoagent's own runtime deps: this
# module must not reach even for them, because in-sandbox capability enters via ``preamble``.
_PRODUCT_IMPORT = re.compile(r"^[ \t]*(?:import|from)[ \t]+(?:openai|omegaconf|rich|textual)\b", re.M)


# ---- criterion 1: selective return (large intermediate stays in the sandbox) ----


async def test_selective_return_large_intermediate_absent(tmp_path: Path) -> None:
    # Build a 100k-element intermediate but print only a one-line summary. The 100k 'SENTINEL'
    # strings would be ~1.5MB if serialized; the tool must return only the summary.
    tool = CodeExec(work_dir=tmp_path)
    code = "data = ['SENTINEL-%d' % i for i in range(100_000)]\nprint('items', len(data))\n"
    text, is_error = await tool.invoke(code=code)
    assert is_error is False
    assert text.strip() == "items 100000"
    assert len(text) < 50  # tiny return
    assert "SENTINEL" not in text  # the 100k-element intermediate never leaks into the result


async def test_oversized_stdout_is_capped(tmp_path: Path) -> None:
    # A runaway print is bounded to max_output_chars (+ a short truncation marker), so a
    # careless print can't flood the model's context.
    tool = CodeExec(work_dir=tmp_path, max_output_chars=200)
    text, is_error = await tool.invoke(code="print('x' * 100_000)")
    assert is_error is False
    assert len(text) < 300  # 200 cap + the marker, far below the 100k printed
    assert "truncated" in text


# ---- criterion 2: many operations in one call, no per-op model round-trip ----


async def test_single_invoke_runs_multi_op_loop(tmp_path: Path) -> None:
    # A 1000-iteration loop runs inside ONE invoke (one subprocess) — proving the tool does not
    # need a model round-trip per operation.
    tool = CodeExec(work_dir=tmp_path)
    code = "total = 0\nfor i in range(1000):\n    total += i\nprint(total)"
    text, is_error = await tool.invoke(code=code)
    assert is_error is False
    assert text.strip() == "499500"


# ---- criterion 3: cross-turn filesystem handoff + reset isolation ----


async def test_state_persists_across_invokes_and_reset_clears(tmp_path: Path) -> None:
    tool = CodeExec(work_dir=tmp_path)
    # turn 1: write intermediate state to the sandbox working dir...
    t1, e1 = await tool.invoke(code="open('state.json', 'w').write('{\"v\": 41}'); print('saved')")
    assert (t1.strip(), e1) == ("saved", False)
    # turn 2 (same instance, no reset): read it back.
    t2, e2 = await tool.invoke(code="import json; print(json.load(open('state.json'))['v'] + 1)")
    assert (t2.strip(), e2) == ("42", False)
    # reset() wipes the per-task dir, so the state is gone for the next task.
    tool.reset()
    t3, e3 = await tool.invoke(code="import os; print(os.path.exists('state.json'))")
    assert (t3.strip(), e3) == ("False", False)


async def test_default_work_dir_created_lazily_and_reset_removes_it() -> None:
    # With no explicit work_dir a temp dir is created lazily on first use and removed by reset
    # (so repeated runs don't litter /tmp).
    tool = CodeExec()
    assert tool._work_dir is None  # not created until first use
    text, is_error = await tool.invoke(code="print('hi')")
    assert (text.strip(), is_error) == ("hi", False)
    work_dir = tool._work_dir
    assert work_dir is not None and work_dir.exists()
    tool.reset()
    assert tool._work_dir is None and not work_dir.exists()


# ---- criterion 4: errors fed back (not raised) + a timeout bounds runaway code ----


def test_run_raises_codeexecutionerror_on_nonzero_exit(tmp_path: Path) -> None:
    # The raw run() raises on a non-zero exit; with empty stderr the message falls back to the
    # exit code. invoke() (below) is what turns this into recoverable feedback.
    with pytest.raises(CodeExecutionError, match="exited with code 2"):
        CodeExec(work_dir=tmp_path).run("import sys; sys.exit(2)")


async def test_code_error_is_fed_back_not_raised(tmp_path: Path) -> None:
    tool = CodeExec(work_dir=tmp_path)
    text, is_error = await tool.invoke(code="raise ValueError('boom')")
    assert is_error is True  # returned, not raised — the agent loop survives
    assert text.startswith("Error: CodeExecutionError: ")
    assert "ValueError" in text and "boom" in text  # the traceback is fed back to the model


async def test_timeout_returns_recoverable_error(tmp_path: Path) -> None:
    # A sub-second cap trips long before the 5s sleep returns; invoke catches TimeoutExpired and
    # returns it as recoverable feedback instead of hanging / crashing the loop.
    tool = CodeExec(work_dir=tmp_path, timeout=0.3)
    text, is_error = await tool.invoke(code="import time; time.sleep(5)")
    assert is_error is True
    assert text.startswith("Error: TimeoutExpired: ")


# ---- criterion 5: zero coupling + the optional (empty) injection point ----


def test_module_imports_no_other_product() -> None:
    source = Path(code.__file__).read_text(encoding="utf-8")
    assert _PRODUCT_IMPORT.search(source) is None  # nanoagent stays decoupled


async def test_preamble_empty_by_default(tmp_path: Path) -> None:
    tool = CodeExec(work_dir=tmp_path)
    assert tool._preamble == ""  # the injection point ships empty / unused
    # Nothing is injected, so referencing an un-defined name errors (recoverably).
    text, is_error = await tool.invoke(code="print(INJECTED)")
    assert is_error is True
    assert "NameError" in text


async def test_preamble_injection_point(tmp_path: Path) -> None:
    # A trivial preamble is prepended to the model's code, so the code can use what it injects.
    tool = CodeExec(work_dir=tmp_path, preamble="INJECTED = 7")
    text, is_error = await tool.invoke(code="print(INJECTED * 6)")
    assert (text.strip(), is_error) == ("42", False)
