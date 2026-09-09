"""Pin Agent.run's terminal answer = ``last_assistant_text`` on the TOKEN_LIMIT path.

nanoagent is the ROLLOUT layer, and flow control names a per-rollout TOKEN cap
(tokens/turns/wall-clock) to bound worst-case task time. When the
token cap stops the loop there is no clean final reply, so
:meth:`~nanoagent.core.agent.Agent.run` surfaces a best-effort answer via
:func:`~nanoagent.core.agent.last_assistant_text` — the last assistant message that carried
content. The sibling COST_LIMIT and MAX_STEPS uses of this are pinned for the *answer* by
``test_agent_limit_answer_text.py``, but TOKEN_LIMIT was left out: ``test_agent_token_limit.py``
asserts ``stop_reason``/``steps``/``usage``/``turns`` and its ``_NeverAnswersModel`` emits
``content=None`` (so ``last_assistant_text`` returns ``""`` regardless and ``answer`` is never
checked). Consequently a mutation hardcoding the TOKEN_LIMIT terminal answer to ``""`` survives
the whole suite. This file drives the complement: a scripted model that emits assistant
``content`` on every tool-call turn but never a final answer, so ``assistant_message``
preserves that content and the terminal ``last_assistant_text`` returns it.

  * TOKEN_LIMIT — ``token_limit`` below the per-turn tokens; one turn runs (tokens cross the
    cap), then the top-of-loop guard trips and returns ``StopReason.TOKEN_LIMIT`` with that
    turn's assistant text as the answer.

Non-vacuity (prove by mutation, then revert): replacing the TOKEN_LIMIT branch's
``last_assistant_text(messages)`` with ``""`` fails this test, and the rest of the
``src/nanoagent`` suite stays green (the existing token-limit tests never assert ``answer``).

Everything is in-process: a scripted :class:`_ProgressModel` and a no-op tool; no model
server, GPU, or network. Mirrors ``test_agent_limit_answer_text._ProgressModel`` (incl. the
``on_delta`` kwarg the model backend accepts), but charges ``total_tokens`` instead of ``cost``.

Run (from the repo root)::

    python3 -m pytest tests/core/test_agent_token_limit_answer_text.py -x -q
"""

from __future__ import annotations

from typing import Any

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.core.tool import JsonSchema, Tool

# The assistant content the model carries every turn; the same value the cap-path answer must
# surface, so coupling both sides to one constant pins "answer == the last assistant text".
_PARTIAL = "partial progress"


class _NoopTool(Tool):
    """A no-op tool: the scripted model's calls dispatch here so a turn can complete."""

    NAME = "noop"
    PARAMETERS: JsonSchema = {"type": "object", "properties": {}}

    def run(self) -> str:
        return "ok"


class _ProgressModel:
    """A scripted :class:`~nanoagent.core.agent.ChatModel` that carries content but NEVER answers.

    Every ``query`` returns one ``noop`` tool call AND non-empty ``content`` (``_PARTIAL``), so
    the loop can only end on a cap while each turn leaves a content-bearing assistant message for
    ``last_assistant_text`` to surface. Each turn reports ``total_tokens`` so this test can drive
    the token guard. Mirrors ``test_agent_token_limit._NeverAnswersModel`` (incl. the ``on_delta``
    kwarg the model backend passes), differing only in carrying ``content``; no server is
    contacted.
    """

    def __init__(self, *, total_tokens: int = 0) -> None:
        self._total_tokens = total_tokens
        self.turns = 0

    async def query(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        on_delta: Any = None,
    ) -> Reply:
        self.turns += 1
        return Reply(
            content=_PARTIAL,
            tool_calls=[ToolCall(id=f"c{self.turns}", name="noop", arguments="{}")],
            usage={"total_tokens": self._total_tokens},
        )


async def test_token_limit_terminal_answer_is_last_assistant_text() -> None:
    # token_limit (50) is below the per-turn tokens (100): turn 0 runs (total_tokens -> 100,
    # crossing the cap), then the top-of-loop guard trips on turn 1. The terminal answer is the
    # best-effort last assistant text from the completed turn, not "".
    model = _ProgressModel(total_tokens=100)
    result = await Agent(model, [_NoopTool()], system_prompt="SYS", max_steps=10, token_limit=50).run("go")
    assert result.stop_reason == StopReason.TOKEN_LIMIT
    assert result.answer == _PARTIAL  # last_assistant_text(messages), not a hardcoded ""
