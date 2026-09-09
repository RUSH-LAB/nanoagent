"""Offline coverage for ``run_and_save`` — the single-task run/chat save wrapper.

What it consumes: :func:`nanoagent.cli.repl.app.run_and_save` plus the
:class:`~nanoagent.core.agent.Reply` / ``StopReason`` shapes (read-only), and
:func:`nanoagent.runtime.config.load_config` to build a :class:`~nanoagent.runtime.config.RunConfig`
from a YAML written under ``tmp_path``. No model server / network / GPU: the two external
seams are monkeypatched — ``app.Model.from_config`` returns a scripted one-turn
model and ``app.get_tools`` returns ``[]``.

Pins the wrapper's load-bearing guarantee that ``test_app_chat_loop.py`` (which
drives :meth:`InteractiveSession.chat` directly) leaves uncovered: ``run_and_save`` builds
a session from a ``RunConfig``, runs it on ``cfg.task``, and ALWAYS persists the trajectory
on ANY exit — a clean answer, a model error, or a Ctrl-C that leaks out of ``asyncio.run`` —
via its ``try/except KeyboardInterrupt`` + ``finally``, folding in ``meta={task, model}``
and the captured logs. The Ctrl-C arm is the one that genuinely exercises that
``except``/``finally``: a plain ``Exception`` is caught *inside* ``chat`` (so ``asyncio.run``
returns normally there), whereas a ``KeyboardInterrupt`` propagates out of ``asyncio.run``
(asyncio re-raises it through the loop) and only the wrapper's ``except``/``finally`` keeps
the trajectory from being lost.

Also pins the wrapper's DEFAULT save-path construction: when ``cfg.output`` is unset, the
trajectory goes to ``DEFAULT_TRAJ_DIR / <subdir> / <timestamp>{TRAJECTORY_SUFFIX}`` — the path
``python3 -m nanoagent chat``/``run`` uses without ``output=`` (see
``test_run_and_save_default_output_path``, which redirects ``DEFAULT_TRAJ_DIR`` to ``tmp_path``).

What it produces: nothing persistent — every trajectory is written under pytest's
``tmp_path`` and discarded with it.

Run (from the repo root)::

    python3 -m pytest tests/cli/repl/test_run_and_save.py -x -q
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from nanoagent.cli.repl import app
from nanoagent.runtime import trajectory
from nanoagent.core.agent import Reply
from nanoagent.runtime.config import load_config, RunConfig


class _OneTurnModel:
    """Scripted stand-in for ``nanoagent.runtime.model.Model``: a single ``query`` turn.

    Returns the queued :class:`Reply` (clean arm) or raises the queued exception (the
    failure arms); counts calls so a test can confirm the session actually drove a turn
    rather than saving a vacuous, never-run session. Matches the shape
    :class:`InteractiveSession` calls: ``query(messages, tools, *, on_delta=...)``.
    """

    def __init__(self, reply_or_exc: Any) -> None:
        self._item = reply_or_exc
        self.calls = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.calls += 1
        if isinstance(self._item, BaseException):
            raise self._item
        return self._item


def _load_cfg(tmp_path: Path, *, task: str, output: Path | None) -> RunConfig:
    """Write a minimal valid run YAML under ``tmp_path`` and load it as a ``RunConfig``.

    Sets every required (``MISSING``) leaf; ``model`` values are dummies since
    ``Model.from_config`` is monkeypatched, but ``model.model`` is still read for ``meta``.
    ``output=None`` writes ``output: null`` (NOT an omitted line: ``output`` is a ``MISSING``
    field, so omitting it fails load validation) — the documented "use the timestamped default
    path" value, which leaves ``cfg.output`` falsy so ``run_and_save`` builds the path itself.
    """
    yaml_path = tmp_path / "run.yaml"
    output_line = "output: null" if output is None else f"output: {str(output)!r}"
    yaml_path.write_text(
        "\n".join(
            [
                "model:",
                "  model: fake-model",
                '  base_url: "http://test"',
                "  backend: sglang",
                "  api_key: null",
                "  temperature: 0.0",
                "  max_tokens: 16",
                "  request_timeout: 600.0",
                "  max_retries: 3",
                "  extra_body: {}",
                "  input_price: 0.0",
                "  output_price: 0.0",
                "agent:",
                "  system_prompt: SYS",
                "  max_steps: 4",
                "  cost_limit: null",
                "  token_limit: null",
                "  context_window: null",
                "  hooks: []",
                "  skills: null",
                "  context_files: []",
                "  events: null",
                "tools: []",
                "tools_dir: null",
                "allowed_tools: null",
                f"task: {task!r}",
                output_line,
                "",
            ]
        )
    )
    return load_config(RunConfig, [str(yaml_path)])


def _patch_seams(monkeypatch: Any, model: _OneTurnModel) -> None:
    """Replace the two external seams so ``run_and_save`` is fully offline."""
    monkeypatch.setattr(app.Model, "from_config", lambda _cfg: model)
    monkeypatch.setattr(
        app, "build_prompt_and_tools", lambda cfg, *_: (cfg.system_prompt, [])
    )


def test_run_and_save_clean_writes_answer_and_meta(tmp_path: Path, monkeypatch: Any) -> None:
    # Clean one-turn answer: run_and_save drives the session and saves to the explicit
    # `output`, carrying the model's answer, the ANSWER stop_reason, and meta={task, model}.
    out = tmp_path / "clean.traj.json"
    cfg = _load_cfg(tmp_path, task="do the thing", output=out)
    model = _OneTurnModel(Reply(content="the answer"))
    _patch_seams(monkeypatch, model)

    app.run_and_save(cfg, mode="yolo", confirm_exit=False, subdir="run")

    assert model.calls == 1  # the session actually drove one model turn (not a vacuous save)
    assert out.exists()
    data = trajectory.load(out)
    assert data["answer"] == "the answer"  # the reply's content was carried into the trajectory
    assert data["stop_reason"] == "answer"
    assert data["meta"]["task"] == "do the thing"
    assert data["meta"]["model"] == "fake-model"
    assert data["trajectory_format"] == "nanoagent-2"


def test_run_and_save_writes_trajectory_on_model_error(tmp_path: Path, monkeypatch: Any) -> None:
    # The model raises a plain Exception: chat() catches it and records ERROR, run_and_save
    # returns without propagating, and the trajectory is still written with stop_reason=error.
    out = tmp_path / "error.traj.json"
    cfg = _load_cfg(tmp_path, task="will fail", output=out)
    model = _OneTurnModel(RuntimeError("boom"))
    _patch_seams(monkeypatch, model)

    app.run_and_save(cfg, mode="yolo", confirm_exit=False, subdir="run")  # must not raise

    assert model.calls == 1  # the failing turn really ran
    assert out.exists()
    data = trajectory.load(out)
    assert data["stop_reason"] == "error"
    assert data["meta"]["task"] == "will fail"  # meta is built even on the failure path


def test_run_and_save_writes_trajectory_on_keyboard_interrupt(tmp_path: Path, monkeypatch: Any) -> None:
    # Ctrl-C: a query raising KeyboardInterrupt leaks out of asyncio.run (asyncio re-raises
    # it through the loop). This is the arm that genuinely exercises run_and_save's
    # `except KeyboardInterrupt` + `finally`: the call must NOT propagate and must still save.
    out = tmp_path / "interrupt.traj.json"
    cfg = _load_cfg(tmp_path, task="ctrl-c me", output=out)
    model = _OneTurnModel(KeyboardInterrupt())
    _patch_seams(monkeypatch, model)

    app.run_and_save(cfg, mode="yolo", confirm_exit=False, subdir="run")  # absorbs the interrupt

    assert out.exists()  # the finally wrote it despite the interrupt leaking from asyncio.run
    data = trajectory.load(out)
    assert data["stop_reason"] == "interrupted"
    assert data["meta"]["task"] == "ctrl-c me"


def test_run_and_save_default_output_path(tmp_path: Path, monkeypatch: Any) -> None:
    # Default-output branch: with cfg.output unset (`output: null`), run_and_save builds the save
    # path ITSELF as DEFAULT_TRAJ_DIR / subdir / <timestamp>{TRAJECTORY_SUFFIX} — the real path for
    # `python3 -m nanoagent chat`/`run` invoked without `output=`, which none of the three
    # explicit-output tests above exercise. Monkeypatch DEFAULT_TRAJ_DIR to tmp_path so nothing lands
    # in the tracked expdir/ tree, run with subdir="run", and assert exactly one
    # timestamp-named *.traj.json was written under tmp_path/"run"/.
    #
    # Mutations caught: inverting `if cfg.output else` (then `Path(cfg.output)` runs with
    # output=None and raises, so run_and_save blows up); dropping `/ subdir` (the file lands
    # directly in tmp_path, leaving tmp_path/"run"/ empty); dropping `{TRAJECTORY_SUFFIX}` (the
    # saved name no longer matches *.traj.json).
    cfg = _load_cfg(tmp_path, task="default out", output=None)
    assert cfg.output is None  # precondition: the unset-output (default-path) branch is under test
    model = _OneTurnModel(Reply(content="ok"))
    _patch_seams(monkeypatch, model)
    monkeypatch.setattr(app, "DEFAULT_TRAJ_DIR", str(tmp_path))

    app.run_and_save(cfg, mode="yolo", confirm_exit=False, subdir="run")

    assert model.calls == 1  # the session actually drove one turn (not a vacuous save)
    written = list((tmp_path / "run").glob(f"*{trajectory.TRAJECTORY_SUFFIX}"))
    assert len(written) == 1  # exactly one trajectory, under tmp_path/run/ (subdir honored)
    stem = written[0].name[: -len(trajectory.TRAJECTORY_SUFFIX)]
    # the stem must parse as run_and_save's filename format (datetime.now():%Y%m%d_%H%M%S);
    # strptime raises (failing the test) on any non-timestamp name, binding to the exact format.
    datetime.strptime(stem, "%Y%m%d_%H%M%S")
    data = trajectory.load(written[0])  # the saved file is the real trajectory, not an empty stub
    assert data["answer"] == "ok"
    assert data["meta"]["task"] == "default out"
