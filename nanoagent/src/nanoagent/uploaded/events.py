"""Topology and ordering rules for harness events (the contract's "Tool and trace interfaces")."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from nanoagent.uploaded.contract import ContractError, validate

ROOT_KIND = "agent"


class EventError(ContractError):
    """An event the log refuses; the log's state is unchanged."""


@dataclass(frozen=True)
class Receipt:
    emitter_id: str
    sequence: int
    index: int
    digest: str


def canonical_json(event: dict[str, Any]) -> bytes:
    return json.dumps(event, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class HarnessEventLog:
    """Accepts schema-valid events for one attempt, enforcing sequence and span topology."""

    def __init__(self) -> None:
        self._receipts: dict[tuple[str, int], tuple[bytes, Receipt]] = {}
        self._last_sequence: dict[str, int] = {}
        self._started: set[str] = set()
        self._ended: set[str] = set()
        self._root: str | None = None

    def accept(self, event: dict[str, Any]) -> Receipt:
        validate("HarnessEvent", event)
        emitter, sequence = event["emitter_id"], event["sequence"]
        content = canonical_json(event)
        previous = self._receipts.get((emitter, sequence))
        if previous is not None:
            if previous[0] != content:
                raise EventError("conflicting_duplicate", f"{emitter} sequence {sequence} was already received with different content")
            return previous[1]
        expected = self._last_sequence.get(emitter, 0) + 1
        if sequence != expected:
            raise EventError("sequence_gap", f"{emitter} sent sequence {sequence}, expected {expected}")
        self._check_topology(event)
        index = len(self._receipts)
        receipt = Receipt(emitter, sequence, index, hashlib.sha256(content + b"\n" + str(index).encode()).hexdigest())
        self._receipts[(emitter, sequence)] = (content, receipt)
        self._last_sequence[emitter] = sequence
        self._apply(event)
        return receipt

    def _check_topology(self, event: dict[str, Any]) -> None:
        span = event["span_id"]
        match event["event"]:
            case "span.start":
                self._check_start(event, span)
            case "span.end":
                if span not in self._started:
                    raise EventError("unknown_span", f"span {span} ends before it starts")
                if span in self._ended:
                    raise EventError("duplicate_end", f"span {span} already ended")

    def _check_start(self, event: dict[str, Any], span: str) -> None:
        if span in self._started:
            raise EventError("duplicate_start", f"span {span} already started")
        parent = event.get("parent_span_id")
        if event["kind"] == ROOT_KIND:
            if parent is not None:
                raise EventError("invalid_root", f"the {ROOT_KIND} span {span} cannot have a parent")
            if self._root is not None:
                raise EventError("duplicate_root", f"the attempt already has root span {self._root}")
            return
        if parent is None:
            raise EventError("missing_parent", f"span {span} of kind {event['kind']} needs a parent_span_id")
        if parent not in self._started:
            raise EventError("unknown_parent", f"parent {parent} of span {span} has not started")

    def _apply(self, event: dict[str, Any]) -> None:
        span = event["span_id"]
        match event["event"]:
            case "span.start":
                self._started.add(span)
                if event["kind"] == ROOT_KIND:
                    self._root = span
            case "span.end":
                self._ended.add(span)
