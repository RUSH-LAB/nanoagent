"""Compatibility facade for the split harness implementations.

New code should import NanoAgent execution from :mod:`nanoagent.harness.nanoagent`,
subprocess transport from :mod:`nanoagent.harness.subprocess`, and profile
construction from :mod:`nanoagent.harness.registry`.
"""

from nanoagent.harness.nanoagent import AgentFactory, NanoAgentRunner
from nanoagent.harness.registry import RunnerProfile, RunnerRegistry, build_runner
from nanoagent.harness.subprocess import SubprocessRunner

__all__ = [
    "AgentFactory",
    "NanoAgentRunner",
    "RunnerProfile",
    "RunnerRegistry",
    "SubprocessRunner",
    "build_runner",
]
