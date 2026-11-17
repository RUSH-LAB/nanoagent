"""The attempt gateway: policy, admission, relay and evidence, in-process; then against a scripted upstream over loopback."""

from __future__ import annotations

import dataclasses
import json
import socket
import sys
import threading
import time
from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path

import anyio
import httpx
import openai
import pytest

import service_fakes as fakes
from nanoagent.uploaded.attempt import ToolPolicy
from nanoagent.uploaded.gateway import UpstreamError
from service_fakes import (
    PATHS,
    PROMPT,
    REQUESTS,
    TOKEN,
    UPSTREAM_KEY,
    LoopbackServer,
    Scripted,
    ScriptedTransport,
    chat_ok,
    chat_request,
    make_endpoint,
    make_policy,
    make_rig,
    stream_script,
)

# The scripted upstream lives with the benchmark acceptance suite.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "acceptance" / "benchmark"))
from mockllm import MockProvider, Scenario, Stream, Turn, Usage  # noqa: E402

DIALECTS = list(PATHS)


def last(rig, kind):
    return rig.journal.of(kind)[-1].data


def recorded(rig, kind, count=1):
    """The journal's events of ``kind`` once there are ``count``. A real server journals in the background, after it answers."""
    deadline = time.monotonic() + 5
    while len(rig.journal.of(kind)) < count:
        assert time.monotonic() < deadline, f"{count} {kind} events were not journaled"
        time.sleep(0.01)
    return rig.journal.of(kind)


# ---- auth and routing --------------------------------------------------------------------------------------------------


async def test_wrong_or_missing_token_is_rejected_and_recorded(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        for headers in ({"authorization": "Bearer nope"}, {"authorization": "", "x-api-key": "nope"}, {"authorization": ""}):
            response = await client.post(PATHS["chat_completions"], json=chat_request(), headers=headers)
            assert response.status_code == 401 and response.json()["error"]["code"] == "unauthorized"
    assert [e.data["code"] for e in rig.journal.of("model_call.rejected")] == ["unauthorized"] * 3
    assert rig.transport.requests == [] and rig.admission.reserved == {}


async def test_x_api_key_works_and_credentials_are_swapped_upstream(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(chat_ok()))
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request(), headers={"authorization": "", "x-api-key": TOKEN, "cookie": "c=1"})
    assert response.status_code == 200
    sent = rig.transport.requests[0]
    assert sent.headers["authorization"] == f"Bearer {UPSTREAM_KEY}" and "x-api-key" not in sent.headers and TOKEN not in str(sent.headers)
    assert sent.url == "http://mock.test/api/v1/chat/completions"
    assert response.headers["x-generation-id"] == "gen-abc" and response.headers["x-rush-call-id"]


@pytest.mark.parametrize("method,path", [("POST", "/api/v1/embeddings"), ("GET", "/api/v1/models"), ("POST", "/api/v1/messages/count_tokens"), ("GET", "/elsewhere")])
async def test_unsupported_routes_are_404_and_recorded(tmp_path: Path, method: str, path: str) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        response = await client.request(method, path)
    assert response.status_code == 404 and response.json()["error"]["code"] == "unsupported_route"
    assert last(rig, "model_call.rejected")["code"] == "unsupported_route" and last(rig, "model_call.rejected")["path"] == path


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/v1/models"), ("GET", "/api/v1/api/tags"), ("POST", "/api/v1/api/show"), ("GET", "/api/v1/props"), ("GET", "/api/v1/version"),
])
async def test_a_harness_startup_probe_is_a_fast_404_and_not_a_model_call(tmp_path: Path, method: str, path: str) -> None:
    """Hermes probes these routes at startup to detect the server; each must be answered at once and leave the call budget alone."""
    rig = make_rig(tmp_path, ScriptedTransport(chat_ok()), policy=fakes.make_policy(max_model_calls=1))
    async with rig.client() as client:
        started = time.monotonic()
        response = await client.request(method, path, headers={"authorization": f"Bearer {TOKEN}"})
        elapsed = time.monotonic() - started
        assert response.status_code == 404 and response.json()["error"]["code"] == "unsupported_route" and elapsed < 1
        assert last(rig, "model_call.rejected")["admitted"] is False
        assert rig.transport.requests == [] and rig.admission.reserved == {}
        # The single permitted model call is still there.
        assert (await client.post(PATHS["chat_completions"], json=chat_request())).status_code == 200


async def test_dialect_not_in_the_request_is_404(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(), policy=fakes.make_policy(dialects=("chat_completions",)))
    async with rig.client() as client:
        response = await client.post(PATHS["responses"], json=REQUESTS["responses"]())
    assert response.status_code == 404 and response.json()["error"]["code"] == "dialect_not_enabled"
    assert last(rig, "model_call.rejected")["code"] == "dialect_not_enabled"


# ---- policy ------------------------------------------------------------------------------------------------------------

REJECTIONS = [
    ("chat_completions", {"model": "other/model"}, "model_not_pinned"),
    ("chat_completions", {"models": ["a/b", "c/d"]}, "fallback_forbidden"),
    ("chat_completions", {"route": "fallback"}, "fallback_forbidden"),
    ("chat_completions", {"provider": {"order": ["x"]}}, "provider_routing_forbidden"),
    ("chat_completions", {"plugins": [{"id": "web"}]}, "plugins_forbidden"),
    ("chat_completions", {"tools": [{"type": "web_search"}]}, "server_tool_forbidden"),
    ("chat_completions", {"web_search_options": {}}, "server_tool_forbidden"),
    ("chat_completions", {"max_tokens": 1001}, "output_cap_exceeded"),
    ("chat_completions", {"max_completion_tokens": 5000}, "output_cap_exceeded"),
    ("responses", {"tools": [{"type": "web_search_preview"}]}, "server_tool_forbidden"),
    ("responses", {"previous_response_id": "resp_1"}, "provider_state_forbidden"),
    ("responses", {"conversation": "conv_1"}, "provider_state_forbidden"),
    ("responses", {"store": True}, "provider_state_forbidden"),
    ("responses", {"max_output_tokens": 2000}, "output_cap_exceeded"),
    ("anthropic_messages", {"tools": [{"type": "web_search_20250305", "name": "web_search"}]}, "server_tool_forbidden"),
    ("anthropic_messages", {"tools": [{"type": "bash_20250124", "name": "bash"}]}, "server_tool_forbidden"),
    ("anthropic_messages", {"max_tokens": 1001}, "output_cap_exceeded"),
]


@pytest.mark.parametrize("dialect,extra,code", REJECTIONS)
async def test_policy_violations_are_rejected_recorded_and_never_reserved(tmp_path: Path, dialect: str, extra: dict, code: str) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    body = {**REQUESTS[dialect](), **extra}
    async with rig.client() as client:
        response = await client.post(PATHS[dialect], json=body)
    assert response.status_code == 400 and response.json()["error"]["code"] == code
    rejected = last(rig, "model_call.rejected")
    assert rejected["code"] == code and rejected["admitted"] is False and rejected["call_id"] == response.headers["x-rush-call-id"]
    assert json.loads(rig.journal.body(rejected["submitted_request_sha256"])) == body  # the offending request is preserved
    assert rig.transport.requests == [] and rig.admission.reserved == {} and rig.journal.of("model_call.admitted") == []


async def test_missing_first_prompt_is_rejected_until_one_call_completes(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(Scripted(status=429, chunks=[b'{"error":{"message":"slow down"}}']), chat_ok(), chat_ok()))
    async with rig.client() as client:
        other = chat_request("something else")
        rejected = await client.post(PATHS["chat_completions"], json=other)
        assert rejected.status_code == 400 and rejected.json()["error"]["code"] == "first_prompt_missing"
        assert (await client.post(PATHS["chat_completions"], json=chat_request())).status_code == 429  # a failed first call does not satisfy the rule
        assert (await client.post(PATHS["chat_completions"], json=other)).status_code == 400
        assert (await client.post(PATHS["chat_completions"], json=chat_request())).status_code == 200  # the retry carries the prompt
        assert (await client.post(PATHS["chat_completions"], json=other)).status_code == 200  # later calls are free


async def test_effective_request_adds_policy_and_both_requests_are_kept(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(chat_ok()))
    submitted = chat_request(stream=False, temperature=0.2)
    async with rig.client() as client:
        await client.post(PATHS["chat_completions"], json=submitted)
    effective = rig.transport.body()
    assert effective["provider"] == {"order": ["fixed-provider"], "allow_fallbacks": False}
    assert effective["usage"] == {"include": True} and effective["max_tokens"] == 1000 and effective["temperature"] == 0.2
    admitted = last(rig, "model_call.admitted")
    assert json.loads(rig.journal.body(admitted["submitted_request_sha256"])) == submitted
    assert json.loads(rig.journal.body(admitted["effective_request_sha256"])) == effective
    assert admitted["submitted_request_sha256"] != admitted["effective_request_sha256"]


async def test_stream_options_and_default_cap_per_dialect(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(stream_script(), chat_ok(), chat_ok()))
    async with rig.client() as client:
        await client.post(PATHS["chat_completions"], json=chat_request(stream=True, stream_options={"include_usage": False, "x": 1}, max_completion_tokens=50))
        await client.post(PATHS["responses"], json=REQUESTS["responses"]())
        await client.post(PATHS["anthropic_messages"], json={k: v for k, v in REQUESTS["anthropic_messages"]().items() if k != "max_tokens"})
    chat, responses, anthropic = (rig.transport.body(i) for i in range(3))
    assert chat["stream_options"] == {"include_usage": True, "x": 1} and "max_tokens" not in chat and chat["max_completion_tokens"] == 50
    assert responses["max_output_tokens"] == 1000 and anthropic["max_tokens"] == 1000


# ---- budget and admission ----------------------------------------------------------------------------------------------


async def test_reservation_precedes_dispatch_with_a_deterministic_bound(tmp_path: Path) -> None:
    fakes.ORDER.clear()
    rig = make_rig(tmp_path, ScriptedTransport(chat_ok()))
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request())
    call_id = response.headers["x-rush-call-id"]
    assert fakes.ORDER == [f"reserve:{call_id}", "dispatch"]
    effective_bytes = len(rig.transport.requests[0].body)
    assert rig.admission.reserved[call_id] == Decimal(effective_bytes) * Decimal("0.000001") + 1000 * Decimal("0.000004")
    assert last(rig, "model_call.admitted")["bound_usd"] == str(rig.admission.reserved[call_id])


async def test_max_model_calls_counts_admitted_requests(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(chat_ok()), policy=fakes.make_policy(max_model_calls=1))
    async with rig.client() as client:
        assert (await client.post(PATHS["chat_completions"], json=chat_request())).status_code == 200
        response = await client.post(PATHS["chat_completions"], json=chat_request())
    assert response.status_code == 403 and response.json()["error"]["code"] == "model_call_limit"
    assert len(rig.transport.requests) == 1 and len(rig.admission.reserved) == 1


@pytest.mark.parametrize("code,status", [("lease_lost", 403), ("budget_exhausted", 402), ("revoked", 403)])
async def test_admission_denial_blocks_dispatch(tmp_path: Path, code: str, status: int) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(), admission=fakes.FakeAdmission(deny=code))
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request())
    assert response.status_code == status and response.json()["error"]["code"] == code
    assert last(rig, "model_call.rejected")["code"] == code and rig.transport.requests == []


# ---- relay, settlement and evidence ------------------------------------------------------------------------------------


async def test_completed_body_settles_with_reported_cost_and_records_the_response(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(chat_ok(("call_1", "read", {"n": 1}), cost=0.0003)))
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request(), headers={"x-rush-span-id": "span-7"})
    call_id = response.headers["x-rush-call-id"]
    assert rig.admission.settled[call_id] == (Decimal("0.0003"), "chat_completions:body") and rig.admission.uncertain == []
    data = last(rig, "model_call.response")
    assert data["terminal"] == "completed" and data["http_status"] == 200 and data["span_id"] == "span-7"
    assert data["generation_id"] == "gen-abc" and data["response_headers"]["x-generation-id"] == "gen-abc"
    assert data["usage"]["input"] == 10 and data["usage"]["cost_usd"] == "0.0003"
    assert data["proposals"][0]["call_id"] == "call_1" and data["proposals"][0]["arguments"] == {"n": 1}
    assert data["dispatched_ns"] < data["first_byte_ns"] <= data["completed_ns"]
    assert last(rig, "model_call.dispatched")["endpoint"] == {"label": "mock-a", "mode": "mock", "destination": "http://mock.test"}
    assert last(rig, "model_call.admitted")["span_id"] == "span-7"
    assert rig.journal.kinds() == ["model_call.admitted", "model_call.dispatched", "model_call.response"]


async def test_streamed_response_is_relayed_assembled_registered_and_frames_kept(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(stream_script()))
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request(stream=True))
    assert response.content == b"".join(fakes.chat_stream_chunks())
    call_id = response.headers["x-rush-call-id"]
    data = last(rig, "model_call.response")
    assert data["terminal"] == "completed" and data["frame_count"] == 5
    assert rig.admission.settled[call_id][0] == Decimal("0.0002")
    proposal = await rig.services.registry.lookup(call_id, "call_a", 0)
    assert proposal is not None and proposal.arguments == {"n": 1}
    raw = rig.journal.body(data["stream_payload_sha256"])
    index = json.loads(rig.journal.body(data["frames_payload_sha256"]))
    assert raw == response.content and sum(frame["bytes"] for frame in index) == len(raw)
    assert [frame["index"] for frame in index] == [0, 1, 2, 3, 4] and index[1]["offset"] == index[0]["bytes"]


async def test_upstream_429_is_settled_at_zero_and_the_retry_is_a_separate_call(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(Scripted(status=429, headers={"content-type": "application/json", "retry-after": "1"}, chunks=[b'{"error":{"message":"x"}}']), chat_ok()))
    async with rig.client() as client:
        first = await client.post(PATHS["chat_completions"], json=chat_request())
        second = await client.post(PATHS["chat_completions"], json=chat_request())
    assert first.status_code == 429 and first.headers["retry-after"] == "1" and second.status_code == 200
    a, b = first.headers["x-rush-call-id"], second.headers["x-rush-call-id"]
    assert a != b and set(rig.admission.reserved) == {a, b}
    assert rig.admission.settled[a] == (Decimal(0), "http_429") and last(rig, "model_call.response")["terminal"] == "completed"
    assert rig.journal.of("model_call.response")[0].data["terminal"] == "http_error"


async def test_upstream_5xx_keeps_the_reservation_uncertain(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(Scripted(status=502, chunks=[b"bad gateway"])))
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request())
    assert response.status_code == 502 and rig.admission.uncertain == [response.headers["x-rush-call-id"]]


async def test_request_that_never_reached_upstream_settles_at_zero(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(Scripted(send_error=UpstreamError("connect failed", maybe_reached=False))))
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request())
    call_id = response.headers["x-rush-call-id"]
    assert response.status_code == 502 and response.json()["error"]["code"] == "upstream_unreachable"
    assert rig.admission.settled[call_id] == (Decimal(0), "not_dispatched") and rig.admission.uncertain == []
    data = last(rig, "model_call.response")
    assert data["terminal"] == "transport_error" and data["maybe_reached_upstream"] is False and data["usage"]["provenance"] == "not_dispatched"


async def test_failure_after_dispatch_is_uncertain_and_recorded(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(Scripted(send_error=UpstreamError("read timeout", maybe_reached=True))))
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request())
    assert rig.admission.uncertain == [response.headers["x-rush-call-id"]] and rig.admission.settled == {}
    assert last(rig, "model_call.response")["terminal"] == "transport_error"


async def test_midstream_cut_is_uncertain_and_its_proposals_are_not_registered(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(stream_script(fakes.chat_stream_chunks()[:2], cut=UpstreamError("peer closed", maybe_reached=True))))
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request(stream=True))
    call_id = response.headers["x-rush-call-id"]
    assert rig.admission.uncertain == [call_id]
    data = last(rig, "model_call.response")
    assert data["terminal"] == "transport_error" and data["http_status"] == 200 and data["frame_count"] == 2
    assert await rig.services.registry.lookup(call_id, "call_a", 0) is None


async def test_stream_that_ends_without_its_terminal_event_is_interrupted_and_uncertain(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(stream_script(fakes.chat_stream_chunks()[:2])))
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request(stream=True))
    assert last(rig, "model_call.response")["terminal"] == "interrupted" and rig.admission.uncertain == [response.headers["x-rush-call-id"]]


async def test_completed_without_cost_settles_unknown_and_error_event_is_uncertain(tmp_path: Path) -> None:
    error_chunks = [fakes.sse({"id": "gen-e", "error": {"message": "provider died", "code": 500}, "choices": []})]
    rig = make_rig(tmp_path, ScriptedTransport(stream_script(fakes.chat_stream_chunks(cost=None)), stream_script(error_chunks)))
    async with rig.client() as client:
        one = await client.post(PATHS["chat_completions"], json=chat_request(stream=True))
        two = await client.post(PATHS["chat_completions"], json=chat_request(stream=True))
    assert rig.admission.settled[one.headers["x-rush-call-id"]][0] is None
    assert last(rig, "model_call.response")["terminal"] == "error" and rig.admission.uncertain == [two.headers["x-rush-call-id"]]


async def test_credentials_are_redacted_from_payloads(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport(Scripted(status=400, chunks=[f'{{"error":"bad key {UPSTREAM_KEY}"}}'.encode()])))
    async with rig.client() as client:
        await client.post(PATHS["chat_completions"], json=chat_request(metadata={"leak": TOKEN}))
    assert all(UPSTREAM_KEY.encode() not in data and TOKEN.encode() not in data for data, _ in rig.journal.payloads.values())
    assert {status for _, status in rig.journal.payloads.values()} == {"redacted"}


async def test_invalid_span_id_and_bad_json_are_rejected(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        bad_span = await client.post(PATHS["chat_completions"], json=chat_request(), headers={"x-rush-span-id": "has space"})
        bad_json = await client.post(PATHS["chat_completions"], content=b'{"model": NaN}')
        duplicate = await client.post(PATHS["chat_completions"], content=b'{"model": "a", "model": "b"}')
    assert bad_span.json()["error"]["code"] == "invalid_span_id"
    assert bad_json.json()["error"]["code"] == "invalid_json" and duplicate.json()["error"]["code"] == "invalid_json"


# ---- revocation --------------------------------------------------------------------------------------------------------


async def test_revoke_rejects_new_calls_and_aborts_an_in_flight_stream(tmp_path: Path) -> None:
    hold = anyio.Event()
    rig = make_rig(tmp_path, ScriptedTransport(stream_script(hold=hold)))
    results: list[httpx.Response] = []

    async def stream_call() -> None:
        async with rig.client() as client:
            results.append(await client.post(PATHS["chat_completions"], json=chat_request(stream=True)))

    async with anyio.create_task_group() as group:
        group.start_soon(stream_call)
        while not rig.journal.of("model_call.dispatched") or not rig.transport.responses:
            await anyio.sleep(0.01)
        await anyio.sleep(0.05)
        await rig.services.revoke(drain_timeout=2)
    [aborted] = results
    assert last(rig, "model_call.response")["terminal"] == "revoked"
    assert rig.admission.uncertain == [aborted.headers["x-rush-call-id"]] and rig.transport.responses[0].closed
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request())
    assert response.status_code == 403 and response.json()["error"]["code"] == "revoked"
    assert last(rig, "model_call.rejected")["code"] == "revoked"


async def test_a_call_admitted_while_revocation_begins_is_never_dispatched(tmp_path: Path) -> None:
    class RevokedDuringReserve(fakes.FakeAdmission):
        async def reserve(self, call_id: str, bound_usd: Decimal) -> None:
            await super().reserve(call_id, bound_usd)
            rig.services.attempt.revoked = True

    rig = make_rig(tmp_path, ScriptedTransport(chat_ok()), admission=RevokedDuringReserve())
    async with rig.client() as client:
        response = await client.post(PATHS["chat_completions"], json=chat_request())
    call_id = response.headers["x-rush-call-id"]
    assert response.status_code == 403 and response.json()["error"]["code"] == "revoked"
    assert rig.transport.requests == [] and rig.admission.settled[call_id] == (Decimal(0), "not_dispatched")


async def test_a_failed_settlement_still_records_the_paid_response(tmp_path: Path) -> None:
    class SettleFails(fakes.FakeAdmission):
        async def settle(self, call_id: str, cost_usd: Decimal | None, provenance: str) -> None:
            raise RuntimeError("rush unreachable")

    rig = make_rig(tmp_path, ScriptedTransport(chat_ok(cost=0.0003)), admission=SettleFails())
    async with rig.client() as client:
        with pytest.raises(Exception):  # noqa: B017, PT011 - the settlement failure surfaces through the ASGI transport
            await client.post(PATHS["chat_completions"], json=chat_request())
    assert last(rig, "model_call.response")["settlement"]["action"] == "unsettled"


# ---- end to end: the real transport and uvicorn against a scripted upstream over loopback ------------------------------


WAIT_TOOL = ToolPolicy("wait", False, {"type": "object"}, {"type": "object"})
TOOL_DECLARATIONS = {
    "chat_completions": {"tools": [{"type": "function", "function": {"name": "wait", "parameters": {"type": "object"}}}]},
    "responses": {"tools": [{"type": "function", "name": "wait", "parameters": {"type": "object"}}]},
    "anthropic_messages": {"tools": [{"name": "wait", "input_schema": {"type": "object"}}]},
}
SLOW = Turn(ttfb=0.1, stream=Stream(chunks=4, gap=0.1), text="Working.", act={"wait": 1.0}, usage=Usage(prompt=1000, completion=50))
TWO = Turn(ttfb=0.1, stream=Stream(chunks=4, gap=0.05), act=[{"wait": 1.0}, {"wait": 0.5}], usage=Usage(prompt=1000, completion=60))


@pytest.fixture(scope="module")
def mock() -> Iterator[MockProvider]:
    with MockProvider() as provider:
        yield provider


def served(tmp_path: Path, upstream_base: str, label: str = "mock-a", transport=None) -> tuple[LoopbackServer, fakes.Rig]:
    host = upstream_base.split("/")[2].split(":")[0]
    endpoint = dataclasses.replace(make_endpoint(upstream_base, label), mock_hosts=(host,))
    rig = make_rig(tmp_path, transport, policy=make_policy(tools=(WAIT_TOOL,)), endpoint=endpoint)
    return LoopbackServer(rig.services.app), rig


def post(server: LoopbackServer, path: str, body: dict, **kwargs) -> httpx.Response:
    return httpx.post(server.base_url + path, json=body, headers={"authorization": f"Bearer {TOKEN}"}, timeout=30, **kwargs)


@pytest.mark.parametrize("dialect", DIALECTS)
def test_streamed_proposal_is_relayed_incrementally_assembled_and_executable(mock: MockProvider, tmp_path: Path, dialect: str) -> None:
    handle = mock.register(Scenario(name="s", turns=[SLOW]), harness="nanoagent", model=fakes.MODEL)
    server, rig = served(tmp_path, handle.base_url)
    with server:
        body = {**REQUESTS[dialect](), **TOOL_DECLARATIONS[dialect], "stream": True}
        arrivals: list[float] = []
        started = time.perf_counter()
        with httpx.stream("POST", server.base_url + PATHS[dialect], json=body, headers={"authorization": f"Bearer {TOKEN}"}, timeout=30) as response:
            assert response.status_code == 200
            call_id = response.headers["x-rush-call-id"]
            for _ in response.iter_raw():
                arrivals.append(time.perf_counter() - started)
        assert arrivals[0] < arrivals[-1] - 0.2, arrivals  # frames arrive as the upstream produces them, not at the end
        data = recorded(rig, "model_call.response")[-1].data
        assert data["terminal"] == "completed" and data["frame_count"] > 3 and data["http_status"] == 200
        [proposal] = data["proposals"]
        assert proposal["name"] == "wait" and proposal["arguments"] == {"wait_seconds": 1.0}
        assert data["usage"]["input"] == 1000 and data["usage"]["output"] == 50
        [registration] = data["registrations"]
        assert registration["early"] is True and registration["frame_index"] is not None and registration["tool_call_id"] == proposal["call_id"]
        assert rig.admission.settled[call_id][1].startswith(dialect)
        link = {"model_call_id": call_id, "tool_call_id": proposal["call_id"]}
        tool = httpx.post(server.base_url + "/tools", json={"name": "wait", "arguments": {"wait_seconds": 1.0}, "cause": link}, headers={"authorization": f"Bearer {TOKEN}"})
        assert tool.status_code == 200 and recorded(rig, "tool.invoked")[-1].data["adapted"] is False
    handle.ledger.assert_clean()
    [served_call] = handle.ledger.main_calls
    assert served_call.request.auth == fakes.UPSTREAM_KEY and served_call.request.auth_header == "authorization"
    assert served_call.request.body["provider"]["allow_fallbacks"] is False


@pytest.mark.parametrize("dialect", DIALECTS)
def test_fragmented_parallel_proposals_get_distinct_ids(mock: MockProvider, tmp_path: Path, dialect: str) -> None:
    handle = mock.register(Scenario(name="s", turns=[TWO]), harness="nanoagent", model=fakes.MODEL)
    server, rig = served(tmp_path, handle.base_url)
    with server:
        response = post(server, PATHS[dialect], {**REQUESTS[dialect](), **TOOL_DECLARATIONS[dialect], "stream": True})
        assert response.status_code == 200
        proposals = recorded(rig, "model_call.response")[-1].data["proposals"]
        assert sorted(p["arguments"]["wait_seconds"] for p in proposals) == [0.5, 1.0] and len({p["call_id"] for p in proposals}) == 2
        for proposal in proposals:
            link = {"model_call_id": response.headers["x-rush-call-id"], "tool_call_id": proposal["call_id"]}
            tool = httpx.post(server.base_url + "/tools", json={"name": "wait", "arguments": proposal["arguments"], "cause": link}, headers={"authorization": f"Bearer {TOKEN}"})
            assert tool.status_code == 200


def test_a_429_is_relayed_and_the_clients_retry_is_a_separate_admitted_call(mock: MockProvider, tmp_path: Path) -> None:
    handle = mock.register(Scenario(name="s", turns=[Turn(status=429), SLOW]), harness="nanoagent", model=fakes.MODEL)
    server, rig = served(tmp_path, handle.base_url)
    with server:
        client = openai.OpenAI(base_url=server.base_url + "/api/v1", api_key=TOKEN, max_retries=2)  # the SDK retries a 429 itself
        with client.chat.completions.stream(model=fakes.MODEL, messages=[{"role": "user", "content": PROMPT}], tools=TOOL_DECLARATIONS["chat_completions"]["tools"]) as stream:
            completion = stream.get_final_completion()
        assert completion.choices[0].message.tool_calls[0].function.name == "wait"
    responses = recorded(rig, "model_call.response", 2)
    assert [r.data["terminal"] for r in responses] == ["http_error", "completed"] and [r.data["http_status"] for r in responses] == [429, 200]
    first, second = (r.data["call_id"] for r in responses)
    assert first != second and set(rig.admission.reserved) == {first, second} and rig.admission.settled[first] == (Decimal(0), "http_429")
    assert [call.kind for call in handle.ledger.calls] == ["error", "main"]


def test_two_upstream_profiles_are_selected_purely_by_configuration(tmp_path: Path) -> None:
    destinations = []
    for index in range(2):
        with MockProvider() as provider:
            handle = provider.register(Scenario(name="s", turns=[SLOW]), harness="nanoagent", model=fakes.MODEL)
            server, rig = served(tmp_path / str(index), handle.base_url, label=f"mock-{index}")
            with server:
                assert post(server, PATHS["chat_completions"], {**chat_request(), **TOOL_DECLARATIONS["chat_completions"]}).status_code == 200
            assert len(handle.ledger.main_calls) == 1
            destinations.append(recorded(rig, "model_call.dispatched")[0].data["endpoint"])
    assert [d["label"] for d in destinations] == ["mock-0", "mock-1"] and destinations[0]["destination"] != destinations[1]["destination"]
    assert all(d["destination"].startswith("http://127.0.0.1:") and d["mode"] == "mock" for d in destinations)


def test_client_going_away_aborts_the_upstream_stream_and_leaves_the_call_uncertain(mock: MockProvider, tmp_path: Path) -> None:
    slow = Turn(ttfb=0.05, stream=Stream(chunks=10, gap=0.4), act={"wait": 1.0}, usage=Usage(prompt=10, completion=5))
    handle = mock.register(Scenario(name="s", turns=[slow]), harness="nanoagent", model=fakes.MODEL)
    server, rig = served(tmp_path, handle.base_url)
    with server:
        with httpx.stream("POST", server.base_url + PATHS["chat_completions"], json={**chat_request(stream=True), **TOOL_DECLARATIONS["chat_completions"]}, headers={"authorization": f"Bearer {TOKEN}"}, timeout=30) as response:
            next(response.iter_raw())
        deadline = time.monotonic() + 5
        while not rig.journal.of("model_call.response"):
            assert time.monotonic() < deadline, "the gateway never concluded the call"
            time.sleep(0.02)
    data = recorded(rig, "model_call.response")[0].data
    assert data["terminal"] == "client_disconnected" and rig.admission.uncertain == [data["call_id"]]
    deadline = time.monotonic() + 5
    while not handle.ledger.calls[0].aborted and time.monotonic() < deadline:
        time.sleep(0.02)
    assert handle.ledger.calls[0].aborted  # the upstream saw its connection close, well before the stream's 4 s


def test_connection_cut_midstream_is_recorded_and_uncertain(tmp_path: Path) -> None:
    frames = b"".join(fakes.chat_stream_chunks()[:2])
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()

    def cut_server() -> None:
        connection, _ = listener.accept()
        connection.recv(65536)
        connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 100000\r\n\r\n" + frames)
        time.sleep(0.1)
        connection.close()

    threading.Thread(target=cut_server, daemon=True).start()
    server, rig = served(tmp_path, f"http://127.0.0.1:{listener.getsockname()[1]}/api/v1")
    with server:
        post(server, PATHS["chat_completions"], chat_request(stream=True))
    listener.close()
    data = recorded(rig, "model_call.response")[0].data
    assert data["terminal"] == "transport_error" and data["http_status"] == 200 and data["frame_count"] == 2
    assert data["error"].startswith(("ReadError", "RemoteProtocolError")) and rig.admission.uncertain == [data["call_id"]]


def test_unreachable_upstream_never_dispatched_settles_at_zero(tmp_path: Path) -> None:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()  # nothing listens here now
    server, rig = served(tmp_path, f"http://127.0.0.1:{port}/api/v1")
    with server:
        response = post(server, PATHS["chat_completions"], chat_request())
    assert response.status_code == 502 and response.json()["error"]["code"] == "upstream_unreachable"
    assert rig.admission.settled[response.headers["x-rush-call-id"]] == (Decimal(0), "not_dispatched") and rig.admission.uncertain == []

