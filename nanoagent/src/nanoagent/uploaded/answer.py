"""The coding policy's result: what a harness left in `answer.json` of its frozen workspace.

One reader for the plugin benchmark's local runs (`examples/benchmark/step2_single_run.py`) and the uploaded worker.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any


def read_answer(workspace: Path) -> tuple[dict[str, Any] | None, str | None, str | None]:
    """The output, refusal or failure a coding agent's answer.json gives."""
    try:
        fd = os.open(workspace / "answer.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None, None, "wrote no answer.json"
    except OSError as error:
        return None, None, f"cannot open answer.json: {error.strerror}"
    if not stat.S_ISREG(os.fstat(fd).st_mode):  # checked before reading: a directory or a FIFO must not be opened as text
        os.close(fd)
        return None, None, "answer.json is not a regular file"
    try:
        with os.fdopen(fd, encoding="utf-8") as answer:
            value = json.load(answer)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        return None, None, f"answer.json is not UTF-8 JSON: {error}"
    if not isinstance(value, dict):
        return None, None, "answer.json is not a JSON object"
    if set(value) == {"refused"}:
        reason = value["refused"]
        if not isinstance(reason, str) or not reason.strip():
            return None, None, 'answer.json needs a nonempty refusal reason'
        return None, reason, None
    return value, None, None
