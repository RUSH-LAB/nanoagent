from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path

from contract import ProbeInput, ProbeOutput, SlowWriteInput, SlowWriteOutput, WaitInput, WaitOutput

REFUSED = "refuse-"


def wait(given: WaitInput) -> WaitOutput:
    time.sleep(given.wait_seconds)
    return WaitOutput(waited=given.wait_seconds)


def digest(given: ProbeInput) -> ProbeOutput:
    if given.token.startswith(REFUSED):
        raise ValueError(f"a token starting {REFUSED!r} has no digest: {given.token!r}")
    return ProbeOutput(digest=hashlib.sha256(given.token.encode()).hexdigest()[:12])


def slow_write(given: SlowWriteInput) -> SlowWriteOutput:
    path = Path(os.environ["NANOAGENT_WORKSPACE"]) / given.name
    written = 0
    deadline = time.monotonic() + given.seconds
    with path.open("ab", buffering=0) as out:
        while time.monotonic() < deadline:
            out.write(b".")
            written += 1
            time.sleep(0.1)
    return SlowWriteOutput(written=written)
