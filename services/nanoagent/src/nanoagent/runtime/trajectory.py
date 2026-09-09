"""Save and load agent run trajectories as ``*.traj.json``.

A trajectory captures one :class:`~nanoagent.core.agent.AgentResult` plus
optional caller metadata, in a JSON shape the browser
(:mod:`nanoagent.cli.repl.browser`) can render. The transcript is self-describing: each step's timing
and each tool result's error flag are inlined onto the messages, so there are no parallel
``tool_calls`` / ``step_durations`` arrays to keep aligned with it::

    {
      "messages": [               # full chat transcript (system .. final answer)
        {"role": "system",    "content": str},
        {"role": "user",      "content": str},
        {"role": "assistant", "content": str,
         "tool_calls": [{"id", "type", "function": {"name", "arguments"}}],  # if it called tools
         "durations": {"model": float, "tools": float}},                     # this step's seconds
        {"role": "tool", "tool_call_id": str, "content": str, "is_error": bool},
        ...
      ],
      "answer": str,
      "stop_reason": str,         # a StopReason value (answer | max_steps_reached | cost_limit | token_limit | interrupted | error; "running" while mid-run)
      "steps": int,
      "usage": {...},             # accumulated token counts
      "cost": float,
      "error": str | None,
      "logs": [{"time": str, "level": str, "logger": str, "message": str}],  # this task's WARNING+ log records
      "meta": {...},              # caller-supplied (task id, model, ...)
      "trajectory_format": "nanoagent-2",
    }

``durations``/``is_error`` are inlined only in the SAVED file (see :func:`_annotate_messages`);
the live messages the agent re-sends to the model never carry them (they are not chat-API fields).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from nanoagent.core.agent import AgentResult

TRAJECTORY_FORMAT = "nanoagent-2"
TRAJECTORY_SUFFIX = ".traj.json"
# Subdirectory under a batch `output` dir that holds the per-task `<task_id>.traj.json` files.
# Keeping them off the top level leaves results.jsonl / summary.json (the small ledger + report)
# uncluttered when an `ls` lists potentially thousands of trajectories.
TRAJECTORIES_DIRNAME = "trajectories"


def _atomic_write_text(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` atomically: fill a sibling ``.tmp`` then ``os.replace`` it into
    place (atomic on POSIX), so a process kill/crash/OOM/disk-full mid-write can never leave
    ``path`` itself partial — the reward seam (a scorer -> :func:`load`) always reads
    back a whole file (the new one or the prior good one), never a truncated one. Mirrors the repo's
    conventional atomic-publish pattern.

    On a failed write the partial ``.tmp`` is removed and the error re-raised, so no stray ``.tmp``
    is left behind. ``except BaseException`` (not ``Exception``) so even a wall-clock-cap
    cancellation, which arrives as ``asyncio.CancelledError`` (a ``BaseException``; see
    :func:`update_logs`), still cleans up the tmp before propagating.
    """
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)  # atomic on POSIX; never leaves a partial dest
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _annotate_messages(
    messages: list[dict[str, Any]],
    tool_calls: list[dict[str, Any]],
    step_durations: list[dict[str, float]],
) -> list[dict[str, Any]]:
    """Return ``messages`` with per-step observability inlined FOR SAVING — each assistant turn
    carries its step ``durations`` ({"model", "tools"}), each tool result its dispatch
    ``is_error``. Returns NEW dicts; the inputs (the live transcript the agent re-sends to the
    model) are left unmutated, since ``durations``/``is_error`` are not chat-API fields.

    ``step_durations`` has one entry per completed step, in order; they map onto the assistant
    turns in order. A step that errored before producing an assistant message (e.g. an
    over-context query the server rejected upfront) leaves a trailing duration with no turn to
    carry it, which is simply dropped from the inline view. ``is_error`` is matched to each tool
    result by the originating call id (``tool_calls`` rows carry ``id``; the message carries the
    same value as ``tool_call_id``); a tool message with no logged call (e.g. an interactively
    rejected call, which never ran) gets no ``is_error``.
    """
    is_error_by_id = {c["id"]: c["is_error"] for c in tool_calls if "id" in c}
    out: list[dict[str, Any]] = []
    next_duration = 0
    for m in messages:
        role = m.get("role")
        if role == "assistant" and next_duration < len(step_durations):
            out.append({**m, "durations": step_durations[next_duration]})
            next_duration += 1
        elif role == "tool" and m.get("tool_call_id") in is_error_by_id:
            out.append({**m, "is_error": is_error_by_id[m["tool_call_id"]]})
        else:
            out.append(dict(m))
    return out


def to_dict(
    result: AgentResult,
    meta: dict[str, Any] | None = None,
    logs: list[dict[str, Any]] | None = None,
    *,
    annotate: bool = True,
) -> dict[str, Any]:
    """Serialize an :class:`AgentResult` (+ metadata + captured logs) to a JSON dict.

    ``annotate`` (the default, the on-disk shape) inlines per-step ``durations`` and per-result
    ``is_error`` into ``messages`` (see :func:`_annotate_messages`), so the redundant ``tool_calls``
    / ``step_durations`` arrays are not emitted. ``annotate=False`` returns the raw ``messages``
    reference instead — used by :class:`IncrementalTrajectoryWriter`, which inlines per-message
    itself so it never copies the whole transcript each step.
    """
    return {
        "messages": _annotate_messages(result.messages, result.tool_calls, result.step_durations)
        if annotate
        else result.messages,
        "answer": result.answer,
        "stop_reason": result.stop_reason,
        "steps": result.steps,
        "usage": result.usage,
        "cost": result.cost,
        "error": result.error,
        "logs": logs or [],
        "meta": meta or {},
        "trajectory_format": TRAJECTORY_FORMAT,
    }


def save(
    result: AgentResult,
    path: str | Path,
    meta: dict[str, Any] | None = None,
    logs: list[dict[str, Any]] | None = None,
) -> Path:
    """Write ``result`` to ``path`` as pretty JSON, creating parent dirs. Returns the path."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_text(path, json.dumps(to_dict(result, meta, logs), indent=2))
    return path


def _indent(text: str, spaces: int) -> str:
    """Prefix every line of ``text`` with ``spaces`` blanks, to nest a JSON block deeper.

    ``json.dumps`` escapes newlines inside string values, so ``text`` carries only structural
    newlines — splitting on them never cuts into encoded data.
    """
    pad = " " * spaces
    return "\n".join(pad + line for line in text.split("\n"))


class _CachedArray:
    """Caches the rendered JSON of an append-only array of objects so each element is
    JSON-encoded exactly once across repeated saves.

    :meth:`render` reuses the cached text for the unchanged prefix (identified by ``keys``, the
    stable per-element identity objects) and encodes only elements appended since the last call.
    ``rendered`` holds the objects actually encoded — for messages these are fresh per-save copies
    carrying the inlined ``durations``/``is_error`` (see :func:`_annotate_messages`), so identity
    is taken from ``keys`` (the underlying live message objects, stable across steps) while a
    kept element's cached text stays correct because its inlined value is final once its step
    completed. It returns the exact text ``json.dumps`` produces for that array as the value of a
    top-level key under ``indent=2`` — elements at indent 4, closing bracket at indent 2 — so
    splicing it into the skeleton stays byte-identical.
    """

    def __init__(self) -> None:
        self._keys: list[Any] = []  # per-element identity objects already rendered
        self._blocks: list[str] = []  # their JSON text, indented to sit in the array
        self.encoded = 0  # elements encoded so far; == final count (O(N)), pinned by the linearity tests

    def render(self, keys: list[Any], rendered: list[Any]) -> str:
        # Reuse cached blocks for the unchanged prefix. On the batch path the list only grows by
        # appending; if an earlier element is ever replaced (compaction rebuilds messages),
        # identity diverges there and the tail is re-encoded — output stays byte-identical.
        keep = 0
        while (
            keep < len(self._keys)
            and keep < len(keys)
            and self._keys[keep] is keys[keep]
        ):
            keep += 1
        del self._keys[keep:]
        del self._blocks[keep:]
        for i in range(keep, len(keys)):
            self._keys.append(keys[i])
            self._blocks.append(_indent(json.dumps(rendered[i], indent=2), 4))
            self.encoded += 1
        if not self._blocks:
            return "[]"
        return "[\n" + ",\n".join(self._blocks) + "\n  ]"


class IncrementalTrajectoryWriter:
    """Per-step trajectory writer that JSON-encodes each transcript message once.

    :func:`save` re-runs ``json.dumps(to_dict(...), indent=2)`` from scratch, so saving after
    every agent step re-serializes the whole (only-growing) ``messages`` transcript each step —
    O(N^2) JSON encoding across an N-step run, and every prior message drags its multi-KB content
    along each time. This writer caches the rendered JSON text of every message it has already
    serialized (with its inlined ``durations``/``is_error``) and, on each :meth:`save`, encodes
    only the messages appended since the previous call, then splices the cached blocks into a
    freshly encoded skeleton of the remaining (small) fields. The result is BYTE-IDENTICAL to
    ``json.dumps(to_dict(result, meta, logs), indent=2)`` (enforced by ``tests/test_trajectory.py``),
    so :func:`load`, :func:`update_logs` and the browser all see the same file. One writer per
    ``path``/task — it is stateful and not shared across tasks.
    """

    # Values ``json.dumps`` renders as the literal text ``"\u0000__messages__\u0000"`` /
    # ``"\u0000__tool_calls__\u0000"``: unique needles marking where each array goes in the
    # skeleton. The NUL bytes can't occur in real content, so each appears exactly once.
    _MESSAGES_PLACEHOLDER = "\x00__messages__\x00"
    # The placeholder is fixed, so its json.dumps encoding (the actual needle spliced on in
    # save()) is fixed too — precompute it ONCE at class scope instead of re-encoding on every
    # per-step save() (a batch-rollout hot path).
    _MESSAGES_NEEDLE = json.dumps(_MESSAGES_PLACEHOLDER)

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._messages = _CachedArray()
        self._dir_made = False  # parent dir created lazily on first save(), then never again

    @property
    def messages_encoded(self) -> int:
        """Message objects encoded so far; == final count (O(N)), pinned by the linearity test."""
        return self._messages.encoded

    def save(
        self,
        result: AgentResult,
        meta: dict[str, Any] | None = None,
        logs: list[dict[str, Any]] | None = None,
    ) -> Path:
        """Write ``result`` to ``self.path``; encode only messages appended since last call."""
        data = to_dict(result, meta, logs)  # annotated copies; the cache encodes only the new tail
        # Cache by the LIVE message objects (stable across steps), render the annotated copies: a
        # kept prefix message's inlined durations/is_error are final once its step completed, so
        # its cached text stays valid even though the annotated copy is rebuilt each save.
        messages_json = self._messages.render(result.messages, data["messages"])
        # Encode every field except the big messages array (replaced by the NUL-needle
        # placeholder), then splice the cached array text back in. Byte-for-byte equal to
        # json.dumps(data, indent=2): the skeleton follows data's key order, and the needle —
        # holding NUL bytes real content never contains — appears exactly once, at its slot. The
        # assert pins messages as the first key, which this single-splice relies on.
        assert list(data)[0] == "messages"
        skeleton = json.dumps(
            {**data, "messages": self._MESSAGES_PLACEHOLDER},
            indent=2,
        )
        text = skeleton.replace(self._MESSAGES_NEEDLE, messages_json, 1)
        if not self._dir_made:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._dir_made = True
        _atomic_write_text(self.path, text)
        return self.path


def update_logs(
    path: str | Path,
    logs: list[dict[str, Any]],
    *,
    stop_reason: str | None = None,
    error: str | None = None,
) -> None:
    """Rewrite the ``logs`` field of an existing trajectory file (no-op if absent), optionally
    reconciling the terminal ``stop_reason``/``error``/``answer`` too.

    Used to fold in a task's final failure log when an unexpected exception aborts the
    run after the last per-step save (so no further :func:`save` would otherwise run).
    When ``stop_reason`` is given it also overwrites ``stop_reason`` and ``error`` and blanks
    ``answer`` to ``""``, so a timed-out rollout's saved trajectory matches its score-zero ledger
    row: a wall-clock-cap cancellation arrives as ``asyncio.CancelledError`` (a ``BaseException``)
    and bypasses :meth:`Agent.run`'s ``except Exception``, so its ERROR step never saved and the
    traj would otherwise stay at ``stop_reason="running"`` with the last RUNNING snapshot's partial
    mid-run ``answer`` (``agent.py`` builds it as ``answer = reply.content or ""``). ``stop_reason``
    left ``None`` (the default) keeps all three fields untouched, so existing logs-only callers are
    byte-for-byte unchanged.
    """
    path = Path(path)
    if not path.exists():
        return
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object (got {type(data).__name__})")
    data["logs"] = logs
    if stop_reason is not None:
        data["stop_reason"] = stop_reason
        data["error"] = error
        data["answer"] = ""
    _atomic_write_text(path, json.dumps(data, indent=2))


def load(path: str | Path) -> dict[str, Any]:
    """Read a trajectory JSON file back into a dict.

    Raises :class:`ValueError` naming ``path`` if the file is valid JSON but not a JSON
    object (a top-level list/number/string/bool/null) — honoring the ``-> dict`` return
    type so a malformed file fails clearly here, not opaquely in a downstream consumer
    (e.g. a reward path's ``data.get("answer")``). Malformed JSON still
    raises :class:`json.JSONDecodeError` as before.
    """
    path = Path(path)
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object (got {type(data).__name__})")
    return data
