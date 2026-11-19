"""The recorder journals off the caller's path: ordered, bounded, flushed on demand, and it fails loudly."""

from __future__ import annotations

from pathlib import Path

import anyio
import httpx
import pytest

import service_fakes as fakes
from nanoagent.uploaded import evidence
from nanoagent.uploaded.evidence import EvidenceEvent, JournalWriteError, Recorder
from service_fakes import PATHS, FakeJournal, ScriptedTransport, chat_request, make_rig, stream_script


class GatedJournal(FakeJournal):
    """A journal whose writes wait for ``open`` (a slow RUSH server)."""

    def __init__(self) -> None:
        super().__init__()
        self.open = anyio.Event()
        self.writes: list[str] = []

    async def append(self, event: EvidenceEvent) -> None:
        await self.open.wait()
        self.writes.append(event.event_id)
        await super().append(event)

    async def put_payload(self, data: bytes, redaction: str) -> str:
        await self.open.wait()
        self.writes.append("payload")
        return await super().put_payload(data, redaction)


def recorder(journal: FakeJournal, **kwargs: int) -> Recorder:
    clock = [0]

    def tick() -> int:
        clock[0] += 1
        return clock[0]

    return Recorder(journal, tick, ["secret"], **kwargs)


async def test_recording_does_not_wait_for_the_journal_and_writes_in_order() -> None:
    journal = GatedJournal()
    rec = recorder(journal)
    sha = await rec.payload(b"body")
    first = await rec.record("gateway", "a", {}, [sha])
    second = await rec.record("gateway", "b", {})
    assert journal.events == [] and (first.sequence, second.sequence) == (1, 2)  # nothing written, nobody waited
    assert first.monotonic_ns < second.monotonic_ns
    journal.open.set()
    await rec.flush()
    assert journal.writes == ["payload", "gateway-000001", "gateway-000002"]  # a payload lands before the events that reference it
    assert journal.body(sha) == b"body"
    await rec.aclose()


async def test_an_event_is_stamped_when_observed_not_when_written() -> None:
    journal = GatedJournal()
    rec = recorder(journal)
    event = await rec.record("exec", "x", {})
    stamped = event.monotonic_ns
    await anyio.sleep(0.01)
    journal.open.set()
    await rec.flush()
    assert journal.events[0].monotonic_ns == stamped
    await rec.aclose()


async def test_a_payload_is_uploaded_once_and_redacted_before_it_is_queued() -> None:
    journal = FakeJournal()
    rec = recorder(journal)
    assert await rec.payload(b"same") == await rec.payload(b"same")
    redacted = await rec.payload(b"has secret inside")
    await rec.flush()
    assert len(journal.payloads) == 2 and journal.payloads[redacted] == (b"has [REDACTED] inside", "redacted")
    await rec.aclose()


async def test_a_full_queue_makes_the_caller_wait_and_the_wait_is_recorded() -> None:
    journal = GatedJournal()
    rec = recorder(journal, max_queued_items=2)
    await rec.record("gateway", "a", {})
    await rec.record("gateway", "b", {})
    blocked = anyio.Event()

    async def third() -> None:
        await rec.record("harness", "c", {})
        blocked.set()

    async with anyio.create_task_group() as group:
        group.start_soon(third)
        await anyio.sleep(0.02)
        assert not blocked.is_set()  # bounded: the third event waits for room instead of growing the queue
        journal.open.set()
        await blocked.wait()
    await rec.flush()
    [wait] = rec.backpressure
    assert wait.source == "harness" and wait.blocked_ns > 0
    [note] = journal.of("journal.backpressure")
    assert note.source == "gateway" and note.data["source"] == "harness" and note.data["blocked_ns"] == wait.blocked_ns
    assert [e.kind for e in journal.of("c")] == ["c"]
    await rec.aclose()


async def test_a_failed_write_fails_the_flush_and_every_later_record() -> None:
    class Broken(FakeJournal):
        async def append(self, event: EvidenceEvent) -> None:
            raise OSError("disk gone")

    rec = recorder(Broken())
    await rec.record("gateway", "a", {})
    with pytest.raises(JournalWriteError, match="disk gone"):
        await rec.flush()
    with pytest.raises(JournalWriteError, match="disk gone"):
        await rec.record("gateway", "b", {})
    await rec.aclose()


async def test_a_streamed_response_reaches_the_harness_while_the_journal_is_stalled(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(stream_script()))
    journal = GatedJournal()
    rig.services.attempt.recorder._journal = journal  # the RUSH server stops answering
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=rig.services.app), base_url="http://svc.test", headers={"authorization": f"Bearer {fakes.TOKEN}"}
    ) as client:
        with anyio.fail_after(2):
            response = await client.post(PATHS["chat_completions"], json=chat_request(stream=True))
        assert response.status_code == 200 and response.content == b"".join(fakes.chat_stream_chunks())
        assert journal.events == []
        journal.open.set()
        await rig.services.flush()
    data = journal.of("model_call.response")[0].data
    index = __import__("json").loads(journal.body(data["frames_payload_sha256"]))
    # Each frame is stamped when upstream had it and again when the relay had handed it over, in that order.
    assert all(frame["available_ns"] <= frame["delivered_ns"] for frame in index)
    assert data["completed_ns"] <= data["delivered_ns"]
    await rig.services.aclose()


async def test_a_payload_over_the_server_cap_is_journaled_truncated() -> None:
    journal = FakeJournal()
    rec = recorder(journal)
    sha = await rec.payload(b"x" * (evidence.MAX_PAYLOAD_BYTES + 1))
    await rec.flush()
    data, redaction = journal.payloads[sha]
    assert len(data) == evidence.MAX_PAYLOAD_BYTES and redaction == "truncated"
