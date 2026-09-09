"""Offline test: a timed-out rollout's ``<task>.traj.json`` is reconciled to the ledger.

An overrunning rollout must be killed and scored zero, and the finished ``<task>.traj.json``
is the artifact the scorer and the trainer consume. On the wall-clock-cap
path :func:`~nanoagent.runtime.batch.run_batch` kills a rollout via ``asyncio.wait_for(agent.run(...),
timeout)``; the cancellation arrives as ``asyncio.CancelledError`` — a ``BaseException``, NOT an
``Exception`` — so :meth:`Agent.run`'s terminal ``except Exception`` is bypassed and its ERROR step
(which would write ``stop_reason="error"``/``error=...`` into the traj) never runs. The reconciling
``run_one`` ``except`` must therefore fold the terminal state into the last-saved traj itself.

Everything here is in-process — no model server, GPU, or network is contacted. A scripted
:class:`~nanoagent.core.agent.ChatModel` asks for a tool call every turn; a scripted :class:`Tool`
returns fast on call 1 (so one agent step completes and the traj is saved with
``stop_reason="running"``) then blocks on ``asyncio.sleep`` on call 2, so the ``timeout=0.3`` cap
fires mid-dispatch and cancels the rollout.

* ``test_run_batch_timeout_reconciles_traj_stop_reason`` — after the cap fires, the ``<task>.traj.json``
  (via :func:`~nanoagent.runtime.trajectory.load`) reads ``stop_reason == "error"`` and ``error`` starting
  ``"timeout:"``, matching the returned ledger row; AND the transcript captured before the cap (the
  one completed step's messages + tool call, ``output == "fast result"``) is preserved, never
  truncated.

Non-vacuity: against the ORIGINAL code the ``run_one`` ``except`` only patched ``logs``, leaving the
traj at ``stop_reason: "running"``, ``error: null`` — so the ``stop_reason == "error"`` assertion
FAILS (RED). It passes (GREEN) only once ``update_logs`` also writes the terminal stop_reason/error.

Run (from the repo root)::

    python3 -m pytest tests/runtime/test_run_batch_timeout_traj_stop_reason.py -q
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from nanoagent.runtime import batch, trajectory
from nanoagent.core.agent import Agent, Reply, ToolCall
from nanoagent.core.tool import Tool


class _SlowSecondCallTool(Tool):
    """Returns fast on the first call, then blocks on ``asyncio.sleep`` on later calls.

    The fast first call lets one agent step complete and save the trajectory; the second call
    blocks well past the cap so the wall-clock timeout cancels the rollout mid-step.
    """

    NAME = "slow_tool"
    PARAMETERS: dict[str, Any] = {"type": "object", "properties": {}}

    def __init__(self) -> None:
        self._calls = 0

    async def run(self) -> str:
        self._calls += 1
        if self._calls == 1:
            return "fast result"
        await asyncio.sleep(5)
        return "slow result"


class _SlowSecondStepModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` that requests ``slow_tool`` every turn.

    Turn 1's tool call returns fast (the step completes and the traj is saved with
    ``stop_reason="running"``); turn 2's tool call blocks inside the tool, so the cap fires while
    that dispatch is awaiting and cancels :meth:`Agent.run`. No model server is contacted.
    """

    def __init__(self) -> None:
        self._turn = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self._turn += 1
        return Reply(
            content=f"calling slow_tool (turn {self._turn})",
            tool_calls=[ToolCall(id=f"c{self._turn}", name="slow_tool", arguments="{}")],
            usage={"prompt_tokens": 1, "total_tokens": 1},
        )


async def test_run_batch_timeout_reconciles_traj_stop_reason(tmp_path: Path) -> None:
    # One rollout: step 1 completes (traj saved as "running"), step 2 blocks 5s and is capped at
    # 0.3s — asyncio.wait_for cancels agent.run via CancelledError, bypassing its ERROR step.
    agent = Agent(_SlowSecondStepModel(), [_SlowSecondCallTool()], system_prompt="SYS", max_steps=5)
    rows = await batch.run_batch([("t1", "go")], agent=agent, output_dir=tmp_path, timeout=0.3)

    # The ledger row records the kill as a score-zero timeout error.
    assert len(rows) == 1
    row = rows[0]
    assert row["stop_reason"] == "error"
    assert row["error"].startswith("timeout:")

    # The traj file is reconciled to MATCH the ledger (the bug left it at "running"/null).
    traj = trajectory.load(tmp_path / trajectory.TRAJECTORIES_DIRNAME / f"t1{trajectory.TRAJECTORY_SUFFIX}")
    assert traj["stop_reason"] == "error"
    assert traj["error"].startswith("timeout:")
    assert traj["error"] == row["error"]

    # The fix corrects only the terminal fields — the transcript captured before the cap (the one
    # completed step) is preserved, never truncated: system + user + assistant(tool call) + the
    # fast tool result. The single dispatched call is captured inline on the transcript
    # (nanoagent-2: no separate tool_calls array) — the tool message carries its output + is_error.
    assert [m["role"] for m in traj["messages"]] == ["system", "user", "assistant", "tool"]
    assert "tool_calls" not in traj
    tool_msg = traj["messages"][-1]
    assert tool_msg["content"] == "fast result"
    assert tool_msg["is_error"] is False
