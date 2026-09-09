"""nanoagent — a minimal, clean-room agent loop with structured tool calling.

Public surface (the stdlib-only core — no ``openai`` import):
  * :class:`~nanoagent.core.agent.Agent` /
    :class:`~nanoagent.core.agent.AgentResult` — the model-agnostic loop, the ONLY one in
    the package (the ``chat`` REPL drives it too).
  * :class:`~nanoagent.core.tool.Tool` — a structured, JSON-Schema tool;
    :func:`~nanoagent.extensions.get_tools` loads them from tool-config YAMLs.

Dependencies point in one direction: ``cli`` and ``web`` drive ``runtime``; runtime assembles
``core`` with ``inference`` and optional ``tools``. The core imports none of those outer layers.
There is one agent loop and one model adapter, regardless of whether a batch, terminal, or web
request drives them.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from nanoagent.core import Agent, AgentResult, Reply, Tool, ToolCall


def get_tools(yaml_paths: Iterable[str | Path]) -> list[Tool]:
    """Load configured tools without importing the configuration stack until it is needed."""
    from nanoagent.extensions import get_tools as load_tools

    return load_tools(yaml_paths)

__version__ = "0.2.0"

__all__ = ["Agent", "AgentResult", "get_tools", "Reply", "Tool", "ToolCall"]
