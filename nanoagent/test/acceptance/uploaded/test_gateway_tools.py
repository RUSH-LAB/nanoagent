"""CLI acceptance gate: the gateway and hosted tools.

The scripted harness (harnesses/scripted) drives the attempt's gateway, tool broker, command service and event intake exactly as its
script says and reports what each answered. Everything runs through the CLI steps with the real worker in the Lima VM `gvisor-dev`
(see support.py), the real plugin tools in their own sandbox, the published case set, and the plugin verifier:

* the same source against two explicitly configured scripted upstreams by changing only the worker YAML (destination and endpoint
  label recorded, upstream credential swapped for the attempt token), and an attempt token that no other attempt's services accept;
* worker startup refuses a production profile with another URL, an unlisted mock host and a missing credential;
* an alternate model, routing and fallback fields, plugins, remote server tools, provider state, an unlisted route or dialect, an
  unauthorized, private or unknown tool and a direct outbound request are all refused and recorded;
* all three dialects with fragmented and parallel proposals, retries, a stream that dies and a 429;
* no tool sees the request, the result folder or the credential, and a tool is given no fixtures (none are staged);
* a link to a different tool or to an unknown proposal is refused and changed arguments are kept as an adaptation.

    .venv/bin/python -m pytest test/acceptance/uploaded -m uploaded_acceptance -k gateway
"""

from __future__ import annotations

import subprocess
import sys
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

NANOAGENT = Path(__file__).resolve().parents[3]
sys.path[:0] = [
    str(NANOAGENT / "test" / "uploaded"),
    str(NANOAGENT / "test" / "acceptance" / "benchmark"),
    str(NANOAGENT / "test" / "acceptance" / "uploaded"),
    str(NANOAGENT / "examples" / "uploaded_benchmark"),
    str(NANOAGENT / "examples" / "benchmark"),
]

import gateway_trace_support as gt  # noqa: E402
import support  # noqa: E402
from gateway_trace_support import Evidence, collect  # noqa: E402
from mockllm import MockProvider, RunHandle, load_scenario  # noqa: E402
from rush_server import RushServer, rush_server, unavailable  # noqa: E402
from support import Cli  # noqa: E402

from nanoagent.plugin.package import pack  # noqa: E402

pytestmark = [pytest.mark.gvisor, pytest.mark.uploaded_acceptance]

WORKER_TOKEN = "worker-acceptance-token"
NOTE = ("note.txt", "hello gateway")
ANSWER = {"path": "note.txt", "bytes": 13}
CHAT, RESPONSES, ANTHROPIC = "chat_completions", "responses", "anthropic_messages"
UPSTREAM_KEY = "synthetic-acceptance-key"


# -- the scripts --------------------------------------------------------------------------------------------------------------


def call(name: str, arguments: dict[str, Any], index: int, model: str, **fields: Any) -> dict[str, Any]:
    """A brokered tool call caused by proposal ``index`` of model step ``model``."""
    return {"op": "tool", "name": name, "arguments": arguments, "cause": {"from": model, "index": index}, **fields}


WRITE_NOTE = {"name": NOTE[0], "text": NOTE[1]}
CORE = [
    {"op": "model", "as": "m1", "stream": True},
    call("write_note", WRITE_NOTE, 0, "m1", **{"as": "t1"}),
    {"op": "model", "as": "m2", "stream": True, "after": "m1", "results": [{"index": 0, "tool": "t1"}]},
    {"op": "answer", "answer": ANSWER},
]


def policy_script(upstream: str) -> list[dict[str, Any]]:
    unknown_call = {"model_call_id": "00000000-0000-0000-0000-000000000000", "tool_call_id": "call_0"}
    return [
        # Before any request has succeeded the exact rendered prompt must be the first user message.
        {"op": "model", "prompt": False},
        # Credentials: the attempt token is the only one every service takes.
        {"op": "model", "token": "none"},
        {"op": "model", "token": "bad"},
        {"op": "tool", "name": "write_note", "arguments": WRITE_NOTE, "token": "none"},
        {"op": "exec", "argv": ["true"], "token": "bad"},
        {"op": "raw", "path": "/events", "body": {"protocol": "rush.harness.v1"}, "token": "none"},
        # The pinned model, routing, plugins, remote tools, provider state and output budget.
        {"op": "model", "model": "other/model"},
        {"op": "model", "extra": {"provider": {"order": ["somewhere"]}}},
        {"op": "model", "extra": {"models": ["a/b", "c/d"]}},
        {"op": "model", "extra": {"route": "fallback"}},
        {"op": "model", "extra": {"plugins": [{"id": "web"}]}},
        {"op": "model", "extra": {"tools": [{"type": "web_search"}]}},
        {"op": "model", "extra": {"store": True}},
        {"op": "model", "extra": {"max_tokens": 99999999}},
        # A dialect this run does not enable, and routes outside the allowlist.
        {"op": "model", "dialect": RESPONSES},
        {"op": "raw", "method": "GET", "path": "/api/v1/models"},
        {"op": "raw", "path": "/api/v1/embeddings", "body": {}},
        # Tools: one outside the policy, the plugin's private reference tool, one that does not exist, bad arguments.
        {"op": "tool", "name": "read_fixture", "arguments": {"name": "x"}},
        {"op": "tool", "name": "expected_note", "arguments": WRITE_NOTE},
        {"op": "tool", "name": "no_such_tool", "arguments": {}},
        {"op": "tool", "name": "write_note", "arguments": {"name": "x.txt"}},
        # The first request that may succeed: three proposals in one reply.
        {"op": "model", "as": "m1"},
        {
            "op": "parallel",
            "steps": [
                call("write_note", WRITE_NOTE, 0, "m1", **{"as": "t1"}),
                call("inspect_sandbox", {}, 1, "m1", **{"as": "t2"}),
            ],
        },
        # Proposal 2 asked for adapt.txt/"proposed"; the harness changes what it asks the tool to write: an adaptation.
        call("write_note", {"name": "adapt.txt", "text": "changed"}, 2, "m1", **{"as": "t3"}),
        # A link to a different tool, to an unknown proposal and to an unknown model call.
        call("copy_fixture", {"fixture": "greeting.txt", "name": "x.txt"}, 0, "m1"),
        {"op": "tool", "name": "write_note", "arguments": WRITE_NOTE, "cause": {"from": "m1", "tool_call_id": "call_999"}},
        {"op": "tool", "name": "write_note", "arguments": WRITE_NOTE, "cause": unknown_call},
        # Direct outbound requests from the case: the scripted upstream itself, the internet by name and by address.
        {"op": "http", "url": upstream},
        {"op": "http", "url": "https://openrouter.ai/api/v1/models"},
        {"op": "tcp", "host": "1.1.1.1", "port": 53},
        # A stream that dies after two chunks, a 429 and then the reply: the harness retries the same request.
        {"op": "model", "as": "m2", "stream": True, "retries": 3},
        {"op": "answer", "answer": ANSWER},
    ]


def dialect_script() -> list[dict[str, Any]]:
    steps: list[dict[str, Any]] = []
    files = {CHAT: NOTE, RESPONSES: ("responses.txt", "from responses"), ANTHROPIC: ("anthropic.txt", "from anthropic")}
    for dialect, (name, text) in files.items():
        token = "api-key" if dialect == ANTHROPIC else "good"  # an Anthropic client sends the attempt token as x-api-key
        steps += [
            {"op": "model", "as": f"{dialect}-1", "dialect": dialect, "stream": True, "token": token},
            {
                "op": "parallel",
                "steps": [
                    call("write_note", {"name": name, "text": text}, 0, f"{dialect}-1", **{"as": f"{dialect}-w"}),
                    call("inspect_sandbox", {}, 1, f"{dialect}-1", **{"as": f"{dialect}-i"}),
                ],
            },
            {
                "op": "model", "as": f"{dialect}-2", "dialect": dialect, "stream": True, "token": token, "after": f"{dialect}-1",
                "results": [{"index": 0, "tool": f"{dialect}-w"}, {"index": 1, "tool": f"{dialect}-i"}],
            },
            {"op": "model", "as": f"{dialect}-3", "dialect": dialect, "stream": False, "token": token},
        ]
    return [*steps, {"op": "answer", "answer": ANSWER}]


ISSUE_TOKEN = [{"op": "answer", "answer": {"path": "$token", "bytes": 0}}]


def foreign_token_script(token: str) -> list[dict[str, Any]]:
    """What another attempt's services would take as a credential: tried against every one of this attempt's services."""
    return [
        {"op": "model", "token": token},
        {"op": "model", "dialect": ANTHROPIC, "token": f"x-api-key:{token}"},
        {"op": "tool", "name": "inspect_sandbox", "arguments": {}, "token": token},
        {"op": "exec", "argv": ["true"], "token": token},
        {"op": "raw", "path": "/events", "body": {"protocol": "rush.harness.v1"}, "token": token},
        {"op": "tool", "name": "write_note", "arguments": WRITE_NOTE, "as": "own"},
        {"op": "answer", "answer": ANSWER},
    ]


# -- fixtures -----------------------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable() or support.vm_available()
    if reason:
        pytest.skip(reason)
    with pytest.MonkeyPatch.context() as env:
        env.setenv("BENCHMARK_WORKER_TOKEN", WORKER_TOKEN)
        with rush_server() as server:
            server.seed_plugin(pack(gt.note_plugin(support.SCRATCH / f"note-plugin-{uuid.uuid4().hex[:8]}")))
            yield server


@pytest.fixture(scope="module")
def run_dir() -> Path:
    path = support.SCRATCH / f"gateway-{uuid.uuid4().hex[:8]}"
    path.mkdir(parents=True)
    return path


@pytest.fixture(scope="module")
def cli(rush: RushServer, run_dir: Path) -> Cli:
    return Cli(rush.base_url, rush.workspace_id, rush.token, support.FINAL / "gateway-trace" / run_dir.name, rush.user_id)


@pytest.fixture(scope="module")
def registry(run_dir: Path) -> Iterator[int]:
    """The mocked dependency registry: exactly the wheels the two harnesses' requirements.txt files pin."""
    root = run_dir / "registry"
    support.wheelhouse(gt.SCRIPTED / "requirements.txt", root)
    with support.serve_directory(support.wheelhouse(gt.ANTHROPIC_SDK / "requirements.txt", root)) as port:
        yield port


# One scripted upstream serves several suites at once: a request goes to the scenario whose suite context is in its prompt.
SCENARIOS = {
    "gw-core": ("gateway-core.yaml", "<<gw-core>>"),
    "gw-policy": ("gateway-policy.yaml", "<<gw-policy>>"),
    "gw-dialects": ("gateway-dialects.yaml", "<<gw-dialects>>"),
    "gw-sdk": ("gateway-sdk.yaml", "<<gw-sdk>>"),
}


@pytest.fixture(scope="module")
def suites(rush: RushServer, cli: Cli, run_dir: Path) -> None:
    for suite in ("gw-core", "gw-policy", "gw-dialects", "gw-sdk"):
        gt.publish_note_benchmark(cli, run_dir, suite, *NOTE, SCENARIOS[suite][1], endpoint="mock-a")
    # The same case as gw-core on the other endpoint: the endpoint is the benchmark's, and the scripted upstream knows it as gw-core.
    gt.publish_note_benchmark(cli, run_dir, "gw-core-b", *NOTE, SCENARIOS["gw-core"][1], endpoint="mock-b", key="gw-core")


def register_pool(provider: MockProvider, *suites: str) -> tuple[str, dict[str, RunHandle]]:
    """One base URL for the suites' scenarios; each suite's handle (and ledger) by suite name."""
    members = {SCENARIOS[suite][1]: (load_scenario(support.SCENARIOS / SCENARIOS[suite][0]), {}) for suite in suites}
    base, handles = provider.register_pool(members, harness="probe", model=support.MODEL)
    return base, {suite: handles[SCENARIOS[suite][1]] for suite in suites}


def submit_and_collect(
    name: str, suite: str, steps: list[dict[str, Any]] | None, handle: RunHandle | None, *, cli: Cli, run_dir: Path, dialects: str = CHAT
) -> Evidence:
    """Submit the scripted harness running ``steps`` (or, with none, the Anthropic SDK harness) and read the sealed trace."""
    source = gt.sdk_source(run_dir / f"source-{name}") if steps is None else gt.scripted_source(run_dir / f"source-{name}", steps)
    report = gt.submit(cli, run_dir, source, suite, name, dialects=dialects)
    return collect(cli, run_dir, report, handle, name)


# -- phase A: scripted upstream A ---------------------------------------------------------------------------------------------


@dataclass
class PhaseA:
    core: Evidence
    policy: Evidence
    dialects: Evidence
    sdk: Evidence
    issued: Evidence
    foreign: Evidence
    upstream: str  # the destination the gateway forwards to, as the worker names it
    worker_log: str


@pytest.fixture(scope="module")
def phase_a(rush: RushServer, cli: Cli, run_dir: Path, registry: int, suites: None) -> Iterator[PhaseA]:
    """One worker whose YAML names scripted upstream A (label mock-a) takes every run of this phase, one after another."""
    with MockProvider() as provider:
        base, handles = register_pool(provider, "gw-core", "gw-policy", "gw-dialects", "gw-sdk")
        worker = gt.start_worker("worker-a", rush.base_url, cli, run_dir, upstream=base, index=registry, label="mock-a")
        options = {"cli": cli, "run_dir": run_dir}
        try:
            core = submit_and_collect("a-core", "gw-core", CORE, handles["gw-core"], **options)
            upstream = base.split("/r/", 1)[0].replace("127.0.0.1", support.HOST)
            policy = submit_and_collect("a-policy", "gw-policy", policy_script(f"http://{support.HOST}:{base.split(':')[2].split('/')[0]}/"), handles["gw-policy"], **options)
            dialects = submit_and_collect("a-dialects", "gw-dialects", dialect_script(), handles["gw-dialects"], **options, dialects=f"{CHAT},{RESPONSES},{ANTHROPIC}")
            sdk = submit_and_collect("a-sdk", "gw-sdk", None, handles["gw-sdk"], **options, dialects=ANTHROPIC)
            issued = submit_and_collect("a-issue-token", "gw-core", ISSUE_TOKEN, None, **options)
            [result] = issued.events("result.read")
            foreign = submit_and_collect("a-foreign-token", "gw-core", foreign_token_script(result["data"]["outcome"]["answer"]["path"]), None, **options)
        finally:
            worker.stop()
    yield PhaseA(core, policy, dialects, sdk, issued, foreign, upstream, worker.text())


@dataclass
class PhaseB:
    core: Evidence
    upstream: str


@pytest.fixture(scope="module")
def phase_b(rush: RushServer, cli: Cli, run_dir: Path, registry: int, phase_a: PhaseA) -> Iterator[PhaseB]:
    """The same source on a second scripted upstream (label mock-b): only the worker's YAML differs from phase A."""
    with MockProvider() as provider:
        base, handles = register_pool(provider, "gw-core")
        worker = gt.start_worker("worker-b", rush.base_url, cli, run_dir, upstream=base, index=registry, label="mock-b")
        try:
            core = submit_and_collect("b-core", "gw-core-b", CORE, handles["gw-core"], cli=cli, run_dir=run_dir)
        finally:
            worker.stop()
    yield PhaseB(core, base.split("/r/", 1)[0].replace("127.0.0.1", support.HOST))


# -- one source, two upstreams ------------------------------------------------------------------------------------------------


def usage_of(event: dict[str, Any]) -> tuple[int, int, int, int, int]:
    """The recorded usage as the mock's ledger states it: a field a dialect cannot carry is unknown here and zero there."""
    usage = event["data"]["usage"]
    return usage["input"], usage["cache_read"] or 0, usage["cache_write"] or 0, usage["output"], usage["reasoning"] or 0


def ledger_usage(call: Any) -> tuple[int, int, int, int, int]:
    usage = call.usage
    return usage.input, usage.cached, usage.cache_write, usage.output, usage.reasoning


def test_the_same_source_runs_against_two_configured_upstreams(phase_a: PhaseA, phase_b: PhaseB) -> None:
    a, b = phase_a.core, phase_b.core
    for evidence, profile in ((a, "mock-a"), (b, "mock-b")):
        assert evidence.run.endpoint_profile == profile
        assert (evidence.attempt.execution_status, evidence.attempt.verdict) == ("answered", "pass")
    started = {e.attempt_id: e.events("attempt.started")[0]["data"] for e in (a, b)}
    assert started[a.attempt_id]["source_sha256"] == started[b.attempt_id]["source_sha256"], "the same uploaded source"
    assert started[a.attempt_id]["endpoint"] == {"label": "mock-a", "mode": "mock"}
    assert started[b.attempt_id]["endpoint"] == {"label": "mock-b", "mode": "mock"}
    assert phase_a.upstream != phase_b.upstream
    for evidence, upstream, label in ((a, phase_a.upstream, "mock-a"), (b, phase_b.upstream, "mock-b")):
        dispatched = evidence.events("model_call.dispatched")
        assert len(dispatched) == 2
        for event in dispatched:
            assert event["data"]["endpoint"] == {"label": label, "mode": "mock", "destination": upstream}
            assert event["data"]["url"].startswith(f"{upstream}/r/") and event["data"]["url"].endswith("/api/v1/chat/completions")
        # Each scripted upstream served exactly this run's calls, with the worker's credential and not the attempt's.
        assert evidence.handle is not None
        assert len(evidence.handle.ledger.calls) == 2 and not evidence.handle.ledger.violations
        assert {c.request.auth for c in evidence.handle.ledger.calls if c.request} == {UPSTREAM_KEY}
    assert [usage_of(e) for e in a.events("model_call.response")] == [usage_of(e) for e in b.events("model_call.response")]
    assert [ledger_usage(c) for c in a.handle.ledger.main_calls] == [usage_of(e) for e in a.events("model_call.response")]  # type: ignore[union-attr]


def test_the_attempt_token_is_scoped_to_its_own_attempt(phase_a: PhaseA) -> None:
    issued, foreign = phase_a.issued, phase_a.foreign
    [result] = issued.events("result.read")
    token = result["data"]["outcome"]["answer"]["path"]
    assert len(token) >= 32, "the first attempt's credential, which its harness wrote as its answer"
    # Another attempt's credential, as a bearer or as x-api-key, opens none of this attempt's four services ...
    assert foreign.rejected("model_call.rejected") == ["unauthorized", "unauthorized"]
    assert foreign.rejected("tool.rejected") == ["unauthorized"]
    assert foreign.rejected("exec.rejected") == ["unauthorized"]
    assert foreign.rejected("harness.rejected") == ["unauthorized"]
    statuses = [o["attempts"][0]["status"] if o["op"] == "model" else o["status"] for o in foreign.observed if o["op"] in ("model", "tool", "exec", "raw")]
    assert statuses == [401, 401, 401, 401, 401, 200]
    # ... while this attempt's own credential works, and nothing reached the scripted upstream.
    [own] = foreign.where(op="tool", **{"as": "own"})
    assert own["output"] == ANSWER and (foreign.attempt.execution_status, foreign.attempt.verdict) == ("answered", "pass")
    assert not foreign.events("model_call.dispatched") and issued.attempt.execution_status == "answered"
    # A credential is never kept as evidence: the stored copy of the first attempt's own answer is the only place it appears.
    assert all(token.encode() not in blob for blob in foreign.payloads.values())


def test_every_attempt_forwards_with_the_workers_credential(phase_a: PhaseA) -> None:
    for evidence in (phase_a.core, phase_a.policy, phase_a.dialects):
        assert evidence.handle is not None and not evidence.handle.ledger.violations
        assert {c.request.auth for c in evidence.handle.ledger.calls if c.request} == {UPSTREAM_KEY}
    admitted = phase_a.dialects.events("model_call.admitted")
    assert all("authorization" not in event["data"]["request_headers"] and "x-api-key" not in event["data"]["request_headers"] for event in admitted)


# -- refusals -----------------------------------------------------------------------------------------------------------------


def test_the_gateway_refuses_and_records_what_the_policy_forbids(phase_a: PhaseA) -> None:
    policy = phase_a.policy
    assert policy.rejected("model_call.rejected") == [
        "first_prompt_missing", "unauthorized", "unauthorized", "model_not_pinned", "provider_routing_forbidden", "fallback_forbidden", "fallback_forbidden",
        "plugins_forbidden", "server_tool_forbidden", "provider_state_forbidden", "output_cap_exceeded", "dialect_not_enabled", "unsupported_route", "unsupported_route",
    ]  # fmt: skip
    statuses = [event["data"]["http_status"] for event in policy.events("model_call.rejected")]
    assert statuses == [400, 401, 401, 400, 400, 400, 400, 400, 400, 400, 400, 404, 404, 404]
    assert all(event["data"]["admitted"] is False for event in policy.events("model_call.rejected"))
    # Only the four requests the script meant to succeed were forwarded: a refused request never reached the upstream.
    assert len(policy.events("model_call.dispatched")) == 4
    assert [(c.kind, c.status) for c in policy.handle.ledger.calls] == [("main", 200), ("main", 200), ("error", 429), ("main", 200)]  # type: ignore[union-attr]
    assert not policy.handle.ledger.violations  # type: ignore[union-attr]
    # The refused model requests and the harness's own view agree.
    assert [o["attempts"][0]["code"] for o in policy.where(op="model")][:12] == [c for c in policy.rejected("model_call.rejected") if c != "unsupported_route"]
    assert [o["code"] for o in policy.where(op="raw", method="GET")] == ["unsupported_route"]
    assert policy.rejected("harness.rejected") == ["unauthorized"]
    assert policy.rejected("exec.rejected") == ["unauthorized"]


def test_unauthorized_private_and_unknown_tools_are_refused_and_recorded(phase_a: PhaseA) -> None:
    policy = phase_a.policy
    assert policy.rejected("tool.rejected") == [
        "unauthorized", "tool_not_available", "tool_not_available", "tool_not_available", "invalid_arguments", "tool_mismatch", "unknown_proposal", "unknown_proposal",
    ]  # fmt: skip
    rejected = {e["data"]["tool"] for e in policy.events("tool.rejected")}
    assert {"read_fixture", "expected_note", "no_such_tool"} <= rejected
    # The private reference tool and the unpermitted one never ran: the only invocations are the three permitted calls.
    assert sorted(e["data"]["tool"] for e in policy.events("tool.invoked")) == ["inspect_sandbox", "write_note", "write_note"]
    assert {o["name"]: (o["status"], o["code"]) for o in policy.where(op="tool") if o["name"] in ("expected_note", "read_fixture")} == {
        "expected_note": (403, "tool_not_available"),
        "read_fixture": (403, "tool_not_available"),
    }
    assert not any(e["data"]["tool"] in ("expected_note", "read_fixture") for e in policy.events("tool.invoked"))


def test_a_link_to_a_different_tool_is_refused_and_changed_arguments_are_kept_as_an_adaptation(phase_a: PhaseA) -> None:
    policy = phase_a.policy
    [first] = [e for e in policy.events("model_call.response") if e["data"]["proposals"] and len(e["data"]["proposals"]) == 3]
    proposals = {p["call_id"]: p for p in first["data"]["proposals"]}
    assert [p["name"] for p in proposals.values()] == ["write_note", "inspect_sandbox", "write_note"]
    model_call = first["data"]["call_id"]
    invoked = {e["data"]["cause"]["tool_call_id"]: e["data"] for e in policy.events("tool.invoked")}
    assert set(invoked) == set(proposals) and all(data["cause"]["model_call_id"] == model_call for data in invoked.values())
    adapted = [data for data in invoked.values() if data["adapted"]]
    assert len(adapted) == 1 and adapted[0]["adaptation"]["proposal_arguments"] == {"name": "adapt.txt", "text": "proposed"}
    assert adapted[0]["adaptation"]["actual_arguments"] == {"name": "adapt.txt", "text": "changed"}
    assert adapted[0]["adaptation"]["model_call_id"] == model_call
    # The refused link names the mismatch, the unknown proposal and the unknown model call.
    messages = {e["data"]["code"]: e["data"]["message"] for e in policy.events("tool.rejected") if e["data"]["code"] in ("tool_mismatch", "unknown_proposal")}
    assert "proposed 'write_note'" in messages["tool_mismatch"] and "'copy_fixture'" in messages["tool_mismatch"]
    links = [link for link in policy.trace.links if link["kind"] == "proposal_invocation"]
    assert sorted(link["method"] for link in links) == ["broker_cause", "broker_cause", "broker_cause_adaptation"]
    assert all(not any(link["to"] == f"t:{e['data']['call_id']}" for link in links) for e in policy.events("tool.rejected") if "call_id" in e["data"])
    # The adaptation is what the tool ran: adapt.txt holds the changed text in the workspace snapshot.
    [snapshot] = policy.events("snapshot.taken")
    assert {entry["path"] for entry in snapshot["data"]["diff"]} == {"adapt.txt", "note.txt"}


def test_a_direct_outbound_request_cannot_leave_the_case(phase_a: PhaseA) -> None:
    policy = phase_a.policy
    direct = [o for o in policy.observed if o["op"] in ("http", "tcp")]
    assert len(direct) == 3 and all(o["error"] is not None for o in direct), direct
    [tcp] = [o for o in direct if o["op"] == "tcp"]
    assert tcp["errno"] == 101, "ENETUNREACH: the attempt network is internal"
    # None of them reached the scripted upstream (only the four gateway requests did) and the case was still scored.
    assert len(policy.handle.ledger.calls) == 4  # type: ignore[union-attr]
    assert (policy.attempt.execution_status, policy.attempt.verdict) == ("answered", "pass")


# -- retries, midstream errors, dialects ---------------------------------------------------------------------------------------


def test_retries_and_a_stream_that_dies_are_recorded_per_physical_request(phase_a: PhaseA) -> None:
    policy = phase_a.policy
    responses = policy.events("model_call.response")
    assert [e["data"]["terminal"] for e in responses] == ["completed", "interrupted", "http_error", "completed"]
    _, cut, limited, recovered = responses
    assert cut["data"]["http_status"] == 200 and cut["data"]["frame_count"] >= 1
    assert (limited["data"]["http_status"], limited["data"]["terminal"]) == (429, "http_error")
    assert recovered["data"]["terminal"] == "completed" and recovered["data"]["http_status"] == 200
    assert len({e["data"]["call_id"] for e in responses}) == len(responses) == 4, "one call ID per physical request"
    # One request sent three times: each retry points at the failed request before it.
    retries = [link for link in policy.trace.links if link["kind"] == "retry"]
    assert sorted((link["from"], link["to"]) for link in retries) == sorted(
        [(f"m:{recovered['data']['call_id']}", f"m:{limited['data']['call_id']}"), (f"m:{limited['data']['call_id']}", f"m:{cut['data']['call_id']}")]
    )
    harness = [o for o in policy.observed if o["op"] == "model" and o.get("as") == "m2"][0]
    assert [a["status"] for a in harness["attempts"]] == [200, 429, 200] and [a["complete"] for a in harness["attempts"]] == [False, False, True]
    assert policy.where(op="model", **{"as": "m2"})[0]["attempts"][-1]["call_id"] == recovered["data"]["call_id"]


def test_all_three_dialects_assemble_fragmented_parallel_proposals_and_reconcile_usage(phase_a: PhaseA) -> None:
    evidence = phase_a.dialects
    assert [e["data"]["dialect"] for e in evidence.events("model_call.admitted")] == [CHAT] * 3 + [RESPONSES] * 3 + [ANTHROPIC] * 3
    assert [e["data"]["stream"] for e in evidence.events("model_call.admitted")] == [True, True, False] * 3
    responses = evidence.events("model_call.response")
    assert [e["data"]["terminal"] for e in responses] == ["completed"] * 9
    expected = {CHAT: ("note.txt", "hello gateway"), RESPONSES: ("responses.txt", "from responses"), ANTHROPIC: ("anthropic.txt", "from anthropic")}
    for number, dialect in enumerate(expected):
        first = responses[3 * number]["data"]
        name, text = expected[dialect]
        assert first["dialect"] == dialect and first["frame_count"] >= 6, "streamed in fragments"
        assert [(p["name"], p["arguments"]) for p in first["proposals"]] == [("write_note", {"name": name, "text": text}), ("inspect_sandbox", {})]
        assert len({p["call_id"] for p in first["proposals"]}) == 2
    served = evidence.handle.ledger.main_calls  # type: ignore[union-attr]
    assert len(served) == 9
    for event, call in zip(responses, served, strict=True):
        assert usage_of(event) == ledger_usage(call) and event["data"]["usage"]["discrepancies"] == []
    # Fields a dialect does not report stay unknown rather than zero: no reasoning count in Messages, no cache writes in Responses.
    assert [e["data"]["usage"]["reasoning"] for e in responses[6:]] == [None] * 3 and [e["data"]["usage"]["cache_write"] for e in responses[3:6]] == [None] * 3
    links = evidence.trace.links
    assert sorted(link["method"] for link in links if link["kind"] == "proposal_invocation") == ["broker_cause"] * 6
    delivered = [link for link in links if link["kind"] == "result_delivery"]
    assert len(delivered) == 6 and {link["attributes"]["content_match"] for link in delivered} == {"exact"}
    assert (evidence.attempt.execution_status, evidence.attempt.verdict) == ("answered", "pass")
    # The upstream saw the Anthropic client's credential swapped too, and the follow-up turns carried the results.
    assert {c.request.dialect for c in served if c.request} == {"chat", "responses", "anthropic"}


def test_an_sdk_that_appends_v1_messages_is_routed_to_the_gateways_messages_endpoint(phase_a: PhaseA) -> None:
    sdk = phase_a.sdk
    assert (sdk.attempt.execution_status, sdk.attempt.verdict) == ("answered", "pass")
    admitted = sdk.events("model_call.admitted")
    assert [e["data"]["dialect"] for e in admitted] == [ANTHROPIC, ANTHROPIC] and [e["data"]["stream"] for e in admitted] == [True, False]
    # The SDK itself sent these: its user agent and the anthropic-version header it adds, and no other route was tried.
    assert all(e["data"]["request_headers"]["user-agent"].startswith("Anthropic/Python") and "anthropic-version" in e["data"]["request_headers"] for e in admitted)
    assert sdk.events("model_call.rejected") == []
    [proposal] = sdk.events("model_call.response")[0]["data"]["proposals"]
    assert (proposal["name"], proposal["arguments"]) == ("write_note", {"name": "note.txt", "text": "hello gateway"})
    [link] = [link for link in sdk.trace.links if link["kind"] == "proposal_invocation"]
    assert link["method"] == "broker_cause" and any(link["kind"] == "result_delivery" for link in sdk.trace.links)
    served = sdk.handle.ledger.main_calls  # type: ignore[union-attr]
    assert [ledger_usage(c) for c in served] == [usage_of(e) for e in sdk.events("model_call.response")]
    assert {c.path.rsplit("/api/v1", 1)[1] for c in served} == {"/messages"}


# -- tool sandbox ---------------------------------------------------------------------------------------------------------------


def test_a_tool_cannot_see_attempt_secrets_and_is_given_no_fixtures(phase_a: PhaseA) -> None:
    for evidence in (phase_a.policy, phase_a.dialects):
        reports = evidence.inspected()
        assert reports, "inspect_sandbox ran"
        for report in reports:
            assert report == {"readable": [], "rush_env": [], "fixtures": [], "fixtures_writable": False}, report


# -- worker startup -----------------------------------------------------------------------------------------------------------

STARTUP_REFUSALS = [
    ("production-http", {"mode": "openrouter", "upstream": "http://openrouter.ai/api/v1"}, "upstream_not_allowed"),
    ("production-lookalike", {"mode": "openrouter", "upstream": "https://openrouter.ai.example.invalid/api/v1"}, "upstream_not_allowed"),
    ("production-local-mock", {"mode": "openrouter", "upstream": "http://127.0.0.1:9/api/v1"}, "upstream_not_allowed"),
    ("production-with-mock-hosts", {"mode": "openrouter", "upstream": "https://openrouter.ai/api/v1", "keep_mock_hosts": True}, "unexpected_key"),
    ("production-no-credential", {"mode": "openrouter", "upstream": "https://openrouter.ai/api/v1", "key_env": "OPENROUTER_API_KEY_UNSET"}, "credential_missing"),
    ("mock-unlisted-host", {"mock_hosts": "[some-other-host]"}, "upstream_not_allowed"),
    ("mock-no-hosts", {"mock_hosts": None}, "missing_key"),
    ("mock-no-credential", {"key_env": "RUSH_BENCHMARK_MOCK_API_KEY_UNSET"}, "credential_missing"),
    ("unknown-mode", {"mode": "staging"}, "invalid_mode"),
]


@pytest.mark.parametrize(("name", "change", "code"), STARTUP_REFUSALS, ids=[case[0] for case in STARTUP_REFUSALS])
def test_worker_startup_refuses_an_invalid_endpoint_profile_or_a_missing_credential(name: str, change: dict[str, Any], code: str, tmp_path: Path) -> None:
    """The profile is validated before the worker touches Docker, the collector or the RUSH server, so this needs no VM."""
    text = support.worker_yaml(base_url="http://127.0.0.1:9", upstream=f"http://{support.HOST}:9/api/v1", index="http://127.0.0.1:9/simple", socket="/nonexistent/seccheck.sock", scratch=str(tmp_path / "scratch"))
    text = text.replace("  mode: mock\n", f"  mode: {change['mode']}\n") if "mode" in change else text
    if "upstream" in change:
        text = text.replace(f"upstream_base_url: http://{support.HOST}:9/api/v1", f"upstream_base_url: {change['upstream']}")
    if "key_env" in change:
        text = text.replace("api_key_env: RUSH_BENCHMARK_MOCK_API_KEY", f"api_key_env: {change['key_env']}")
    if "mock_hosts" in change or change.get("mode") == "openrouter" and not change.get("keep_mock_hosts"):
        hosts = change.get("mock_hosts")
        lines = [line for line in text.splitlines() if "mock_hosts:" not in line]
        if hosts is not None:
            lines.insert(next(i for i, line in enumerate(lines) if "api_key_env" in line) + 1, f"  mock_hosts: {hosts}")
        text = "\n".join(lines) + "\n"
    config = tmp_path / f"{name}.yaml"
    config.write_text(text)
    env = {"PATH": "/usr/bin:/bin", "BENCHMARK_WORKER_TOKEN": WORKER_TOKEN, "RUSH_BENCHMARK_MOCK_API_KEY": UPSTREAM_KEY}
    done = subprocess.run(
        [str(NANOAGENT / ".venv" / "bin" / "python"), "-m", "nanoagent.uploaded.worker", f"config={config}", f"home={tmp_path / 'home'}"],
        cwd=NANOAGENT, env={**env, "PYTHONPATH": str(NANOAGENT / "src")}, capture_output=True, text=True, timeout=120, check=False,
    )
    output = done.stdout + done.stderr
    assert done.returncode != 0 and f"EndpointConfigError: {code}" in output, output
    assert "claim" not in output, "the worker never asked RUSH for work"
