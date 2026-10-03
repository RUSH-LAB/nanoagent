"""Per-task log capture for trajectories.

Batch mode runs many tasks concurrently in one process, so every log record lands
in a single shared stream (the ``RichHandler`` / ``.log``) with no task attribution.
To fold a task's own warnings and errors (e.g. ``backend call failed (attempt 1/4)``
or its terminal traceback) into that task's ``*.traj.json``, each task installs a
buffer in a :class:`contextvars.ContextVar`; :class:`TaskLogCollector` (a root-logger
handler) appends every record it sees to whichever buffer is active in the current
context.

asyncio tasks each run in their own copied context, so the buffers stay isolated.
Logs emitted from a shared daemon thread (notably the wiki index server's uvicorn
``address already in use`` lines) carry no task context and are skipped here — they
remain only in the shared ``.log``, since a thread shared across concurrent tasks
can't be attributed to any single one.
"""

from __future__ import annotations

import contextvars
import logging
from datetime import datetime, timezone
from typing import Any

# The active task's log buffer, or None when no task context is set (e.g. the
# shared index-server thread). Set per task via ``start_capture``.
_task_logs: contextvars.ContextVar[list[dict[str, Any]] | None] = (
    contextvars.ContextVar("nanoagent_task_logs", default=None)
)

# ``Formatter.formatException`` reads no instance/config state, so one shared stateless
# instance suffices and avoids allocating a throwaway Formatter per captured record on
# the hot ``emit`` path below.
_exc_formatter = logging.Formatter()


class TaskLogCollector(logging.Handler):
    """Root-logger handler: append each record to the active task's buffer, if any.

    Install once (with ``level=logging.WARNING`` to capture only problems). Records
    emitted outside a task context (buffer is ``None``) are silently dropped.
    """

    def emit(self, record: logging.LogRecord) -> None:
        buffer = _task_logs.get()
        if buffer is None:
            return
        message = record.getMessage()
        if record.exc_info:
            message = f"{message}\n{_exc_formatter.formatException(record.exc_info)}"
        buffer.append(
            {
                "time": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(
                    timespec="milliseconds"
                ),
                "level": record.levelname,
                "logger": record.name,
                "message": message,
            }
        )


def start_capture() -> list[dict[str, Any]]:
    """Begin capturing logs for the current context; return the live buffer.

    Call once at the start of a task. The returned list is mutated in place as
    records arrive, so a caller holding it sees logs accumulate (matching the
    per-step trajectory rewrite).
    """
    buffer: list[dict[str, Any]] = []
    _task_logs.set(buffer)
    return buffer
