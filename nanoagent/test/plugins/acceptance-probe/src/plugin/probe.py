from __future__ import annotations

import hashlib
import time

from contract import ProbeInput, ProbeOutput, WaitInput, WaitOutput

REFUSED = "refuse-"


def wait(given: WaitInput) -> WaitOutput:
    time.sleep(given.wait_seconds)
    return WaitOutput(waited=given.wait_seconds)


def digest(given: ProbeInput) -> ProbeOutput:
    if given.token.startswith(REFUSED):
        raise ValueError(f"a token starting {REFUSED!r} has no digest: {given.token!r}")
    return ProbeOutput(digest=hashlib.sha256(given.token.encode()).hexdigest()[:12])
