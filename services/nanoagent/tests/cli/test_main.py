"""Offline test for nanoagent's batch CLI orchestration wrapper (:func:`nanoagent.cli.main._run_batch`).

``_run_batch`` is the batch fan-out CLI entry an RL trainer drives (rollout fan-out + resume UX). It loads a :class:`~nanoagent.runtime.config.BatchConfig` from ``key=value`` tokens,
wires the progress ``on_start``/``on_done`` callbacks (``on_done`` builds the stop_reason tally via
:func:`~nanoagent.cli.progress.format_tally`), runs :func:`~nanoagent.runtime.batch.run_batch`, prints
``done: N task(s)`` plus the tally, and on Ctrl-C prints a resume hint and returns exit code 130.
``run_batch`` itself is covered by ``test_batch.py`` / ``test_run_batch_resume.py``; this
orchestration wrapper had no tests.

Everything is in-process — no model server, network, or GPU. ``cli.build_agent`` is monkeypatched
to hand back an :class:`~nanoagent.core.agent.Agent` over a scripted model (so no real ``Model``/openai
client is built), and the rich progress bar is sent to an in-memory console so ``capsys`` sees only
``_run_batch``'s own ``print()`` lines.

* ``test_run_batch_happy_path`` — a complete BatchConfig YAML over a 2-row tasks JSONL: rc is 0,
  both ``<id>.traj.json`` trajectories are written, ``results.jsonl`` holds both ids, and stdout
  carries ``done: 2 task(s)`` plus the ``answer=2`` tally (proving the ``on_done`` ->
  ``format_tally`` wiring — an unwired ``on_done`` would leave the tally empty and print
  ``(nothing pending)``).
* ``test_run_batch_keyboard_interrupt_returns_130`` — ``run_batch`` raises ``KeyboardInterrupt``
  (Ctrl-C mid-batch): ``_run_batch`` returns 130, prints the resume hint, and does NOT print the
  ``done:`` summary.

The ``if not cfg.output`` SystemExit branch (cli.py) is intentionally not tested: ``output`` is a
``MISSING`` leaf of BatchConfig, so a config without it fails at load time and the branch is
unreachable (testing it would be vacuous; see CLAUDE.md Simplicity First).

Run (from the repo root)::

    python3 -m pytest tests/cli/test_main.py -q
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest
from rich.console import Console

from nanoagent.cli import main as cli
from nanoagent.runtime import trajectory
from nanoagent.core.agent import Agent, Reply


class _ScriptedModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel`: answer ``"DONE"`` in one turn.

    No tool call → the loop takes that first reply as the final answer (stop_reason ``"answer"``).
    No model server is contacted.
    """

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        return Reply(content="DONE", usage={"prompt_tokens": 1, "total_tokens": 1})


def _scripted_agent() -> Agent:
    # Tool-less, like the batch path's build_agent but offline: the model emits no tool call, so
    # the very first turn is the final answer.
    return Agent(_ScriptedModel(), [], system_prompt="SYS", max_steps=5)


def _write_batch_cfg(tmp_path: Path, *, output_dir: Path, tasks_path: Path) -> str:
    """Write a complete BatchConfig YAML under ``tmp_path``; return its ``batch_cfg=`` token.

    Every ``MISSING`` leaf is set. The ``model.*`` block is dummy — ``build_agent`` is
    monkeypatched, so the only model leaf ``_run_batch`` reads is ``cfg.model.model`` (the ledger's
    ``model_name``). ``tools: []`` and ``output`` are set per the GOAL.
    """
    body = f"""\
model:
  model: test-model
  base_url: null
  backend: sglang
  api_key: null
  temperature: 0.0
  max_tokens: 16
  request_timeout: 600.0
  max_retries: 3
  extra_body: {{}}
  input_price: 0.0
  output_price: 0.0
agent:
  system_prompt: SYS
  max_steps: 5
  cost_limit: null
  token_limit: null
  context_window: null
  hooks: []
  skills: null
  context_files: []
  events: null
tools: []
tools_dir: null
allowed_tools: null
task: null
output: "{output_dir}"
tasks: "{tasks_path}"
concurrency: 8
filter: ""
slice: ""
shuffle: false
redo: false
timeout: null
"""
    path = tmp_path / "batch.yaml"
    path.write_text(body)
    return f"batch_cfg={path}"


def _write_two_tasks(tmp_path: Path) -> Path:
    path = tmp_path / "tasks.jsonl"
    path.write_text('{"task_id": "t1", "task": "do one"}\n{"task_id": "t2", "task": "do two"}\n')
    return path


def _quiet_console() -> Console:
    # A non-tty console backed by a StringIO: the rich progress bar renders there, never to
    # stdout, so capsys.out holds only _run_batch's own print() lines.
    return Console(file=io.StringIO())


def test_run_batch_happy_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tasks_path = _write_two_tasks(tmp_path)
    output_dir = tmp_path / "out"
    token = _write_batch_cfg(tmp_path, output_dir=output_dir, tasks_path=tasks_path)

    # Offline: never build a real Model/openai client — hand back a scripted agent.
    monkeypatch.setattr(cli, "build_agent", lambda *_: _scripted_agent())

    rc = cli._run_batch([token], _quiet_console())
    assert rc == 0

    # Both rollouts ran: each task's trajectory was written and the ledger holds both ids.
    for tid in ("t1", "t2"):
        assert (output_dir / trajectory.TRAJECTORIES_DIRNAME / f"{tid}{trajectory.TRAJECTORY_SUFFIX}").exists()
    ledger_ids = {json.loads(line)["task_id"] for line in (output_dir / "results.jsonl").read_text().splitlines()}
    assert ledger_ids == {"t1", "t2"}

    # The done line and the on_done -> format_tally tally both reach stdout. Both tasks answered in
    # one turn (no tool call → stop_reason "answer"), so the tally is "answer=2"; an unwired
    # on_done would leave the tally empty and print "(nothing pending)" instead.
    out = capsys.readouterr().out
    assert "done: 2 task(s)" in out
    assert "answer=2" in out
    assert "(nothing pending)" not in out


def test_run_batch_keyboard_interrupt_returns_130(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tasks_path = _write_two_tasks(tmp_path)
    output_dir = tmp_path / "out"
    token = _write_batch_cfg(tmp_path, output_dir=output_dir, tasks_path=tasks_path)

    # build_agent is evaluated as an argument to run_batch (before the call), so keep it offline
    # even though the run is cut short below.
    monkeypatch.setattr(cli, "build_agent", lambda *_: _scripted_agent())

    # Simulate Ctrl-C mid-batch: run_batch raises KeyboardInterrupt.
    def _interrupt(*args: Any, **kwargs: Any) -> Any:
        raise KeyboardInterrupt

    monkeypatch.setattr(cli, "run_batch", _interrupt)

    rc = cli._run_batch([token], _quiet_console())
    assert rc == 130

    # The resume hint is printed; the normal "done:" summary is skipped (we returned early).
    out = capsys.readouterr().out
    assert "interrupted" in out
    assert "re-run the same command to resume" in out
    assert "done:" not in out
