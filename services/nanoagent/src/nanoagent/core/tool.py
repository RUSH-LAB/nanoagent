"""A structured tool an LLM agent can call.

A :class:`Tool` is a self-describing class: set :attr:`NAME` and :attr:`PARAMETERS`
(an explicit JSON Schema for the arguments), implement a ``run`` method, and the class
docstring becomes the description the model sees. The agent
(:mod:`nanoagent.core.agent`) advertises tools to the model as OpenAI function
specs via :meth:`Tool.to_openai_spec`, and dispatches the model's tool calls by name to
:meth:`Tool.invoke`, which runs ``run`` (sync or async) and turns any exception into an
error string the model can recover from.

The ``parameters`` schema is declared explicitly (not derived from ``run``'s signature)
so the wire schema the model sees is exactly what we intend.

Tool manifests and extension modules are loaded outside the core by
:func:`nanoagent.extensions.get_tools`.

Clean-room: deliberately independent of ``thirdeye``'s ``Tool`` — this package does
not import thirdeye.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Sequence
from typing import Any


# A JSON Schema fragment describing a tool's arguments object. Kept permissive
# (a plain dict) because providers accept vendor-specific keywords we don't want
# to enumerate.
JsonSchema = dict[str, Any]


class Tool:
    """A callable the agent can invoke, defined as a self-describing subclass.

    Subclass it, set :attr:`NAME` and :attr:`PARAMETERS` (the JSON Schema), and write a
    ``run`` method — the class docstring becomes the description the model sees. This
    keeps a tool's name, schema, description and implementation in one place. ``run`` may
    be sync or async, receives keyword arguments matching ``PARAMETERS``, and should
    return something stringifiable — its ``str()`` becomes the tool-result text fed back
    to the model.

    ``run`` is a plain method that raises rather than an ``@abstractmethod``: tools have
    heterogeneous signatures (``run(command)`` vs ``run(a, b)``), and a typed abstract
    method would reject those as inconsistent overrides under the type checker. The
    fully-variadic base signature documents the contract while leaving each tool's
    ``run`` free to take its own named, typed arguments; the ``NotImplementedError``
    makes a missing implementation fail loudly instead of at attribute lookup.
    """

    NAME: str
    PARAMETERS: JsonSchema

    # to_openai_spec() caches its result here: the spec is a pure function of state that is
    # immutable after construction, so it is built once (lazily, on first call) and the same
    # object returned afterward. The class-level None is just the not-yet-built sentinel.
    _openai_spec: dict[str, Any] | None = None

    def run(self, *args: Any, **kwargs: Any) -> Any:
        """The tool's logic; required — subclasses override with their own typed args.

        Receives keyword arguments matching ``PARAMETERS``, may be sync or async, and
        should return something stringifiable (its ``str()`` is fed back to the model).
        """
        raise NotImplementedError(f"{type(self).__name__} must implement run()")

    def reset(self) -> None:
        """Drop any per-task state before a new :meth:`Agent.run`.

        No-op by default. Stateful tools (e.g. one carrying a per-task retrieval
        budget) override this so their state never leaks across tasks; the agent
        loop calls it once at the start of every run.
        """

    def cleanup(self) -> None:
        """Release any per-task resources after an :meth:`Agent.run` ends.

        No-op by default. Stateful tools (e.g. one holding a per-task sandbox
        dir) override this so their resources never linger past a task; the agent
        loop calls it once in a ``finally`` at the end of every run. Counterpart of
        :meth:`reset`, which clears state BEFORE a run; ``cleanup`` releases it AFTER.
        """

    def bind(self, agent: Any) -> None:
        """Receive the :class:`~nanoagent.core.agent.Agent` this tool was given to.

        No-op by default, called once from ``Agent.__init__`` (and from
        :meth:`~nanoagent.core.agent.Agent.add_tool`). The only way a tool can reach back into
        its agent — :mod:`nanoagent.tools.write` needs it to register the tools it writes.
        """

    @property
    def name(self) -> str:
        return self.NAME

    @property
    def description(self) -> str:
        return (self.__doc__ or "").strip()

    @property
    def parameters(self) -> JsonSchema:
        return self.PARAMETERS

    def to_openai_spec(self) -> dict[str, Any]:
        """Render as one entry of an OpenAI chat-completions ``tools=[...]`` list.

        Built lazily once per instance and cached, so the same object is returned on every
        call instead of rebuilding the dict each time. Safe because the spec is a pure
        function of post-construction state and every consumer only reads it.
        """
        spec = self._openai_spec
        if spec is None:
            spec = {
                "type": "function",
                "function": {
                    "name": self.name,
                    "description": self.description,
                    "parameters": self.parameters,
                },
            }
            self._openai_spec = spec
        return spec

    async def invoke(self, **arguments: Any) -> tuple[str, bool]:
        """Run ``run(**arguments)`` (awaiting if async); return ``(text, is_error)``.

        An ``async def run`` is awaited inline. A SYNCHRONOUS ``run`` is offloaded to a worker
        thread via :func:`asyncio.to_thread` so a blocking tool — a sync search client, or
        ``Bash``/``CodeExec``'s multi-second ``subprocess`` calls — does NOT freeze the event
        loop and stall every other rollout dispatched concurrently under ``asyncio.gather``. A
        sync ``run`` that returns an awaitable is still awaited, after the thread returns.
        Behavior is otherwise identical to running ``run`` inline: same result text and same
        exception handling.

        Exceptions are caught and returned as ``"Error: {ExcType}: {msg}"`` with
        ``is_error=True`` so the agent can feed the error back and let the model
        recover, rather than crashing the whole run.
        """
        try:
            if inspect.iscoroutinefunction(self.run):
                result = await self.run(**arguments)
            else:
                result = await asyncio.to_thread(self.run, **arguments)
                if inspect.isawaitable(result):
                    result = await result
            return str(result), False
        except Exception as e:
            return f"Error: {type(e).__name__}: {e}", True


def build_tool_map(tools: Sequence[Tool]) -> dict[str, Tool]:
    """Index ``tools`` by ``.name``; raise ``ValueError`` naming the collider(s) on a duplicate NAME.

    A colliding toolset is silently lossy (one tool shadows the other), so both
    :class:`~nanoagent.core.agent.Agent` and :class:`~nanoagent.cli.repl.app.InteractiveSession` build
    their dispatch dict through here and reject it up front.
    """
    by_name = {t.name: t for t in tools}
    if len(by_name) != len(tools):
        names = [t.name for t in tools]
        dupes = sorted({n for n in names if names.count(n) > 1})
        raise ValueError(f"duplicate tool name in `tools`: {', '.join(repr(d) for d in dupes)}")
    return by_name
