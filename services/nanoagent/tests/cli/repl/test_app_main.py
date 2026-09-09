"""Offline unit test for ``nanoagent.cli.repl.app.main`` — the ``chat`` subcommand entry point.

What it consumes: :func:`nanoagent.cli.repl.app.main` (read-only), with its two collaborators
monkeypatched so nothing real runs — ``app.load_config_args`` is replaced with a stub
returning a scripted :class:`~types.SimpleNamespace` config (so the test controls ``cfg.yolo``),
and ``app.run_and_save`` (called as a module global from ``main``) is replaced with a
recorder. No model / network / GPU is built.

``main`` is the ``python3 -m nanoagent chat ...`` entry point. Its body is otherwise un-run: ``test_cli_dispatch.py`` only proves ``cli.main``
delegates to a *stubbed* ``app.main`` (it monkeypatches ``import_module``, so this real body
never executes), and ``test_run_and_save.py`` drives ``run_and_save`` directly, never via ``main``.
This pins ``main``'s four behaviors:

* ``test_main_empty_argv_prints_usage_returns_2`` — empty argv prints ``_USAGE`` and returns 2,
  short-circuiting before either seam is touched.
* ``test_main_maps_yolo_to_mode_and_forwards_chat_kwargs`` (both arms) — with argv set, ``main``
  loads the config, maps ``cfg.yolo`` to ``mode`` (``True`` -> ``"yolo"``, ``False`` -> ``"confirm"``),
  resolves ``cfg.output`` (the chat FOLDER) to a ``<folder>/<yymmdd-hhmmss>.traj.json`` session file,
  calls ``run_and_save(cfg, mode=..., confirm_exit=True, subdir="chat")`` exactly once (the chat
  one-shot kwargs, deliberately different from ``run``'s ``confirm_exit=False, subdir="run"``), and
  returns the int ``0``.

What it produces: nothing persistent — both seams are stubbed, so no trajectory/file is written.

Run (from the repo root)::

    python3 -m pytest tests/cli/repl/test_app_main.py -x -q
"""

from __future__ import annotations

import re
from types import SimpleNamespace
from typing import Any

import pytest

from nanoagent.cli.repl import app


def test_main_empty_argv_prints_usage_returns_2(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    # Empty argv hits the usage guard: print(_USAGE) + return 2, short-circuiting before either
    # seam. Both seams are stubbed as recorders so the test proves neither was reached.
    loaded: list[Any] = []
    saved: list[Any] = []

    def fake_load(_cls: Any, _argv: Any) -> SimpleNamespace:
        loaded.append((_cls, _argv))
        return SimpleNamespace(yolo=False)

    monkeypatch.setattr(app, "load_config_args", fake_load)
    monkeypatch.setattr(app, "run_and_save", lambda *a, **k: saved.append((a, k)))

    rc = app.main([])

    assert rc == 2
    assert capsys.readouterr().out.strip() == app._USAGE
    assert loaded == []  # the guard short-circuits before the config is loaded
    assert saved == []  # ...and before any run_and_save


@pytest.mark.parametrize(("yolo", "expected_mode"), [(True, "yolo"), (False, "confirm")])
def test_main_maps_yolo_to_mode_and_forwards_chat_kwargs(yolo: bool, expected_mode: str, monkeypatch: pytest.MonkeyPatch) -> None:
    # Happy path: with argv set, main loads the config, maps cfg.yolo -> mode, resolves `output`
    # (the chat FOLDER) to a timestamped session file, and calls run_and_save once with the chat
    # one-shot kwargs (confirm_exit=True, subdir="chat"), then returns the int 0.
    cfg = SimpleNamespace(
        yolo=yolo, output="out/chatdir", resume=None, commands=[], models={}, theme={}, images=False
    )
    monkeypatch.setattr(app, "load_config_args", lambda _cls, _argv: cfg)
    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
    monkeypatch.setattr(app, "run_and_save", lambda *a, **k: calls.append((a, k)))

    rc = app.main(["chat_cfg=c.yaml"])

    assert rc == 0 and type(rc) is int  # returns the int 0 (not None/2/False) on the happy path
    assert len(calls) == 1  # run_and_save called exactly once
    args, kwargs = calls[0]
    assert args == (cfg,)  # the loaded config is forwarded positionally
    assert kwargs == {
        "resume": None,
        "options": app.ReplOptions(commands=[], models={}, theme={}, images=False),
        "mode": expected_mode,
        "confirm_exit": True,
        "subdir": "chat",
    }
    # `output` (the folder) was resolved to <folder>/<yymmdd-hhmmss>.traj.json before delegating.
    assert re.fullmatch(r"out/chatdir/\d{6}-\d{6}\.traj\.json", cfg.output)
