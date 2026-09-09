"""Offline regression test: a fanned-out :meth:`Agent.run` leaks no sandbox temp dir
(:meth:`nanoagent.core.agent.Agent.run`'s post-run ``cleanup`` hook).

The bug
-------
:class:`nanoagent.tools.code.CodeExec` holds its per-task sandbox dir in a per-asyncio-context
``ContextVar``, and :meth:`Agent.run` calls ``tool.reset()`` only at the START of each run.
``reset`` wipes the PRIOR same-context dir — fine for sequential reuse within one context. But the
production fan-out path (``batch.run_batch``, or a benchmark runner) runs ONE
shared :class:`CodeExec` across concurrent rollouts via ``asyncio.gather``, each rollout in its OWN
copied context. Each rollout runs exactly once there, so its start-of-run ``reset`` wipes nothing,
and nothing ever wipes the ``tempfile.mkdtemp("nanoagent-codetool-*")`` dir it created — N
fanned-out tasks leak N temp dirs per run (mkdtemp dirs are NOT auto-cleaned, so a long run
accumulates unboundedly).

The fix this pins
-----------------
:meth:`Agent.run` runs ``for tool in self._tools.values(): tool.cleanup()`` in a ``finally`` after
the run ends (any exit path), and :meth:`CodeExec.cleanup` removes this context's dir — so each
rollout frees the dir it created when it ends.

Non-vacuity
-----------
The test isolates the temp root by monkeypatching ``tempfile.tempdir`` to a pytest ``tmp_path``
(so the leftover count is deterministic under fleet load — it does NOT count global ``/tmp``), fans
out N rollouts over ONE shared :class:`CodeExec`, and FIRST asserts every rollout actually ran its
``python`` tool and created a distinct ``nanoagent-codetool-*`` dir under that root (so a "0
leftover dirs" pass can't be the vacuous "nothing ran / nothing created a dir"). It then asserts
ZERO such dirs remain. RED on the pre-fix tree (no post-run cleanup -> N dirs leak); GREEN after
the ``finally: cleanup()`` hook. Confirm non-vacuity by removing that ``finally`` in place: this
test goes RED.

What it consumes: :class:`nanoagent.core.agent.Agent` driven by an in-process scripted ChatModel + a
real :class:`nanoagent.tools.code.CodeExec` — mirrors ``test_agent_run_resets_tools`` /
``test_agent_cost_accumulate`` (no model server, network, or GPU).

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_run_cleans_up_sandbox.py -x -q
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import pytest

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.tools.code import CodeExec

_N_ROLLOUTS = 3
# The one program each rollout's scripted model runs: write a file into the sandbox cwd (forcing
# the per-task dir to be created) and print that cwd, so the test can confirm a dir was made.
_WRITE_AND_REPORT_CWD = "import os; open('out.txt', 'w').write('x'); print(os.getcwd())"


class _WriteThenAnswerModel:
    """Scripted :class:`~nanoagent.core.agent.ChatModel`: emit ONE ``python`` tool call, then answer.

    Stateless across runs — it decides from the conversation, not an instance counter — so a SINGLE
    instance safely drives N concurrent :meth:`Agent.run` (the production shape: ``run_batch``
    shares one agent + model). A turn whose ``messages`` carry no tool result yet emits the
    ``python`` call (whose code writes a file into the sandbox cwd, forcing the per-task dir to be
    created); the next turn (a ``role="tool"`` result is now present) returns a final answer, so each
    run ends on :attr:`~nanoagent.core.agent.StopReason.ANSWER` after exactly one tool call. Mirrors the
    in-process mocks in ``test_agent_cost_accumulate`` (incl. the ``on_delta`` kwarg the real model
    backend accepts); no server is contacted.
    """

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        if any(m.get("role") == "tool" for m in messages):
            return Reply(content="DONE")
        return Reply(
            content=None,
            tool_calls=[ToolCall(id="c1", name="python", arguments=json.dumps({"code": _WRITE_AND_REPORT_CWD}))],
        )


async def test_fanned_out_runs_leave_no_leaked_sandbox_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Isolate the temp root so the leftover-dir count is deterministic under fleet load (do NOT
    # count global /tmp): CodeExec creates its sandbox via tempfile.mkdtemp(prefix=...), which
    # honors tempfile.tempdir.
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    real_root = Path(os.path.realpath(tmp_path))  # mkdtemp's dir; getcwd() below returns a realpath

    # ONE shared CodeExec + ONE shared Agent across all rollouts — the production fan-out shape
    # (run_batch reuses one agent over many tasks via asyncio.gather, each in its own context).
    tool = CodeExec()
    agent = Agent(_WriteThenAnswerModel(), [tool], system_prompt="SYS", max_steps=5)

    results = await asyncio.gather(*(agent.run(f"task {i}") for i in range(_N_ROLLOUTS)))

    # (a) Non-vacuity: every rollout actually ran its python tool and created a sandbox dir, so the
    # "0 leftover dirs" assertion below can't be a vacuous "nothing ever created a dir".
    created: list[str] = []
    for r in results:
        assert r.stop_reason == StopReason.ANSWER
        assert len(r.tool_calls) == 1, f"expected one tool call, got {r.tool_calls}"
        call = r.tool_calls[0]
        assert call["name"] == "python" and call["is_error"] is False, call
        created.append(call["output"].strip())
    # The N rollouts created N DISTINCT nanoagent-codetool-* dirs under the isolated root — proves
    # the monkeypatch took effect and each context got its own dir (so leftovers, if any, land here).
    assert len(set(created)) == _N_ROLLOUTS, f"rollouts shared a dir: {created}"
    for d in created:
        p = Path(d)
        assert p.name.startswith("nanoagent-codetool-"), p
        assert p.parent == real_root, (p.parent, real_root)

    # (b) The fix: each rollout freed its own per-context sandbox dir in Agent.run's finally, so
    # ZERO nanoagent-codetool-* dirs remain. RED today (no cleanup -> N leak); GREEN after the hook.
    leaked = sorted(tmp_path.glob("nanoagent-codetool-*"))
    assert leaked == [], f"leaked {len(leaked)} sandbox dir(s): {leaked}"
