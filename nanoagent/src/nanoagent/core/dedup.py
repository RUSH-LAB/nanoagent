"""MinHash redundancy filter for tool results: send what the model has not already seen.

The agent loop is stateless: every step re-sends the whole transcript, so a tool result stays in the prompt of every later
model call. When a tool returns something it already returned (the same call again), or something nearly the same (a
re-run of tests on slightly edited code, a second read of an overlapping record), the repeated text is paid for again on
that step and on every step after it.

This filter runs where the loop commits a step's tool results to the transcript (``Agent.run``). For each result it:

  1. normalizes the text (JSON is re-printed one key per line with sorted keys, so a line diff is meaningful);
  2. looks the exact normalized text up in a hash table: a result identical to an earlier one is sent as a one-line
     pointer to that earlier call;
  3. otherwise shingles it (``shingle`` consecutive tokens, the plugin token rule ``\\w+|[^\\w\\s]``), takes a ``num_perm``
     MinHash signature and probes an LSH index (``bands`` bands of ``num_perm // bands`` rows) for earlier results that
     may be similar. Each candidate is checked by its exact Jaccard similarity on the stored shingle sets; the best one
     at or above ``threshold`` becomes the base, and the result is sent as its changes against it, if they are at most
     ``max_ratio`` of the full text: for JSON, each changed leaf by its path (``queries[7].latency_ms: 0.7 -> 99.0``),
     so the model knows where the change is without line numbers; for other text, a line diff with one line of context.
     Otherwise the result is sent whole and indexed as a future base.

Earlier messages are never changed, so the prompt prefix a provider caches stays byte-identical. Only the new tool
message the model is sent (and the transcript keeps) is shorter; the call log, the trajectory's tool outputs and
everything a verifier reads keep the full output. Off by default; ``Agent(dedup=True)``, ``agent.dedup: true`` in a config, or
``NANOAGENT_DEDUP=1`` turns it on.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import random
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

__all__ = ["DedupConfig", "MinHasher", "RedundancyFilter", "changes", "dedup_enabled", "flatten", "jaccard", "normalize", "shingles"]

TOKEN = re.compile(r"\w+|[^\w\s]")
PREFIX = "[nanoagent dedup]"
_PRIME = (1 << 61) - 1  # a Mersenne prime, larger than any 60-bit shingle hash
_ENV = "NANOAGENT_DEDUP"


def dedup_enabled(flag: bool | None) -> bool:
    """``flag`` when it is set, else the ``NANOAGENT_DEDUP`` environment variable (1, true, yes or on)."""
    if flag is not None:
        return flag
    return os.environ.get(_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class DedupConfig:
    threshold: float = 0.6  # least Jaccard similarity for a result to be sent as a diff
    shingle: int = 5  # tokens per shingle
    num_perm: int = 128  # MinHash permutations
    bands: int = 32  # LSH bands; rows per band = num_perm // bands (4), so the S-curve's threshold is about 0.42
    min_chars: int = 200  # shorter results are sent as they are and not indexed
    max_ratio: float = 0.7  # a diff longer than this share of the full text is not worth it: send the text
    seed: int = 480580


def normalize(text: str) -> str:
    """JSON one key per line with sorted keys (so equal data prints equally and a diff is per field), other text as is."""
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return text.strip()
    if not isinstance(value, (dict, list)):
        return text.strip()
    return json.dumps(value, indent=1, sort_keys=True, ensure_ascii=False)


def _parse(text: str) -> Any:
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, (dict, list)) else None


def flatten(value: Any, path: str = "") -> dict[str, str]:
    """Every leaf of a JSON value by its path (``queries[7].latency_ms``), its value printed as JSON; an empty container is a leaf."""
    if isinstance(value, dict) and value:
        out: dict[str, str] = {}
        for key in value:
            out.update(flatten(value[key], f"{path}.{key}" if path else str(key)))
        return out
    if isinstance(value, list) and value:
        out = {}
        for index, item in enumerate(value):
            out.update(flatten(item, f"{path}[{index}]"))
        return out
    return {path or "(value)": json.dumps(value, ensure_ascii=False)}


def changes(old: dict[str, str], new: dict[str, str]) -> list[str]:
    """What turns ``old`` into ``new``, one line per leaf: changed (``path: a -> b``), added (``+ path: b``), removed (``- path``)."""
    lines = []
    for path, value in new.items():
        if path not in old:
            lines.append(f"+ {path}: {value}")
        elif old[path] != value:
            lines.append(f"{path}: {old[path]} -> {value}")
    lines += [f"- {path}" for path in old if path not in new]
    return lines


def _hash64(data: str) -> int:
    return int.from_bytes(hashlib.blake2b(data.encode("utf-8"), digest_size=8).digest(), "big") >> 4  # 60 bits


def shingles(text: str, k: int) -> set[int]:
    """The 60-bit hashes of every run of ``k`` consecutive tokens (the whole text when it has fewer)."""
    tokens = TOKEN.findall(text)
    if len(tokens) <= k:
        return {_hash64(" ".join(tokens))} if tokens else set()
    return {_hash64(" ".join(tokens[i : i + k])) for i in range(len(tokens) - k + 1)}


def jaccard(a: set[int], b: set[int]) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


class MinHasher:
    """``num_perm`` universal hash functions h(x) = (a x + b) mod p, fixed by ``seed``, so signatures are reproducible."""

    def __init__(self, num_perm: int, seed: int) -> None:
        rng = random.Random(seed)
        self.params = [(rng.randrange(1, _PRIME), rng.randrange(0, _PRIME)) for _ in range(num_perm)]

    def signature(self, items: set[int]) -> tuple[int, ...]:
        if not items:
            return tuple(_PRIME for _ in self.params)
        return tuple(min((a * x + b) % _PRIME for x in items) for a, b in self.params)


@dataclass
class _Entry:
    call_id: str
    tool: str
    lines: list[str]
    leaves: dict[str, str] | None  # flatten() of a JSON result, else None
    shingles: set[int]


@dataclass
class RedundancyFilter:
    """One run's filter: what earlier results the model was sent, and what this run saved. Not shared between runs."""

    config: DedupConfig = field(default_factory=DedupConfig)
    stats: dict[str, int] = field(default_factory=lambda: dict.fromkeys(
        ("results", "exact", "near", "chars_in", "chars_out", "tokens_in", "tokens_out"), 0))

    def __post_init__(self) -> None:
        if self.config.num_perm % self.config.bands:
            raise ValueError("num_perm must be a multiple of bands")
        self._rows = self.config.num_perm // self.config.bands
        self._hasher = MinHasher(self.config.num_perm, self.config.seed)
        self._exact: dict[str, tuple[str, str]] = {}  # normalized text's sha256 -> (call id, tool) of its first occurrence
        self._entries: list[_Entry] = []
        self._buckets: dict[tuple[int, tuple[int, ...]], list[int]] = defaultdict(list)

    def apply(self, call_id: str, tool: str, text: str) -> str:
        """The text the model is sent for this tool result: ``text`` itself, a pointer, or a diff against an earlier result."""
        sent = self._apply(call_id, tool, text)
        self.stats["results"] += 1
        self.stats["chars_in"] += len(text)
        self.stats["chars_out"] += len(sent)
        self.stats["tokens_in"] += len(TOKEN.findall(text))
        self.stats["tokens_out"] += len(TOKEN.findall(sent))
        return sent

    def _apply(self, call_id: str, tool: str, text: str) -> str:
        if len(text) < self.config.min_chars:
            return text
        normal = normalize(text)
        digest = hashlib.sha256(normal.encode("utf-8")).hexdigest()
        if digest in self._exact:
            first, first_tool = self._exact[digest]
            self.stats["exact"] += 1
            return f"{PREFIX} Identical to the result of tool call {first} ({first_tool}) above, so it is not repeated."
        self._exact[digest] = (call_id, tool)
        items = shingles(normal, self.config.shingle)
        signature = self._hasher.signature(items)
        keys = [(band, signature[band * self._rows : (band + 1) * self._rows]) for band in range(self.config.bands)]
        candidates = sorted({index for key in keys for index in self._buckets.get(key, ())})
        best, best_score = None, 0.0
        for index in candidates:  # LSH proposes, the stored shingle sets decide
            score = jaccard(items, self._entries[index].shingles)
            if score > best_score:
                best, best_score = self._entries[index], score
        lines = normal.splitlines()
        parsed = _parse(text)
        leaves = flatten(parsed) if parsed is not None else None
        if best is not None and best_score >= self.config.threshold:
            head = f"{PREFIX} This result is {best_score:.0%} the same as the result of tool call {best.call_id} ({best.tool}) above. "
            if leaves is not None and best.leaves is not None:
                body = changes(best.leaves, leaves)
                compact = head + (
                    "It is that result with only these changes, one per line by JSON path "
                    "(`path: old -> new` changed, `+ path: new` added, `- path` removed); every other field is the same:\n"
                    + ("\n".join(body) if body else "(no field differs)")
                )
            else:
                body = [line for line in difflib.unified_diff(best.lines, lines, lineterm="", n=1) if not line.startswith(("---", "+++"))]
                compact = head + (
                    "Only the lines that differ are shown, as a diff of that result with one line of context: "
                    "'-' lines are only in that result, '+' lines only in this one, and every other line is the same.\n" + "\n".join(body)
                )
            if len(compact) <= self.config.max_ratio * len(text):
                self.stats["near"] += 1
                return compact
        index = len(self._entries)
        self._entries.append(_Entry(call_id, tool, lines, leaves, items))
        for key in keys:
            self._buckets[key].append(index)
        return text

    def filter_messages(self, rows: list[dict[str, Any]], messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The step's ``role="tool"`` messages with each successful, text-only result passed through :meth:`apply`, in call
        order. ``rows`` are the step's call-log rows (same order); errors and results with images are sent as they are."""
        out = []
        for row, message in zip(rows, messages, strict=True):
            if row["is_error"] or message.get("images") or not isinstance(message.get("content"), str):
                out.append(message)
                continue
            out.append({**message, "content": self.apply(row["id"], row["name"], message["content"])})
        return out

    def summary(self) -> dict[str, Any]:
        saved = self.stats["tokens_in"] - self.stats["tokens_out"]
        return {**self.stats, "tokens_saved_per_send": saved, "config": vars(self.config)}
