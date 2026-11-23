"""Which agent sent a request, from what the request itself shows: its wire dialect and the names of its tools (never a header
the gateway may rewrite). Used by `Router`, whose one URL serves every harness of a worker."""

from __future__ import annotations

from .engine import ParsedRequest

DIALECTS = {"claude": "anthropic", "codex": "responses"}
# The action renderer (actions.py) of each harness: NanoAgent in the shell is the `mgen` CLI, with its own bash tool.
RENDERERS = {"nanoagent": "mgen"}


def dialect_of(harness: str) -> str:
    """The wire dialect a harness speaks (`chat` unless it is Claude Code's or Codex's)."""
    return DIALECTS.get(harness, "chat")


def harness_of(request: ParsedRequest) -> str:
    names = {tool.name for tool in request.tools}
    if request.dialect != "chat":
        return {"anthropic": "claude", "responses": "codex"}[request.dialect]
    # The chat-completions agents, told apart by a tool only that agent has (or, PI, by having exactly the four).
    for harness, tool in (("hermes", "terminal"), ("dsh", "job_kill"), ("nanoagent", "python")):
        if tool in names:
            return harness
    return "pi" if names == {"bash", "edit", "read", "write"} else f"unknown agent with tools {sorted(names)}"
