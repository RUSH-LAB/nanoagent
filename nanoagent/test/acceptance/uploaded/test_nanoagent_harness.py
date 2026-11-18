"""CLI acceptance gate: the real NanoAgent harness (the reference harness nanoagent, assembled by its assemble.py from the working tree)
works task_tools attempts against the scripted mock provider: an agent task, and a decide task.

Everything goes through the CLI steps with the real worker in the worker container: the worker builds the assembled source offline from
its hashed lock (the dependency registry is PyPI's, read-only and hash-verified, as deploy/worker/worker.openrouter.yaml does),
runs it in a microVM against the attempt's gateway and tool broker, and the plugin's task verifier judges the result.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_nanoagent_harness.py -m uploaded_acceptance
"""

from __future__ import annotations

import json
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

import gate_support as gate  # noqa: E402
import plugins  # noqa: E402
import support  # noqa: E402
from mockllm import MockProvider, RunHandle, load_scenario  # noqa: E402
from rush_server import RushServer, rush_server, unavailable, worker_credential  # noqa: E402
from support import REFERENCE, Cli  # noqa: E402

from nanoagent.plugin import load_manifest  # noqa: E402
from nanoagent.plugin.package import pack  # noqa: E402
from nanoagent.plugin.tasks import decide_prompt, task_prompt  # noqa: E402
from nanoagent.uploaded.client import BenchmarkClient  # noqa: E402

pytestmark = [pytest.mark.microsandbox, pytest.mark.uploaded_acceptance]

AGENT, DECIDE = "na-agent", "na-decide"
PYPI = "https://pypi.org/simple"


@dataclass
class Run:
    report: Any
    view: dict[str, Any]
    attempt: dict[str, Any]
    events: list[dict[str, Any]]
    spans: dict[str, Any]
    accounting: dict[str, Any]

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [event for event in self.events if event["kind"] == kind]


@dataclass
class Evidence:
    agent: Run
    decide: Run
    decide_trace: dict[str, Any]  # step 3's trace.json of the decide attempt, kept beside the run's artifacts
    handle: RunHandle
    manifests: dict[str, Any]
    client: BenchmarkClient
    worker_log: str


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable() or support.container_unavailable()
    if reason:
        pytest.skip(reason)
    with rush_server() as server:
        yield server


def collect(client: BenchmarkClient, report: Any) -> Run:
    view = client.run(report.run_id)
    attempt_id = view["cases"][0]["attempts"][0]["attempt_id"]
    return Run(report, view, view["cases"][0]["attempts"][0], client.events(attempt_id).events, client.spans(attempt_id), client.accounting(attempt_id))


@pytest.fixture(scope="module")
def evidence(rush: RushServer) -> Iterator[Evidence]:
    run_dir = support.SCRATCH / f"nanoagent-{uuid.uuid4().hex[:8]}"
    run_dir.mkdir(parents=True)
    cli = Cli(rush.base_url, rush.workspace_id, rush.token, support.FINAL / "nanoagent-harness" / run_dir.name, rush.user_id)
    client = BenchmarkClient(rush.base_url, rush.workspace_id, rush.token)
    manifests = {}
    for plugin_id, options in ((AGENT, {}), (DECIDE, {"decide": True})):
        folder = plugins.variant(run_dir / f"plugin-{plugin_id}", plugin_id=plugin_id, **options)
        manifests[plugin_id] = load_manifest(folder)
        rush.seed_plugin(pack(folder))
    gate.cases_file(run_dir / "agent.json", AGENT, ["alpha"], [], "Synthetic.")
    gate.cases_file(run_dir / "decide.json", DECIDE, ["alpha"], [], "Synthetic.")
    for name in (AGENT, DECIDE):
        gate.publish_benchmark(cli, run_dir / f"step1-{name}", name=name, cases=run_dir / f"{name.removeprefix('na-')}.json")
    with MockProvider() as provider:
        handle = provider.register(load_scenario(support.SCENARIOS / "nanoagent-harness.yaml"), harness="nanoagent", model=support.MODEL, refs={"reference": REFERENCE})
        config = run_dir / "worker.yaml"
        worker = support.Worker("nanoagent-harness", config, cli.logs / "worker.log", credential=worker_credential(cli.base_url, cli.token))
        config.write_text(
            support.worker_yaml(
                base_url=f"http://{support.HOST}:{rush.base_url.rsplit(':', 1)[1]}",
                upstream=handle.base_url.replace("127.0.0.1", support.HOST),
                index=PYPI,
                scratch=f"{worker.home}/scratch",
            )
        )
        worker.start()
        try:
            reports = {
                name: gate.submit(cli, run_dir / f"step2-{name}", name, plugin=name, key=name, source=None, reference="nanoagent", policy="task_tools", follow_timeout=1500)
                for name in (AGENT, DECIDE)
            }
        finally:
            worker.stop()
        agent, decide = collect(client, reports[AGENT]), collect(client, reports[DECIDE])
        # The decide run's saved trace (step 3), read back by the assertions below.
        cli.step("3", "trace", run_dir / "trace-decide", f"attempt_id={decide.attempt['attempt_id']}")
        decide_trace = support.json_of(run_dir / "trace-decide" / "trace.json")
        yield Evidence(agent, decide, decide_trace, handle, manifests, client, worker.text())


def test_nanoagent_works_an_agent_task_with_the_brokered_tools(evidence: Evidence) -> None:
    run = evidence.agent
    assert (run.attempt["execution"]["status"], run.attempt["verdict"], run.attempt["sealed"]) == ("answered", "pass", True)
    assert run.view["score"]["value"] == 1 and run.view["policy"] == "task_tools"
    [wait] = run.of("tool.invoked")
    assert wait["data"]["tool"] == "wait" and wait["source"] == "tool_broker" and wait["data"]["cause"] is not None
    [link] = [link for link in run.spans["links"] if link["kind"] == "proposal_invocation"]
    assert link["method"] == "broker_cause"
    assert [e["data"]["tool"] for e in run.of("tool.completed")] == ["wait"] and run.of("tool.completed")[0]["data"]["ok"] is True
    # The answer was NanoAgent's `submit` tool call, read from RUSH_RESULT.
    [outcome] = run.of("result.read")
    assert outcome["data"]["outcome"] == {"status": "answered", "answer": {"digest": REFERENCE}}


def test_the_agents_prompt_is_the_pinned_one_byte_for_byte(evidence: Evidence) -> None:
    [case] = evidence.agent.view["cases"]
    system, user = task_prompt(evidence.manifests[AGENT], evidence.manifests[AGENT].task("probe"), case["arguments"])
    assert case["prompt"]["system"] == system and case["prompt"]["user"] == user
    first = evidence.handle.ledger.calls[0].request
    assert first is not None
    assert [m["content"] for m in first.messages if m["role"] == "system"] == [system]
    assert [m["content"] for m in first.messages if m["role"] == "user"][0] == user


def test_nanoagent_works_a_decide_task_through_structured_answers(evidence: Evidence) -> None:
    run = evidence.decide
    assert (run.attempt["execution"]["status"], run.attempt["verdict"]) == ("answered", "pass")
    assert run.view["case_set"]["task"]["kind"] == "decide"
    [case] = run.view["cases"]
    # A decide task's prompt is its system text alone; the user text is NanoAgent's own state-and-questions message.
    assert case["prompt"]["user"] is None and case["prompt"]["system"] == decide_prompt(evidence.manifests[DECIDE], evidence.manifests[DECIDE].task("probe"))
    decide_calls = [c for c in evidence.handle.ledger.calls if c.request is not None and "response_format" in c.request.body]
    assert len(decide_calls) == 2 == len(run.of("model_call.response"))
    for call in decide_calls:
        assert call.request is not None
        assert [m["content"] for m in call.request.messages if m["role"] == "system"] == [case["prompt"]["system"]]
        # The gateway forwards `provider.require_parameters: true` for a structured answer, and never lets a fallback in.
        assert call.request.body["provider"]["require_parameters"] is True and call.request.body["provider"]["allow_fallbacks"] is False
    admitted = run.of("model_call.admitted")
    assert all(e["data"]["request_headers"].get("user-agent") for e in admitted) and not run.of("model_call.rejected")


def test_a_decide_task_calls_its_tool_as_the_harness_with_no_proposal_and_stays_complete(evidence: Evidence) -> None:
    run = evidence.decide
    [invoked] = run.of("tool.invoked")
    assert invoked["data"]["tool"] == "wait" and invoked["data"].get("cause") is None
    # No model proposed the call, so no proposal link exists, and the missing cause is not a coverage loss.
    assert [link for link in run.spans["links"] if link["kind"] == "proposal_invocation"] == []
    assert run.attempt["coverage"]["status"] == "complete" and run.attempt["coverage"]["loss_reasons"] == []
    decisions = [span for span in run.spans["spans"] if span["kind"] == "decision"]
    assert len(decisions) >= 2
    [tool_span] = [span for span in run.spans["spans"] if span["kind"] == "tool"]
    assert tool_span["parent"] in {span["id"] for span in run.spans["spans"] if span["kind"] == "decision"}


def test_the_saved_decide_trace_is_system_only_with_harness_initiated_calls_under_decisions(evidence: Evidence) -> None:
    trace = evidence.decide_trace
    assert trace["attempt"]["attempt_id"] == evidence.decide.attempt["attempt_id"] and trace["sealed"] is True
    assert trace["attempt"]["coverage"]["status"] == "complete" and trace["attempt"]["coverage"]["loss_reasons"] == []
    # The pinned prompt is the task's system text alone: no user text, and the upstream requests carry that system text as given.
    [case] = evidence.decide.view["cases"]
    assert case["prompt"]["user"] is None and case["prompt"]["system"] is not None
    first = next(c.request for c in evidence.handle.ledger.calls if c.request is not None and "response_format" in c.request.body)
    kept = support.FINAL / "nanoagent-harness"
    kept.mkdir(parents=True, exist_ok=True)
    (kept / "decide-first-request.json").write_text(json.dumps(first.body, indent=1, sort_keys=True))  # the evidence: the first upstream body as the mock saw it
    assert [m["content"] for m in first.messages if m["role"] == "system"] == [case["prompt"]["system"]]
    # System-only: no message of the first upstream request is a user message equal to a prompt.user (the pinned prompt has none).
    assert case["prompt"]["user"] is None
    assert all(m["content"] != case["prompt"]["user"] for m in first.messages if m["role"] == "user")
    # Every broker call is the harness's own (no cause: no model proposed it) and sits under a decision span.
    spans = {span["id"]: span for span in trace["spans"]}
    invoked = [e for e in trace["events"] if e["kind"] == "tool.invoked"]
    assert invoked and all(e["data"].get("cause") is None for e in invoked)
    tools = [span for span in trace["spans"] if span["kind"] == "tool"]
    assert len(tools) == len(invoked) and all(spans[span["parent"]]["kind"] == "decision" for span in tools)
    assert [link for link in trace["links"] if link["kind"] == "proposal_invocation"] == []
    assert trace["accounting"]["totals"]["calls"] == len([e for e in trace["events"] if e["kind"] == "model_call.response"]) == 2


def test_both_attempts_are_sealed_with_complete_gateway_accounting(evidence: Evidence) -> None:
    for run, calls in ((evidence.agent, 3), (evidence.decide, 2)):
        assert run.attempt["sealed"] and run.attempt["coverage"]["status"] == "complete"
        assert run.accounting["totals"]["calls"] == calls
        assert run.attempt["metrics"]["model_calls"] == calls and run.attempt["metrics"]["usage_complete"] is True
    assert len(evidence.handle.ledger.calls) == 5 and not evidence.handle.ledger.violations
    assert json.dumps(evidence.agent.view["limits"]) == json.dumps(evidence.decide.view["limits"])
