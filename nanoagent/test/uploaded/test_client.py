from __future__ import annotations

import hashlib

import pytest

from fake_rush import ATTEMPT, BAD_PAYLOAD_SHA, PAYLOAD, PAYLOAD_SHA, TOKEN, WORKSPACE, FakeRush, publication, summary

from nanoagent.uploaded.client import BenchmarkClient, BenchmarkError, PayloadDigestMismatch, StreamLost, sse_frames


@pytest.fixture
def server():
    with FakeRush() as fake:
        yield fake


def client(server: FakeRush, token: str = TOKEN) -> BenchmarkClient:
    return BenchmarkClient(server.url, WORKSPACE, token)


def published(member: BenchmarkClient, **changes) -> dict:
    return member.publish_benchmark(publication(**changes))[1]


def submit(member: BenchmarkClient, benchmark: dict, key: str = "key-1", harness: str = "claude"):
    return member.create_run(benchmark_id=benchmark["benchmark_id"], harness=harness, idempotency_key=key)


def test_a_repeated_idempotency_key_returns_the_original_run(server: FakeRush) -> None:
    with client(server) as member:
        benchmark = published(member)
        first = submit(member, benchmark)
        again = submit(member, benchmark)
    assert (first.replayed, again.replayed) == (False, True)
    assert first.run["run_id"] == again.run["run_id"]
    assert len(server.runs) == 1


def test_the_same_key_with_another_request_is_an_idempotency_conflict(server: FakeRush) -> None:
    with client(server) as member:
        benchmark = published(member)
        submit(member, benchmark)
        with pytest.raises(BenchmarkError) as raised:
            submit(member, benchmark, harness="codex")
    assert (raised.value.status, raised.value.code) == (409, "idempotency_conflict")


def test_an_error_carries_the_servers_code(server: FakeRush) -> None:
    with client(server, "wrong") as member, pytest.raises(BenchmarkError) as raised:
        member.defaults()
    assert (raised.value.status, raised.value.code) == (401, "unauthorized")


def test_the_stream_reconnects_from_the_last_cursor_and_drops_the_duplicate(server: FakeRush) -> None:
    with client(server) as member:
        seen = list(member.stream(ATTEMPT))
    assert [event.get("cursor") for event in seen] == [1, 2, 3, None]
    assert seen[-1] == {"sealed": True, "final_cursor": 3}
    assert server.connections == 2


def test_a_stream_resumes_after_the_cursor_it_is_given(server: FakeRush) -> None:
    server.connections = 1  # not the connection the fake drops
    with client(server) as member:
        assert [event.get("cursor") for event in member.stream(ATTEMPT, after=2)] == [3, None]


def test_a_stream_that_keeps_breaking_is_lost(server: FakeRush) -> None:
    with client(server) as member:
        member.max_reconnects = 0
        with pytest.raises(StreamLost):
            list(member.stream(ATTEMPT))


def test_events_are_paged_without_gaps(server: FakeRush, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("nanoagent.uploaded.client.EVENT_PAGE", 2)
    with client(server) as member:
        log = member.events(ATTEMPT)
    assert [event["cursor"] for event in log.events] == [1, 2, 3]
    assert (log.sealed, log.final_cursor) == (True, 3)


def test_a_payload_is_verified_against_its_digest(server: FakeRush) -> None:
    with client(server) as member:
        assert member.payload(ATTEMPT, PAYLOAD_SHA).data == PAYLOAD
        assert PAYLOAD_SHA == hashlib.sha256(PAYLOAD).hexdigest()
        with pytest.raises(PayloadDigestMismatch):
            member.payload(ATTEMPT, BAD_PAYLOAD_SHA)


def test_sse_frames_skip_comments_and_join_data() -> None:
    lines = [": heartbeat", "", "id: 4", "event: event", "data: a", "data: b", "", "event: sealed", 'data: {"final_cursor": 4}', ""]
    assert list(sse_frames(lines)) == [("event", "4", "a\nb"), ("sealed", None, '{"final_cursor": 4}')]


def test_a_benchmark_is_published_once_and_a_repeat_is_not_created(server: FakeRush) -> None:
    with client(server) as member:
        first = member.publish_benchmark(publication())
        again = member.publish_benchmark(publication())
    assert first[0] is True and again == (False, first[1])
    assert first[1]["benchmark_id"] == "00000000-0000-4000-8000-000000000001" and first[1]["plugin"]["version"] == "1.0.0"
    assert server.requests[0] == ("POST", "/api/benchmark/benchmarks")


def test_a_name_with_other_content_is_taken_but_another_plugin_version_may_use_it(server: FakeRush) -> None:
    with client(server) as member:
        member.publish_benchmark(publication())
        with pytest.raises(BenchmarkError) as raised:
            member.publish_benchmark(publication(limits={"max_model_calls": 7}))
        assert (raised.value.status, raised.value.code) == (409, "benchmark_name_taken")
        assert member.publish_benchmark(publication(version="2.0.0", limits={"max_model_calls": 7}))[0] is True
    assert len(server.publications) == 2


def test_benchmarks_are_listed_by_plugin_and_version_and_read_with_their_case_set(server: FakeRush) -> None:
    with client(server) as member:
        first = published(member)
        published(member, version="2.0.0")
        published(member, plugin_id="q", plugin_name="Q")
        assert [b["plugin"]["version"] for b in member.benchmarks("p")] == ["2.0.0", "1.0.0"]
        assert member.benchmarks("p", "1.0.0") == [first]
        assert len(member.benchmarks()) == 3
        assert member.find_benchmark("p", "1.0.0", "probe") == first
        with pytest.raises(LookupError, match="no benchmark named other"):
            member.find_benchmark("p", "1.0.0", "other")
        detail = member.benchmark(first["benchmark_id"])
        with pytest.raises(BenchmarkError) as raised:
            member.benchmark("nope")
        with pytest.raises(BenchmarkError) as bad:
            member.benchmarks(version="1.0.0")
    assert detail["cases"] == [{**publication()["cases"][0], "position": 0}] and "private" not in detail
    assert raised.value.code == "unknown_benchmark" and bad.value.code == "invalid_request"


def test_a_run_names_its_harness(server: FakeRush) -> None:
    with client(server) as member:
        benchmark = published(member)
        first = submit(member, benchmark, harness="rush my-agent")
    assert server.bodies[0] == {
        "benchmark_id": benchmark["benchmark_id"],
        "harness": "rush my-agent",
        "idempotency_key": "key-1",
    }
    assert first.run["harness"]["name"] == "rush my-agent"


def test_the_client_has_no_read_of_others_runs() -> None:
    assert not hasattr(BenchmarkClient, "benchmark_results") and not hasattr(BenchmarkClient, "compare_runs")


def test_runs_are_the_members_own_run_summaries(server: FakeRush) -> None:
    with client(server) as member:
        run = submit(member, published(member, name="probe")).run
        mine = member.list_runs()
    assert mine == [summary(run)] and set(mine[0]) == {
        "run_id",
        "harness",
        "benchmark",
        "plugin",
        "model",
        "user",
        "metrics",
        "status",
        "score",
        "created_at",
    }
