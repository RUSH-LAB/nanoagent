"""The directory the current rollout's file tools operate in.

A :class:`~contextvars.ContextVar` rather than state on a tool or an argument on
:meth:`Tool.run <nanoagent.core.tool.Tool.run>`, because concurrency here is already per-task: the
batch drivers dispatch every rollout as its own asyncio task under ``asyncio.gather``, and each
task gets its own copy of the context. So one shared :class:`~nanoagent.core.agent.Agent` — the whole
point of the loop being stateless — can still have K rollouts editing K different checkouts at
once, with no signature anywhere admitting that. Unset means the process CWD, which by nanoagent
convention is the repo root; that is every run that does not opt in.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

_root: ContextVar[Path] = ContextVar("nanoagent_workspace")


def current() -> Path:
    """The active workspace root — the process CWD when nothing has set one."""
    return _root.get(Path.cwd())


@contextmanager
def use(path: str | Path) -> Iterator[Path]:
    """Run the body with ``path`` as the workspace root, restoring the previous one after."""
    root = Path(path).resolve()
    token = _root.set(root)
    try:
        yield root
    finally:
        _root.reset(token)
