from __future__ import annotations

import hashlib

import pytest
import io
import zipfile

from fake_rush import ATTEMPT, BAD_PAYLOAD_SHA, PAYLOAD, PAYLOAD_SHA, TOKEN, WORKSPACE, FakeRush, make_run, summary

from nanoagent.uploaded.client import BenchmarkClient, BenchmarkError, PayloadDigestMismatch, StalePreview, StreamLost, sse_frames


@pytest.fixture
def server():
    with FakeRush() as fake:
        yield fake


def client(server: FakeRush, token: str = TOKEN) -> BenchmarkClient:
    return BenchmarkClient(server.url, WORKSPACE, token)


def publication(**changes):
    return {
        "name": "probe", "plugin_id": "p", "plugin_name": "P", "version": "1.0.0", "package_sha256": "pkg", "task_id": "t",
        "task": {}, "context": "", "cases": [{"case_id": "c1", "kind": "answer", "arguments": {}, "expected_error": None}], "private": {},
        "model": "mock/model", "endpoint_profile": "mock", "limits": {}, "coding_template": None, "task_instructions": None, **changes,
    }  # fmt: skip


def source(name: str = "h", version: str = "1", body: str = "") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("harness.yaml", f"name: {name}\nversion: '{version}'\ndialects: [chat_completions]\n{body}")
    return buffer.getvalue()


def published(member: BenchmarkClient, **changes) -> dict:
    return member.publish_benchmark(publication(**changes))[1]


def submit(member: BenchmarkClient, benchmark: dict, key: str = "key-1", policy: str = "coding"):
    return member.create_run(benchmark_id=benchmark["benchmark_id"], policy=policy, preview_id="preview-1", source_sha256="0" * 64, idempotency_key=key)


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
            submit(member, benchmark, policy="task_tools")
    assert (raised.value.status, raised.value.code) == (409, "idempotency_conflict")


def test_a_stale_preview_carries_the_current_selection(server: FakeRush) -> None:
    server.stale = True
    with client(server) as member, pytest.raises(StalePreview) as raised:
        submit(member, published(member))
    assert raised.value.code == "stale_preview"
    assert raised.value.stale == ["prompt", "cases"]
    assert raised.value.current["benchmark"]["benchmark_id"] == "bench-2"


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
    assert first[1]["benchmark_id"] == "bench-1" and first[1]["plugin"]["version"] == "1.0.0"
    assert server.requests[0] == ("POST", "/api/benchmark/benchmarks")


def test_a_name_with_other_content_is_taken_but_another_plugin_version_may_use_it(server: FakeRush) -> None:
    with client(server) as member:
        member.publish_benchmark(publication())
        with pytest.raises(BenchmarkError) as raised:
            member.publish_benchmark(publication(model="other/model"))
        assert (raised.value.status, raised.value.code) == (409, "benchmark_name_taken")
        assert member.publish_benchmark(publication(version="2.0.0", model="other/model"))[0] is True
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
    assert detail["cases"] == [{"case_id": "c1", "kind": "answer", "arguments": {}, "expected_error": None, "position": 0}] and "private" not in detail
    assert raised.value.code == "unknown_benchmark" and bad.value.code == "invalid_request"


def test_a_source_upload_answers_the_harness_and_a_changed_zip_under_one_version_is_taken(server: FakeRush) -> None:
    with client(server) as member:
        first = member.upload_source(source())
        assert member.upload_source(source()) == first
        assert first["harness"] == {"name": "h", "version": "1", "dialects": ["chat_completions"]}
        assert member.upload_source(source("h", "2", "# other"))["harness"]["version"] == "2"
        with pytest.raises(BenchmarkError) as raised:
            member.upload_source(source(body="# changed"))
    assert (raised.value.status, raised.value.code) == (409, "harness_version_taken")
    assert raised.value.body["pinned_sha256"] == first["source_sha256"]


def test_a_source_without_a_manifest_name_is_refused(server: FakeRush) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("harness.yaml", "run: [python]\n")
    with client(server) as member, pytest.raises(BenchmarkError) as raised:
        member.upload_source(buffer.getvalue())
    assert raised.value.code == "invalid_manifest"


def test_a_preview_and_a_comparison_are_plain_reads_of_the_benchmark(server: FakeRush) -> None:
    server.comparison = {"shared": []}
    with client(server) as member:
        benchmark = published(member, limits={"internet_access": False})
        preview = member.preview(benchmark["benchmark_id"], "task_tools")
        assert member.compare_runs("run-a", "run-b") == {"shared": []}
        with pytest.raises(BenchmarkError) as raised:
            member.preview("nope", "coding")
    assert preview["limits"]["effective"]["internet_access"] is False and preview["policy"] == "task_tools"
    assert server.bodies[0] == {"benchmark_id": benchmark["benchmark_id"], "policy": "task_tools"} and server.compares == [{"a": "run-a", "b": "run-b"}]
    assert raised.value.code == "unknown_benchmark"


def test_runs_and_results_are_run_summaries(server: FakeRush) -> None:
    other = summary(make_run("run-x"), {"id": "user-2", "name": "Bo", "github": None})
    server.other_runs.append(other)
    with client(server) as member:
        benchmark = published(member, name="probe")
        run = submit(member, benchmark).run
        mine = member.list_runs()
        everyone = member.benchmark_results(benchmark["benchmark_id"], limit=10)
    assert mine == [summary(run)] and set(mine[0]) == {"run_id", "harness", "benchmark", "plugin", "model", "policy", "user", "metrics", "status", "score", "created_at"}
    assert [row["user"]["id"] for row in everyone] == ["user-1", "user-2"]
