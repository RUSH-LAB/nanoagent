"""Compatibility facade for the split harness implementations.

New code should import native execution from :mod:`nanoagent.harness.native`,
subprocess transport from :mod:`nanoagent.harness.subprocess`, and profile
construction from :mod:`nanoagent.harness.registry`.
"""

from nanoagent.harness.native import AgentFactory, NativeRunner
from nanoagent.harness.registry import RunnerProfile, RunnerRegistry, build_runner
from nanoagent.harness.subprocess import SubprocessRunner

__all__ = [
    "AgentFactory",
    "NativeRunner",
    "RunnerProfile",
    "RunnerRegistry",
    "SubprocessRunner",
    "build_runner",
]
