"""Public harness contract.

A harness receives normalized conversation input, emits normalized progress
events, and returns one normalized result. Model providers, native loops and
third-party agent CLIs all sit behind this boundary.
"""

from nanoagent.runtime.runner import (
    ProgressSink,
    Runner as Harness,
    RunnerCapabilities as HarnessCapabilities,
    RunnerError as HarnessError,
    RunnerProtocolError as HarnessProtocolError,
    RunnerRequest as HarnessRequest,
    RunnerResult as HarnessResult,
    RunnerUnavailableError as HarnessUnavailableError,
    validate_progress_event,
)

__all__ = [
    "Harness",
    "HarnessCapabilities",
    "HarnessError",
    "HarnessProtocolError",
    "HarnessRequest",
    "HarnessResult",
    "HarnessUnavailableError",
    "ProgressSink",
    "validate_progress_event",
]
