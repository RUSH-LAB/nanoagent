"""A case session's result: what a harness left in `answer.json` of its frozen workspace.

One reader for the uploaded worker.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Any

from nanoagent.uploaded.contract import ContractError, decode_json_object

ANSWER ="answer.json"  # the file the worker seeds into every case workspace and the outcome seam reads


def read_answer(workspace: Path) -> tuple[dict[str, Any] | None, str | None, str | None]:
    """The output, refusal or failure a coding agent's answer.json gives."""
    try:
        fd = os.open(workspace / ANSWER, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None, None, f"wrote no {ANSWER}"
    except OSError as error:
        return None, None, f"cannot open {ANSWER}: {error.strerror}"
    if not stat.S_ISREG(os.fstat(fd).st_mode):  # checked before reading: a directory or a FIFO must not be opened as text
        os.close(fd)
        return None, None, f"{ANSWER} is not a regular file"
    try:
        with os.fdopen(fd, "rb") as answer:
            value = decode_json_object(answer.read())
    except ContractError as error:
        return None, None, f"{ANSWER} is invalid: {error.message}"
    if set(value) == {"refused"}:
        reason = value["refused"]
        if not isinstance(reason, str) or not reason.strip():
            return None, None, f"{ANSWER} needs a nonempty refusal reason"
        return None, reason, None
    return value, None, None
