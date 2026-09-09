"""Terminal trajectory browser for nanoagent ``*.traj.json`` files (a Textual TUI).

Faithful to mini-swe-agent's inspector: ←/→ (or h/l) step through one agent run, H/L
switch between trajectories found in a directory, q quits. The pure helpers
(:func:`find_trajectories`, :func:`messages_to_steps`, :func:`render_message`) are
unit-tested; the Textual app is exercised manually.

Inputs:
  - ``path`` (a ``*.traj.json`` file, or a directory searched recursively for them,
    produced by :mod:`nanoagent.cli.main`).

Run:
  nanoagent browse path=expdir/chat/
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from nanoagent.runtime.config import BrowseConfig, load_config_args
from nanoagent.runtime.trajectory import TRAJECTORY_SUFFIX


def find_trajectories(path: str | Path) -> list[Path]:
    """Return the trajectory files at ``path`` (a single file) or sorted under it (a dir)."""
    path = Path(path)
    if path.is_file():
        return [path]
    return sorted(path.rglob(f"*{TRAJECTORY_SUFFIX}"))


def messages_to_steps(messages: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Group messages into pages: each assistant turn starts a new step, and the tool
    results that follow it trail in the same step (mirrors mini-swe-agent's inspector)."""
    steps: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for message in messages:
        if message.get("role") == "assistant":
            if current:
                steps.append(current)
            current = [message]
        else:
            current.append(message)
    if current:
        steps.append(current)
    return steps


def render_message(message: dict[str, Any]) -> str:
    """Render one message as plain text: role header, content, then any tool calls.

    The header also shows the inlined per-step ``durations`` (assistant turns) and flags a tool
    result whose ``is_error`` is set — both written onto the message by the saved-trajectory
    annotation (see :func:`nanoagent.runtime.trajectory._annotate_messages`).
    """
    header = f"## {(message.get('role') or 'unknown').upper()}"
    durations = message.get("durations")
    if isinstance(durations, dict):
        header += f"  (model={durations.get('model', 0.0):.1f}s tools={durations.get('tools', 0.0):.1f}s)"
    if message.get("is_error"):
        header += "  [ERROR]"
    parts = [header]
    content = message.get("content")
    if isinstance(content, list):  # some providers chunk content into [{type,text},...]
        content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    if content:
        parts.append(str(content))
    for call in message.get("tool_calls") or []:
        fn = call.get("function", {})
        parts.append(f"-> tool call: {fn.get('name')}({fn.get('arguments')})")
    return "\n".join(parts)


def _load_messages(path: str | Path) -> list[dict[str, Any]]:
    """Load a trajectory's messages, tolerating malformed/missing files (-> empty list)."""
    try:
        data = json.loads(Path(path).read_text())
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return []
    if isinstance(data, dict):
        messages = data.get("messages", [])
        return [m for m in messages if isinstance(m, dict)] if isinstance(messages, list) else []
    if isinstance(data, list):
        return [m for m in data if isinstance(m, dict)]
    return []


_USAGE = "usage: nanoagent browse path=<dir-or-traj-file>"


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else list(argv)
    if not argv:
        print(_USAGE)
        return 2
    cfg = load_config_args(BrowseConfig, argv)
    files = find_trajectories(cfg.path)
    if not files:
        print(f"no {TRAJECTORY_SUFFIX} files found under {cfg.path!r}")
        return 1
    _run_app(files)
    return 0


def _run_app(files: list[Path]) -> None:
    # textual is imported lazily so the pure helpers above import without it installed.
    from textual.app import App, ComposeResult
    from textual.binding import Binding
    from textual.containers import VerticalScroll
    from textual.widgets import Footer, Header, Static

    class TrajectoryBrowser(App):
        BINDINGS = [
            Binding("right,l", "step(1)", "step+"),
            Binding("left,h", "step(-1)", "step-"),
            Binding("0", "first_step", "first"),
            Binding("dollar_sign,end", "last_step", "last"),
            Binding("L", "traj(1)", "traj+"),
            Binding("H", "traj(-1)", "traj-"),
            Binding("j,down", "scroll(1)", "↓"),
            Binding("k,up", "scroll(-1)", "↑"),
            Binding("q", "quit", "quit"),
        ]

        def __init__(self) -> None:
            super().__init__()
            self._files = files
            self._i_traj = 0
            self._i_step = 0
            self._steps = messages_to_steps(_load_messages(files[0]))

        def compose(self) -> ComposeResult:
            yield Header()
            # markup=False: trajectory text is plain text; bracketed tokens like
            # "[118.77] Granity Studios" must not be parsed as Textual console markup.
            yield VerticalScroll(Static(id="content", markup=False))
            yield Footer()

        def on_mount(self) -> None:
            self._refresh()

        def _refresh(self) -> None:
            step = self._steps[self._i_step] if self._steps else []
            body = "\n\n".join(render_message(m) for m in step) or "(empty trajectory)"
            self.query_one("#content", Static).update(body)
            self.title = (
                f"{self._files[self._i_traj].name}  "
                f"traj {self._i_traj + 1}/{len(self._files)}  "
                f"step {self._i_step + 1}/{len(self._steps)}"
            )

        def _load_current(self) -> None:
            self._steps = messages_to_steps(_load_messages(self._files[self._i_traj]))
            self._i_step = 0

        def action_step(self, delta: int) -> None:
            self._i_step = max(0, min(self._i_step + delta, len(self._steps) - 1))
            self._refresh()

        def action_first_step(self) -> None:
            self._i_step = 0
            self._refresh()

        def action_last_step(self) -> None:
            self._i_step = max(0, len(self._steps) - 1)
            self._refresh()

        def action_traj(self, delta: int) -> None:
            new = max(0, min(self._i_traj + delta, len(self._files) - 1))
            if new != self._i_traj:  # keep step position when already at a boundary
                self._i_traj = new
                self._load_current()
            self._refresh()

        def action_scroll(self, dy: int) -> None:
            view = self.query_one(VerticalScroll)
            view.scroll_down() if dy > 0 else view.scroll_up()

    TrajectoryBrowser().run()


if __name__ == "__main__":
    raise SystemExit(main())
