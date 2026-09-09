"""The live batch display — :func:`~nanoagent.runtime.batch.run_batch`'s three callbacks, rendered.

``run_batch`` reports through ``on_start(pending)`` / ``on_step(task_id, result)`` /
``on_done(row)`` and knows nothing about how they are drawn. This module is the one renderer:
a Rich ``Live`` showing, per in-flight task, a step bar plus the model's freshest line, under a
header carrying the done/pending count and a running ``stop_reason`` tally.

Used as a context manager, which is what owns the live display::

    with BatchProgress(console, max_steps=cfg.agent.max_steps, shown=cfg.concurrency) as bar:
        rows = asyncio.run(run_batch(..., on_start=bar.on_start, on_step=bar.on_step,
                                     on_done=bar.on_done))
    print(format_tally(bar.tally))
"""

from __future__ import annotations

from collections import Counter
from types import TracebackType
from typing import Any

from nanoagent.core.agent import AgentResult, StopReason
from rich.console import Console, Group
from rich.live import Live
from rich.progress_bar import ProgressBar
from rich.table import Table
from rich.text import Text


def format_tally(tally: Counter[str]) -> str:
    """Render a stop_reason ``Counter`` as a deterministic ``k=v`` string (sorted by key, two-space separator)."""
    return "  ".join(f"{k}={v}" for k, v in sorted(tally.items()))


def _last_line(text: str | None) -> str:
    """The last non-blank line of ``text`` (stripped), or ``""`` if there is none."""
    lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    return lines[-1].strip() if lines else ""


def _msg_last_line(msg: dict[str, Any]) -> str:
    """The last non-blank line of one chat message's text content (``""`` if it has none)."""
    content = msg.get("content")
    if isinstance(content, list):  # some providers chunk content into [{type,text},...]
        content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return _last_line(content if isinstance(content, str) else "")


def _step_snippet(result: AgentResult) -> str:
    """The freshest text line to show for this step — the model's own words first.

    Prefers the most recent assistant turn carrying text (what the model just said / decided);
    falls back to the latest message with any text (e.g. a tool result) when no assistant turn
    has text yet, so the snippet line is never empty mid-run.
    """
    fallback = ""
    for msg in reversed(result.messages):
        if line := _msg_last_line(msg):
            if msg.get("role") == "assistant":
                return line  # assistant-with-text wins immediately
            fallback = fallback or line  # else keep the LATEST any-text line
    return fallback


class BatchProgress:
    """Renders a batch run's progress; its :meth:`on_start` / :meth:`on_step` / :meth:`on_done` are the hooks.

    ``shown`` bounds how many task blocks are drawn at once — pass the batch concurrency, so
    every in-flight task is visible without scrolling. ``max_steps`` is each bar's total until
    the task finishes (at which point its real step count becomes the total, so a task that
    answered early still renders 100%).
    """

    def __init__(self, console: Console, *, max_steps: int, shown: int) -> None:
        self.tally: Counter[str] = Counter()
        self._console = console
        self._max_steps = max_steps
        self._shown = shown
        # `_state[task_id]` is each task's latest snapshot; `_order` lists task_ids
        # most-recently-updated first, so we render only the `shown` freshest. `_totals` tracks
        # the header counts.
        self._state: dict[str, dict[str, Any]] = {}
        self._order: list[str] = []
        self._totals = {"pending": 0, "done": 0}
        self._live = Live(self._render(), console=console, refresh_per_second=10)

    def __enter__(self) -> BatchProgress:
        self._live.__enter__()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool | None:
        return self._live.__exit__(exc_type, exc, tb)

    def _render(self) -> Group:
        head = f"batch {self._totals['done']}/{self._totals['pending'] or '?'}"
        if t := format_tally(self.tally):
            head = f"{head}  {t}"
        blocks: list[Any] = [Text(head, style="bold")]
        # Running tasks first (on_step fires only after a step finishes, so a slow LLM call
        # gets no fresh update and would otherwise be bumped out by quickly-finishing done
        # tasks), then done tasks. Within each group preserve `_order`'s freshness.
        running = [tid for tid in self._order if self._state[tid]["status"] == StopReason.RUNNING]
        finished = [tid for tid in self._order if self._state[tid]["status"] != StopReason.RUNNING]
        for task_id in (running + finished)[: self._shown]:
            s = self._state[task_id]
            bar = Table.grid(padding=(0, 1))  # one task = a bar line ...
            bar.add_row(
                Text(f"[{task_id}]", style="cyan"),
                ProgressBar(total=s["total"], completed=s["completed"], width=28),
                Text(f"{s['completed']}/{s['total']} {s['status']}"),
                Text(f"llm={s['model_time']:.1f}s tool={s['tools_time']:.1f}s", style="green"),
            )
            # ... then a separate snippet line (clipped to one terminal line; Text takes the
            # string literally, so bracketed tokens in tool/model output can't corrupt markup).
            blocks.append(bar)
            blocks.append(Text(f"    {s['snippet']}", style="dim", no_wrap=True, overflow="ellipsis"))
        return Group(*blocks)

    def _show(
        self,
        task_id: str,
        *,
        completed: int,
        total: int,
        status: str,
        snippet: str,
        model_time: float,
        tools_time: float,
    ) -> None:
        self._state[task_id] = {
            "completed": completed,
            "total": total,
            "status": status,
            "snippet": snippet,
            "model_time": model_time,
            "tools_time": tools_time,
        }
        if task_id in self._order:
            self._order.remove(task_id)
        self._order.insert(0, task_id)  # most-recently-updated first
        self._live.update(self._render())

    def on_start(self, pending: int) -> None:
        """The run's pending-task count is only known after resume filtering — set the header."""
        self._totals["pending"] = pending
        self._live.update(self._render())

    def on_step(self, task_id: str, result: AgentResult) -> None:
        """Per step: bar = steps so far, snippet = the model's freshest line."""
        done = result.stop_reason != StopReason.RUNNING
        self._show(
            task_id,
            completed=result.steps,
            total=max(result.steps, 1) if done else self._max_steps,
            status=str(result.stop_reason),
            snippet=_step_snippet(result),
            # Running totals so far: LLM (model query) vs tool dispatch (the search calls).
            model_time=sum(d["model"] for d in result.step_durations),
            tools_time=sum(d["tools"] for d in result.step_durations),
        )

    def on_done(self, row: dict[str, Any]) -> None:
        """Fold the finished row into the tally and finalize its block.

        Also covers the exception path, where the terminal ``on_step`` never fired (agent.run
        raised before saving the last step). Shows the answer's / error's last line.
        """
        self.tally[row["stop_reason"]] += 1
        self._totals["done"] += 1
        snippet = row["error"] if row["error"] else _last_line(row["answer"])
        self._show(
            row["task_id"],
            completed=row["steps"],
            total=max(row["steps"], 1),
            status=str(row["stop_reason"]),
            snippet=snippet,
            model_time=row["model_time"],
            tools_time=row["tools_time"],
        )
