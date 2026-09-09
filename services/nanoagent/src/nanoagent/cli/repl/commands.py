"""Slash commands: everything you can type at a REPL prompt that isn't a task.

One ``{name: handler}`` table instead of an if-chain, for the reason a table always beats a chain
once there are more than a few: ``/h`` can list what exists, and a config can ADD to it. A handler
takes the session and the rest of the line, and returns either ``None`` (it did its thing; the
prompt asks again) or a string, which is submitted as the task — that return value is what makes a
prompt template just another command.

A **prompt template** is a ``.md`` file named in ``commands:``. ``notes/review.md`` becomes
``/review``, and its text — with ``$ARGUMENTS`` replaced by the rest of the line — is what gets
submitted. So a workflow you keep retyping becomes a file, with no Python at all.

The mode switches (``/y`` ``/c`` ``/u``) are NOT here: they are answered inside
:meth:`InteractiveSession._read <nanoagent.cli.repl.app.InteractiveSession._read>` because they
change what that read means (in human mode a switch hands control back rather than re-prompting),
which is a property of the reader, not of a command.
"""

from __future__ import annotations

import base64
import subprocess
from collections import Counter
from pathlib import Path
from typing import Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from nanoagent.cli.repl.app import InteractiveSession

# ``None`` re-prompts; a string is submitted as the next task.
Command = Callable[["InteractiveSession", str], str | None]

# Named styles for everything the REPL prints, so `theme:` can restyle it. Rich raises on an
# unknown style name, so every name used in markup must have a default here.
DEFAULT_THEME = {
    "agent": "red bold",
    "tool": "yellow",
    "notice": "green",
    "warn": "yellow",
    "error": "red",
}

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


def help_(session: InteractiveSession, _argument: str) -> None:
    names = " · ".join(f"[notice]{n}[/]" for n in sorted(session.commands))
    session.console.print(
        f"[notice]/y[/] yolo · [notice]/c[/] confirm · [notice]/u[/] human · "
        f"[notice]/m[/] multiline · {names}  "
        f"(current: [bold]{session.mode}[/])"
    )


def tree(session: InteractiveSession, _argument: str) -> None:
    """The repo as tracked directories with file counts — orientation, not a listing.

    ``git ls-files`` rather than a walk: it is already the answer to "what is source here",
    with no ignore rules to reimplement. Folded to two levels deep because the point is the
    shape of the project, and a real tree of a monorepo checkout is thousands of lines.
    """
    listing = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, check=True
    ).stdout.split()
    counts: Counter[str] = Counter()
    for path in listing:
        parent = path.rsplit("/", 1)[0] if "/" in path else "."
        counts["/".join(parent.split("/")[:2])] += 1
    session.console.print(
        "\n".join(f"{n:>6}  {d}" for d, n in sorted(counts.items())) or "[warn]not a git repo[/]"
    )


def model(session: InteractiveSession, name: str) -> None:
    """Swap the model mid-session. The transcript is untouched, so the new one continues it."""
    if name not in session.models:
        session.console.print(
            f"[error]no model {name!r}[/] [dim](configured: {', '.join(session.models) or 'none'})[/]"
        )
        return
    session.set_model(name)
    session.console.print(f"[notice]now using {name}[/]")


def image(session: InteractiveSession, argument: str) -> None:
    path = Path(argument)
    if not path.is_file():
        session.console.print(f"[error]no such file: {argument}[/]")
        return
    session.console.file.write(inline_image(path))
    session.console.file.flush()


def inline_image(path: Path) -> str:
    """The iTerm2 OSC-1337 escape that draws ``path`` in the terminal.

    ``width``/``height`` are stated explicitly, in character cells. iTerm2 is happy without them,
    but xterm.js — which is VS Code's terminal — needs them to reserve the space, and an image
    sent without them simply does not appear there.
    """
    data = path.read_bytes()
    try:
        from PIL import Image

        with Image.open(path) as img:
            pixels = img.size
    except Exception:
        pixels = (640, 480)
    # ~8x16 px per cell, capped at 80 columns so a large image doesn't fill the scrollback.
    columns = min(80, max(1, pixels[0] // 8))
    rows = max(1, round(columns * 8 * pixels[1] / pixels[0] / 16))
    return (
        f"\033]1337;File=inline=1;size={len(data)};width={columns};height={rows}:"
        + base64.b64encode(data).decode()
        + "\a\n"
    )


def image_in(text: str) -> Path | None:
    """The image a tool result names, if it is nothing but a path to one."""
    path = Path(text.strip())
    return path if path.suffix.lower() in _IMAGE_SUFFIXES and path.is_file() else None


def _branch(action: str) -> Command:
    def handler(session: InteractiveSession, argument: str) -> None:
        tree_ = session.tree
        if action == "branches":
            session.console.print("\n".join(tree_.summary()))
        elif action == "fork":
            index = tree_.fork(argument or None)
            session.console.print(
                f"[notice]forked to branch {index}[/] [dim](/switch to go back)[/]"
            )
        else:
            try:
                tree_.switch(int(argument))
            except (ValueError, IndexError) as e:
                session.console.print(f"[error]{e if argument else 'usage: /switch <n>'}[/]")
                return
            session.console.print(f"[notice]on branch {tree_.current}[/]")

    return handler


BUILTINS: dict[str, Command] = {
    "/h": help_,
    "/tree": tree,
    "/model": model,
    "/img": image,
    "/fork": _branch("fork"),
    "/branches": _branch("branches"),
    "/switch": _branch("switch"),
}


def prompt_commands(paths: list[str]) -> dict[str, Command]:
    """``notes/review.md`` -> ``/review``, submitting the file's text as the task."""

    def make(path: Path) -> Command:
        # Read at call time, so editing the file takes effect without restarting the session.
        return lambda _session, argument: path.read_text(encoding="utf-8").replace(
            "$ARGUMENTS", argument
        )

    return {f"/{Path(p).stem}": make(Path(p)) for p in paths}
