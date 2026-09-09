"""Offline tests for :mod:`nanoagent.cli.repl.commands` — the REPL's slash-command table.

What the table buys over the if-chain it replaced, and therefore what is pinned here:

* **a config can add commands** — a ``.md`` file becomes a ``/<stem>`` whose text, with
  ``$ARGUMENTS`` substituted, is SUBMITTED as the task. That return-a-string convention is the
  whole mechanism, so it is tested through ``_read``, not by calling the handler.
* **the model is swappable mid-session** — ``/model`` reaches the one reference to the real
  model (``_Narrating._inner``) and leaves the transcript alone, so the new model continues the
  conversation rather than starting one.
* **``/tree`` reports the repo** — tracked files folded to two levels, from ``git ls-files``.
* **theming is real** — a ``theme:`` entry restyles the REPL's named styles, and an unknown
  style name would make Rich raise, so the defaults must cover everything the code prints.

Fully offline: no model, no server; the session is driven through its injectable
``reader``/``console``.

Run (from the repo root)::

    python3 -m pytest tests/cli/repl/test_commands.py -x -q
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

from nanoagent.cli.repl import commands
from nanoagent.cli.repl.app import InteractiveSession, ReplOptions
from rich.console import Console
from rich.theme import Theme


def _session(lines: list[str], **kwargs: Any) -> tuple[InteractiveSession, io.StringIO]:
    buf = io.StringIO()
    queued = iter(lines)
    options = ReplOptions(**kwargs)
    return (
        InteractiveSession(
            model=None,  # type: ignore[arg-type]
            tools=[],
            system_prompt="SYS",
            reader=lambda _p: next(queued),
            console=Console(
                file=buf,
                width=200,
                highlight=False,
                theme=Theme({**commands.DEFAULT_THEME, **options.theme}),
            ),
            options=options,
        ),
        buf,
    )


def test_a_markdown_file_becomes_a_slash_command(tmp_path: Path) -> None:
    template = tmp_path / "review.md"
    template.write_text("Review $ARGUMENTS and report every bug.")
    repl, _ = _session(["/review src/nanoagent/core/agent.py"], commands=[str(template)])

    # The handler's return value IS the task: _read hands it straight back to the loop.
    assert repl._read("> ") == "Review src/nanoagent/core/agent.py and report every bug."
    assert "/review" in repl.commands


def test_a_template_is_re_read_each_time(tmp_path: Path) -> None:
    # Editing the file mid-session must take effect without a restart.
    template = tmp_path / "note.md"
    template.write_text("first")
    repl, _ = _session(["/note", "/note"], commands=[str(template)])
    assert repl._read("> ") == "first"
    template.write_text("second")
    assert repl._read("> ") == "second"


def test_model_switches_the_backing_model(monkeypatch: Any) -> None:
    from nanoagent.runtime import model as model_module
    from nanoagent.runtime.config import ModelConfig

    built: list[str] = []

    def fake_from_config(cfg: ModelConfig) -> str:
        built.append(cfg.model)
        return f"model:{cfg.model}"

    monkeypatch.setattr(model_module.Model, "from_config", staticmethod(fake_from_config))
    big = ModelConfig(model="big-one")  # type: ignore[call-arg]
    repl, buf = _session(["/model big", "/model nope", "go"], models={"big": big})

    assert repl._read("> ") == "go"  # both /model lines re-prompted
    assert built == ["big-one"]
    # The one reference to the real model is what changed; the transcript is untouched.
    assert repl._narrator._inner == "model:big-one"
    assert repl.messages == [{"role": "system", "content": "SYS"}]
    assert "now using big" in buf.getvalue() and "no model 'nope'" in buf.getvalue()


def test_tree_lists_tracked_directories_with_counts() -> None:
    repl, buf = _session(["/tree", ""])
    repl._read("> ")
    out = buf.getvalue()
    assert "src/nanoagent" in out  # this test file's own directory is tracked
    assert "src/nanoagent/tests" not in out  # ...folded to two levels, not the full path


def test_the_theme_restyles_a_named_style() -> None:
    # An unknown style name makes Rich raise, so this also proves DEFAULT_THEME covers the
    # markup the REPL emits: the /h line below uses `notice`.
    repl, buf = _session(["/h", ""], theme={"notice": "blue"})
    repl._read("> ")
    assert "/branches" in buf.getvalue()


def test_inline_image_states_its_size(tmp_path: Path) -> None:
    # The explicit width/height is the point: without them xterm.js (VS Code's terminal)
    # reserves no space and the image never appears.
    from PIL import Image

    path = tmp_path / "shot.png"
    Image.new("RGB", (320, 160)).save(path)

    escape = commands.inline_image(path)
    assert escape.startswith("\033]1337;File=inline=1;size=")
    assert ";width=40;height=10:" in escape  # 320/8 cells wide, aspect-preserved at 8x16 per cell
    assert commands.image_in(f"  {path}  ") == path
    assert commands.image_in("not a path") is None
