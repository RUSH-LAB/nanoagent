"""The coding policy's result: what a harness left in `answer.json` of its frozen workspace.

One reader for the plugin benchmark's local runs (`examples/benchmark/step2_single_run.py`) and the uploaded worker.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Any

from nanoagent.uploaded.contract import ContractError, decode_json_object


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
        with os.fdopen(fd, "rb") as answer:
            value = decode_json_object(answer.read())
    except ContractError as error:
        return None, None, f"answer.json is invalid: {error.message}"
    if set(value) == {"refused"}:
        reason = value["refused"]
        if not isinstance(reason, str) or not reason.strip():
            return None, None, 'answer.json needs a nonempty refusal reason'
        return None, reason, None
    return value, None, None
