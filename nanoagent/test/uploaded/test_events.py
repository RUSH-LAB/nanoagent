"""Sequence and span-topology rules of the harness event log."""

from __future__ import annotations

from typing import Any

import pytest

from nanoagent.uploaded.contract import ContractError
from nanoagent.uploaded.events import EventError, HarnessEventLog


def start(sequence: int, span: str, kind: str = "operation", parent: str | None = "root", emitter: str = "e1") -> dict[str, Any]:
    event: dict[str, Any] = {"protocol": "rush.harness.v1", "event": "span.start", "emitter_id": emitter, "sequence": sequence, "span_id": span, "kind": kind, "name": span}
    if parent is not None:
        event["parent_span_id"] = parent
    return event


def end(sequence: int, span: str, emitter: str = "e1") -> dict[str, Any]:
    return {"protocol": "rush.harness.v1", "event": "span.end", "emitter_id": emitter, "sequence": sequence, "span_id": span, "status": "ok"}


def rooted() -> HarnessEventLog:
    log = HarnessEventLog()
    log.accept(start(1, "root", "agent", None))
    return log


def rejected(log: HarnessEventLog, event: dict[str, Any], code: str) -> None:
    with pytest.raises(EventError) as raised:
        log.accept(event)
    assert raised.value.code == code


def test_accepts_a_well_formed_tree_with_deterministic_receipts() -> None:
    def run() -> list[Any]:
        log = rooted()
        return [
            log.accept(start(2, "tool1", "tool")),
            log.accept(start(3, "sub", "subagent")),
            log.accept(start(4, "decision", "decision", "sub")),
            log.accept(end(5, "decision")),
            log.accept(end(6, "root")),
        ]

    first, second = run(), run()
    assert first == second
    assert [receipt.index for receipt in first] == [1, 2, 3, 4, 5]
    assert len({receipt.digest for receipt in first}) == 5


def test_schema_invalid_events_are_rejected() -> None:
    log = rooted()
    with pytest.raises(ContractError) as raised:
        log.accept({**end(2, "root"), "status": "bogus"})
    assert raised.value.code == "schema_violation"


def test_identical_resend_returns_the_same_receipt_and_conflict_raises() -> None:
    log = rooted()
    first = log.accept(start(2, "t", "tool"))
    assert log.accept(start(2, "t", "tool")) == first
    rejected(log, {**start(2, "t", "tool"), "name": "other"}, "conflicting_duplicate")
    rejected(log, start(2, "u", "tool"), "conflicting_duplicate")


def test_sequences_are_consecutive_per_emitter_from_one() -> None:
    log = HarnessEventLog()
    rejected(log, start(2, "root", "agent", None), "sequence_gap")
    log.accept(start(1, "root", "agent", None))
    rejected(log, start(3, "t", "tool"), "sequence_gap")
    log.accept(start(1, "t", "tool", emitter="e2"))
    log.accept(start(2, "u", "tool"))


def test_a_rejected_event_does_not_consume_its_sequence() -> None:
    log = rooted()
    rejected(log, start(2, "t", "tool", "nobody"), "unknown_parent")
    log.accept(start(2, "t", "tool"))


def test_root_rules() -> None:
    log = HarnessEventLog()
    rejected(log, start(1, "x", "tool", None), "missing_parent")
    rejected(log, start(1, "x", "agent", "p"), "invalid_root")
    log.accept(start(1, "root", "agent", None))
    rejected(log, start(2, "root2", "agent", None), "duplicate_root")


@pytest.mark.parametrize("kind", ["subagent", "decision", "tool", "memory", "operation"])
def test_non_root_kinds_need_a_started_parent(kind: str) -> None:
    rejected(rooted(), start(2, "x", kind, "ghost"), "unknown_parent")
    rejected(HarnessEventLog(), start(1, "x", kind, "root"), "unknown_parent")
    rejected(rooted(), start(2, "x", kind, None), "missing_parent")


def test_span_lifecycle() -> None:
    log = rooted()
    rejected(log, end(2, "ghost"), "unknown_span")
    log.accept(start(2, "t", "tool"))
    rejected(log, {**start(3, "t", "tool")}, "duplicate_start")
    log.accept(end(3, "t"))
    rejected(log, end(4, "t"), "duplicate_end")
    rejected(log, start(4, "root", "operation"), "duplicate_start")
