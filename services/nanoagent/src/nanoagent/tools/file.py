"""Structured file tools: ``read`` / ``write`` / ``edit``, scoped to the rollout's workspace.

Structured rather than "just use bash", because an agent editing a file through a shell has to
serialize its intent into a heredoc or a sed expression and hope the quoting survives. ``edit``
takes the old and new text as JSON arguments, so nothing is quoted twice, and an ambiguous edit
(the old text appears more than once) is rejected instead of silently changing the wrong line.

Every path resolves under ``workspace.current() / root`` and is rejected if it escapes it. That
is a scoping rule, not a sandbox: like :class:`~nanoagent.tools.bash.Bash` these run in-process as
the same user, and nothing stops the agent reaching outside via ``bash``.

``provenance``, when a YAML sets it, is the audit trail: one JSONL row per byte-changing call,
so every file the agent authored is attributable after the fact. ``null`` disables it.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from nanoagent.core import workspace
from nanoagent.core.tool import JsonSchema, Tool

# Read's default cap. A model that asks to read a 200k-line generated file would otherwise spend
# the whole context window on one tool result; it can page past this with `offset`.
_DEFAULT_LIMIT = 2000


class _FileTool(Tool):
    """Shared path resolution and provenance for the file tools.

    No ``NAME``, so :func:`~nanoagent.extensions.get_tools` skips it — it is a base, not a tool. All
    three subclasses take the same two kwargs because ``get_tools`` hands every ``Tool`` defined
    in a module the same YAML config block.
    """

    def __init__(self, *, root: str = ".", provenance: str | None = None) -> None:
        self._root = root
        self._provenance = provenance

    def _resolve(self, path: str) -> Path:
        base = (workspace.current() / self._root).resolve()
        full = (base / path).resolve()
        if not full.is_relative_to(base):
            raise ValueError(f"{path!r} resolves outside the workspace {base}")
        return full

    def _record(self, path: Path) -> None:
        if self._provenance is None:
            return
        row = {"ts": time.time(), "tool": self.NAME, "path": str(path), "root": str(workspace.current())}
        log = Path(self._provenance)
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")


class Read(_FileTool):
    """Read a text file, returning its lines numbered from 1 so `edit` can be aimed precisely."""

    NAME = "read"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "file path, relative to the workspace"},
            "offset": {"type": "integer", "description": "1-based first line to return"},
            "limit": {"type": "integer", "description": f"how many lines (default {_DEFAULT_LIMIT})"},
        },
        "required": ["path"],
    }

    def run(self, path: str, offset: int = 1, limit: int = _DEFAULT_LIMIT) -> str:
        lines = self._resolve(path).read_text(encoding="utf-8", errors="replace").splitlines()
        start = max(1, offset)
        shown = lines[start - 1 : start - 1 + max(0, limit)]
        body = "\n".join(f"{start + i}\t{line}" for i, line in enumerate(shown))
        rest = len(lines) - (start - 1 + len(shown))
        return body if rest <= 0 else f"{body}\n... {rest} more line(s); re-read with offset."


class Write(_FileTool):
    """Write `content` to `path`, replacing it if it exists and creating parent directories."""

    NAME = "write"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "file path, relative to the workspace"},
            "content": {"type": "string", "description": "the file's full new contents"},
        },
        "required": ["path", "content"],
    }

    def run(self, path: str, content: str) -> str:
        full = self._resolve(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
        self._record(full)
        return f"wrote {len(content)} char(s) to {path}"


class Edit(_FileTool):
    """Replace the one occurrence of `old` in `path` with `new`.

    Fails if `old` is absent or appears more than once — include enough surrounding lines to
    make it unique rather than retrying a match that could hit the wrong place.
    """

    NAME = "edit"
    PARAMETERS: JsonSchema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "file path, relative to the workspace"},
            "old": {"type": "string", "description": "exact text to replace, unique in the file"},
            "new": {"type": "string", "description": "text to put in its place"},
        },
        "required": ["path", "old", "new"],
    }

    def run(self, path: str, old: str, new: str) -> str:
        full = self._resolve(path)
        text = full.read_text(encoding="utf-8")
        count = text.count(old)
        if count != 1:
            found = "not found" if count == 0 else f"found {count} times"
            raise ValueError(f"`old` {found} in {path}; it must match exactly once")
        full.write_text(text.replace(old, new), encoding="utf-8")
        self._record(full)
        return f"edited {path}"
