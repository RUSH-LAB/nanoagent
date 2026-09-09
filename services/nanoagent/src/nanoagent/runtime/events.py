"""A run as a stream of JSON lines, for anything watching from outside the process.

The trajectory file is the *outcome*; this is the play-by-play. One NDJSON object per line, four
kinds, in the order a step produces them::

    {"type": "delta", "kind": "content"|"reasoning", "text": "..."}   # a streamed fragment
    {"type": "tool",  "name": ..., "arguments": {...}, "output": ..., "is_error": false}
    {"type": "step",  "step": 3, "usage": {...}, "cost": 0.01}        # a turn finished
    {"type": "done",  "stop_reason": "answer", "answer": ..., ...}    # the run finished

A delta carries ONLY its fragment, never the message so far. Pi shipped the cumulative form and
had to remove it in 0.84.0: re-sending the whole message with every token makes the stream grow
quadratically in the length of the reply, which is exactly the regime a long agent turn is in.

Everything is derived from the two callbacks :meth:`Agent.run <nanoagent.core.agent.Agent.run>` already
takes, so nothing here needs a new seam in the loop: ``on_delta`` gives the fragments, and each
``on_step`` snapshot carries the whole ``tool_calls`` log, so the tool events are the rows that
were not in the previous snapshot. Deriving them beats an ``after_tool`` hook because the writer
then has one input, and one place where ordering is decided.

One writer serves a whole batch: the file is shared, every line is stamped with the run's
``label`` (the task id), and each run gets its own :class:`RunEvents` from :meth:`begin` so the
"which rows have I emitted" counter is per-rollout — the same reason :class:`~nanoagent.core.hooks.Hooks`
hands out a :class:`~nanoagent.core.hooks.RunHooks`. Writes are plain ``write`` calls with no ``await``
inside, so concurrent rollouts cannot interleave half a line.

Off by default: ``events: null`` builds no writer and :meth:`Agent.run` never checks again.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from nanoagent.core.agent import AgentResult


class EventWriter:
    """An open NDJSON stream. Created once per run *config*, shared by every rollout in it."""

    def __init__(self, path: str | Path) -> None:
        file = Path(path)
        file.parent.mkdir(parents=True, exist_ok=True)
        # Append, not truncate: a resumed batch adds to its results ledger, and the event log is
        # the same kind of record. Line buffering makes each event durable as it is written, so a
        # watcher tailing the file sees a crashed run's last events.
        self._file = file.open("a", buffering=1, encoding="utf-8")

    def begin(self, label: str | None) -> RunEvents:
        """This rollout's view of the stream: same file, own tool cursor, ``label`` on every line."""
        return RunEvents(self.emit, label)

    def emit(self, label: str | None, **event: Any) -> None:
        self._file.write(json.dumps({**event, "label": label}, default=str) + "\n")

    def close(self) -> None:
        self._file.close()


class RunEvents:
    """Project agent callbacks into normalized events for any sink."""

    def __init__(self, emit: Callable[..., None], label: str | None) -> None:
        self._emit = emit
        self._label = label
        self._emitted_tools = 0

    def on_delta(self, kind: str, text: str) -> None:
        self._emit(self._label, type="delta", kind=kind, text=text)

    def on_step(self, result: AgentResult) -> None:
        from nanoagent.core.agent import StopReason

        for row in result.tool_calls[self._emitted_tools :]:
            self._emit(self._label, type="tool", **row)
        self._emitted_tools = len(result.tool_calls)
        if result.stop_reason is StopReason.RUNNING:
            self._emit(
                self._label, type="step", step=result.steps, usage=result.usage, cost=result.cost
            )
        else:
            self._emit(
                self._label,
                type="done",
                stop_reason=result.stop_reason.value,
                answer=result.answer,
                steps=result.steps,
                usage=result.usage,
                cost=result.cost,
                error=result.error,
            )

    def tee(self, on_step: Callable[[AgentResult], None] | None) -> Callable[[AgentResult], None]:
        """``on_step``, with this stream's copy taken first. The caller's callback still runs."""
        if on_step is None:
            return self.on_step

        def both(result: AgentResult) -> None:
            self.on_step(result)
            on_step(result)

        return both

    def tee_delta(self, on_delta: Callable[[str, str], None]) -> Callable[[str, str], None]:
        def both(kind: str, text: str) -> None:
            self.on_delta(kind, text)
            on_delta(kind, text)

        return both
