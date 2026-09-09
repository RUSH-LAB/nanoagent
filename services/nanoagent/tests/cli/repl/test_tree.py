"""Offline tests for :mod:`nanoagent.cli.repl.tree` — the conversation as a tree of branches.

The properties that make branching worth having:

* **a fork is isolated** — work done on the child must not reach the parent, and switching back
  must find the parent exactly as it was. A shallow copy would pass a length check and fail this,
  since every message is a mutable dict the loop edits in place.
* **the live branch is the live list** — ``tree.messages`` IS the object :meth:`Agent.run
  <nanoagent.core.agent.Agent.run>` appends to, so nothing has to be copied back after a turn.
* **save/load round-trips the shape** — branches, parents and which one is current.
* **resume reads both formats** — a ``.session.json`` restores the tree; a ``.traj.json``
  (a batch rollout, or a chat from before this existed) restores its transcript as one branch.

Fully offline: no model, no server, ``tmp_path`` only.

Run (from the repo root)::

    python3 -m pytest tests/cli/repl/test_tree.py -x -q
"""

from __future__ import annotations

import json
from pathlib import Path

from nanoagent.cli.repl import tree as tree_mod
from nanoagent.runtime import trajectory
from nanoagent.core.agent import AgentResult, StopReason


def _tree() -> tree_mod.SessionTree:
    return tree_mod.SessionTree.start(
        [{"role": "system", "content": "SYS"}, {"role": "user", "content": "first"}]
    )


def test_a_fork_diverges_and_the_parent_is_untouched() -> None:
    tree = _tree()
    tree.messages.append({"role": "assistant", "content": "on main"})

    tree.fork("experiment")
    assert tree.current == 1
    tree.messages.append({"role": "user", "content": "only on the branch"})
    # Mutating a message in place is the case a shallow copy would leak through.
    tree.messages[2]["content"] = "rewritten"

    tree.switch(0)
    assert [m["content"] for m in tree.messages] == ["SYS", "first", "on main"]
    tree.switch(1)
    assert [m["content"] for m in tree.messages][-2:] == ["rewritten", "only on the branch"]


def test_the_live_branch_is_the_list_itself() -> None:
    # The agent loop appends to the list it was handed; the tree must not be holding a copy.
    tree = _tree()
    live = tree.messages
    live.append({"role": "assistant", "content": "appended by the loop"})
    assert tree.messages[-1]["content"] == "appended by the loop"


def test_switch_rejects_a_branch_that_does_not_exist() -> None:
    tree = _tree()
    try:
        tree.switch(3)
    except IndexError as e:
        assert "no branch 3" in str(e)
    else:  # pragma: no cover - the assertion below is the failure message
        raise AssertionError("switch(3) should have raised")


def test_save_and_load_round_trip_the_tree(tmp_path: Path) -> None:
    tree = _tree()
    tree.fork("a")
    tree.messages.append({"role": "user", "content": "branch a"})
    tree.switch(0)
    tree.fork("b")
    tree.switch(1)

    out = tree.save(tmp_path / "chat" / f"s{tree_mod.SESSION_SUFFIX}")
    assert out.exists()  # parent dirs created
    back = tree_mod.load(out)

    assert back.current == 1
    assert [n.label for n in back.nodes] == ["main", "a", "b"]
    assert [n.parent for n in back.nodes] == [None, 0, 0]
    assert back.messages[-1]["content"] == "branch a"


def test_summary_marks_the_current_branch() -> None:
    tree = _tree()
    tree.fork("a")
    lines = tree.summary()
    assert lines[0].startswith("  0  main (root,")
    assert lines[1].startswith("* 1  a (from 0,")


def test_resume_from_a_trajectory_gives_one_branch(tmp_path: Path) -> None:
    # The other accepted format: a saved rollout has no branches, so it restores as `main`.
    result = AgentResult(
        answer="42",
        messages=[{"role": "system", "content": "SYS"}, {"role": "user", "content": "q"}],
        tool_calls=[],
        steps=1,
        stop_reason=StopReason.ANSWER,
    )
    path = trajectory.save(result, tmp_path / f"r{trajectory.TRAJECTORY_SUFFIX}")

    tree = tree_mod.load(path)
    assert len(tree.nodes) == 1 and tree.nodes[0].label == "main"
    assert [m["content"] for m in tree.messages] == ["SYS", "q"]


def test_the_session_file_is_plain_json(tmp_path: Path) -> None:
    # No cycles: parents are indices, which is what lets the tree serialize at all.
    tree = _tree()
    tree.fork()
    data = json.loads(tree.save(tmp_path / f"s{tree_mod.SESSION_SUFFIX}").read_text())
    assert data["session_format"] == "nanoagent-1"
    assert data["nodes"][1]["parent"] == 0 and data["nodes"][1]["label"] == "branch 1"


def test_the_repl_commands_drive_the_tree() -> None:
    # /fork, /branches and /switch at any prompt: each re-prompts (they are not tasks), so the
    # only thing _read returns is the plain line typed last.
    import io

    from nanoagent.cli.repl.app import InteractiveSession
    from rich.console import Console

    console = Console(file=io.StringIO(), width=200)
    lines = iter(["/fork try-it", "/branches", "/switch 0", "/switch 9", "hello"])
    repl = InteractiveSession(
        model=None,  # type: ignore[arg-type]
        tools=[],
        system_prompt="SYS",
        reader=lambda _p: next(lines),
        console=console,
    )
    assert repl._read("> ") == "hello"

    assert [n.label for n in repl._tree.nodes] == ["main", "try-it"]
    assert repl._tree.current == 0  # /switch 0 moved back; /switch 9 was refused
    out = console.file.getvalue()  # type: ignore[attr-defined]
    assert "forked to branch 1" in out and "no branch 9" in out
    assert "* 1  try-it (from 0," in out  # /branches listed the fork as current at the time
