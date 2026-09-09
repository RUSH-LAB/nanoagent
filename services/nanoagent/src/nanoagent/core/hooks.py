"""Lifecycle hooks: change what a run does without editing the agent loop.

A hook module is a plain ``.py`` defining any subset of four functions, named after the moment
they fire. It is declared by a YAML that names it, exactly like a tool
(``code: path/to/hook.py``), and loaded by :func:`nanoagent.extensions.get_hooks`.

.. code-block:: python

    def session_start(ctx) -> None          # once, before the first model turn
    def before_llm(ctx)   -> str | None     # str -> appended as a user turn before the query
    def before_tool(ctx)  -> str | None     # str -> SHORT-CIRCUITS the call and becomes its result
    def after_tool(ctx)   -> None           # observe the result

Two of them can steer the run, and that is the point. ``before_tool`` turns a rule the system
prompt merely *asks* for into one the harness *enforces* — the bm25_v1 harness says "Call search
AT MOST ONCE" in prose and its own comment admits "the tools stay general and enforce nothing";
a hook counting calls in :attr:`HookContext.state` makes the budget real, for every rollout,
without a bespoke tool. ``before_llm`` injects a reminder the same way.

Off is free: ``hooks: []`` makes :func:`nanoagent.extensions.get_hooks` return ``None`` and every call site in
:mod:`nanoagent.core.agent` is a ``None`` check, so a run that configures no hooks executes the code
path it did before they existed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# The four moments, in the order a step visits them. A hook module defines the ones it cares
# about and omits the rest.
TRIGGERS = ("session_start", "before_llm", "before_tool", "after_tool")


@dataclass
class HookContext:
    """What a hook is told, and the one thing it may keep.

    ``messages`` is the live transcript (the same list the loop appends to), so a hook can read
    everything said so far. ``state`` is a plain dict scoped to ONE :meth:`Agent.run
    <nanoagent.core.agent.Agent.run>` and shared by every trigger in it — where a per-run counter such
    as a retrieval budget lives. The tool fields are set only for the tool triggers.
    """

    trigger: str
    messages: list[dict[str, Any]]
    step: int
    state: dict[str, Any]
    tool_name: str | None = None
    tool_input: dict[str, Any] = field(default_factory=dict)
    tool_output: str | None = None
    is_error: bool = False


class Hooks:
    """The hook modules of one config, dispatched as if they were a single hook.

    Holds no run state: one :class:`~nanoagent.core.agent.Agent` is shared across concurrent
    rollouts, so a counter living here would be a budget K rollouts spend from at once. Each
    :meth:`Agent.run <nanoagent.core.agent.Agent.run>` calls :meth:`begin` for its own.
    """

    def __init__(self, modules: list[Any]) -> None:
        self._by_trigger = {
            trigger: [fn for m in modules if callable(fn := getattr(m, trigger, None))]
            for trigger in TRIGGERS
        }

    def begin(self, messages: list[dict[str, Any]]) -> RunHooks:
        """This run's handle: the same dispatch table, a fresh :attr:`HookContext.state`."""
        return RunHooks(self._by_trigger, {}, messages)


@dataclass
class RunHooks:
    """One run's view of the hooks. Created by :meth:`Hooks.begin`, never directly.

    Carries the run's transcript so the loop does not have to thread it down to the tool
    dispatch, which is several frames below where it is in scope.
    """

    _by_trigger: dict[str, list[Any]]
    state: dict[str, Any]
    messages: list[dict[str, Any]]

    def fire(self, trigger: str, **fields: Any) -> str | None:
        """Run every hook registered for ``trigger``; return the FIRST non-``None`` string.

        First-wins rather than last: a hook that refuses a tool call or injects a reminder has
        already decided the outcome, and running the rest to overwrite it would make the result
        depend on YAML order in a way nobody could reason about.
        """
        ctx = HookContext(trigger=trigger, state=self.state, messages=self.messages, **fields)
        for fn in self._by_trigger[trigger]:
            out = fn(ctx)
            if out is not None:
                return str(out)
        return None
