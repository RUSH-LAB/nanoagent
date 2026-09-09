"""Branching conversations: a session is a tree of transcripts, not one list.

A chat transcript is already just a ``list[dict]`` that :meth:`Agent.run
<nanoagent.core.agent.Agent.run>` appends to in place, so a branch is a copy of that list and a tree is
a list of copies plus a pointer. That is the whole of :class:`SessionTree`. It buys the thing a
single transcript cannot do: try an approach, see it go wrong, and go back to *before* it without
losing the good half of the session, or explore two answers to the same question side by side.

Nodes are flat and reference their parent by index, so the tree serializes as plain JSON with no
cycles and ``/branches`` is a list comprehension. ``fork`` deep-copies rather than sharing: the
whole point is that what happens in the child must not reach the parent, and every message the
loop touches is a mutable dict.

Resume reads either format. A ``.session.json`` written by :meth:`save` restores the branches;
a ``.traj.json`` from :mod:`nanoagent.runtime.trajectory` — a batch rollout, or an older chat — restores
its transcript as a single-node tree, so a run you want to pick up is resumable whether or not it
was a chat.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SESSION_SUFFIX = ".session.json"


@dataclass
class Node:
    """One branch: its transcript, the branch it was forked from, and a name for the human."""

    messages: list[dict[str, Any]]
    parent: int | None
    label: str


@dataclass
class SessionTree:
    """The session's branches and which one is live.

    :attr:`messages` is the LIVE list — the same object the agent loop mutates — so nothing has
    to be copied back after a turn.
    """

    nodes: list[Node]
    current: int = 0

    @classmethod
    def start(cls, messages: list[dict[str, Any]]) -> SessionTree:
        return cls([Node(messages, None, "main")])

    @property
    def messages(self) -> list[dict[str, Any]]:
        return self.nodes[self.current].messages

    def fork(self, label: str | None = None) -> int:
        """Branch off the current transcript and switch to the copy. Returns its index."""
        index = len(self.nodes)
        self.nodes.append(
            Node(copy.deepcopy(self.messages), self.current, label or f"branch {index}")
        )
        self.current = index
        return index

    def switch(self, index: int) -> None:
        if not 0 <= index < len(self.nodes):
            raise IndexError(f"no branch {index}; there are {len(self.nodes)}")
        self.current = index

    def summary(self) -> list[str]:
        """One ``* 2  branch 2 (from 0, 7 messages)`` line per branch, current one starred."""
        lines = []
        for i, node in enumerate(self.nodes):
            origin = "root" if node.parent is None else f"from {node.parent}"
            mark = "*" if i == self.current else " "
            lines.append(f"{mark} {i}  {node.label} ({origin}, {len(node.messages)} messages)")
        return lines

    def save(self, path: str | Path) -> Path:
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    "session_format": "nanoagent-1",
                    "current": self.current,
                    "nodes": [
                        {"messages": n.messages, "parent": n.parent, "label": n.label}
                        for n in self.nodes
                    ],
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        return out


def load(path: str | Path) -> SessionTree:
    """Restore a tree from a ``.session.json``, or a single branch from a ``.traj.json``."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if "nodes" not in data:  # a trajectory: one transcript, so one branch
        return SessionTree.start(data["messages"])
    nodes = [Node(n["messages"], n["parent"], n["label"]) for n in data["nodes"]]
    return SessionTree(nodes, data["current"])
