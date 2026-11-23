"""Stop after the answer is in: end an agent run once the call that delivers the task's answer has succeeded.

The agent loop stops only when the model replies without a tool call. So once the model has delivered its answer (a task
harness's ``submit``, or a RUSH case's ``answer.json`` written with the file tools), the loop still sends the whole transcript
back for one more reply, which can only be a closing message. On RUSH's DeepSeek V4 Flash runs of our five plugin tasks, that
one call was 34% to 52% of each run's input tokens. A stop rule ends the run right after the step whose calls include a
successful answering call.

A rule is a list of specs, each ``tool`` (any successful call of it) or ``tool:file`` (a successful call whose ``path``
argument names ``file``, by its last path component; for ``write``, only when the written ``content`` is a JSON object, so a
half-filled answer file never ends the run). ``NANOAGENT_STOP_AFTER`` holds them comma-separated, e.g.
``submit,write:answer.json,edit:answer.json``. Empty, the loop runs exactly as before.
"""

from __future__ import annotations

import json
import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

__all__ = ["StopRule", "stop_rule"]

_ENV = "NANOAGENT_STOP_AFTER"


@dataclass(frozen=True)
class StopRule:
    specs: tuple[tuple[str, str | None], ...] = ()

    def __bool__(self) -> bool:
        return bool(self.specs)

    def ends_run(self, row: dict[str, Any]) -> bool:
        """Whether this call-log row (``name``, ``arguments``, ``is_error``) delivered the answer."""
        if row["is_error"]:
            return False
        arguments = row.get("arguments") or {}
        for tool, file in self.specs:
            if row["name"] != tool:
                continue
            if file is None:
                return True
            path = arguments.get("path")
            if not isinstance(path, str) or PurePosixPath(path).name != file:
                continue
            if tool == "write":
                try:
                    if not isinstance(json.loads(arguments.get("content", "")), dict):
                        continue
                except (TypeError, ValueError):
                    continue
            return True
        return False


def stop_rule(specs: Sequence[str] | None) -> StopRule:
    """The rule ``specs`` give, or when None the one ``NANOAGENT_STOP_AFTER`` gives (comma-separated)."""
    if specs is None:
        specs = os.environ.get(_ENV, "").split(",")
    parsed = []
    for spec in (s.strip() for s in specs):
        if spec:
            tool, _, file = spec.partition(":")
            parsed.append((tool, file or None))
    return StopRule(tuple(parsed))
