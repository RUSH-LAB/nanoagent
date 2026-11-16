"""CLI acceptance gate: the reference harnesses Claude Code and Codex, end to end under the coding policy.

Each harness (the reference harnesses claude-code and codex) is uploaded through the CLI's `reference:` path, built network-less by the real worker from
its lock with the default limits, and run against the scripted mock provider (Claude Code over the `anthropic_messages` dialect,
Codex over `responses`) on an answer case and a refusal case of the probe plugin's task. The harness writes `answer.json` through
its own shell tool (mockllm/actions.py renders the scripted answer per harness); the worker reads it from the frozen workspace and
the plugin's verifier judges it.

    .venv/bin/python -m pytest test/acceptance/uploaded/test_reference_harnesses.py -m uploaded_acceptance
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

from nanoagent.plugin.package import pack  # noqa: E402
from nanoagent.uploaded.client import BenchmarkClient  # noqa: E402
from nanoagent.uploaded.contract import contains_first_prompt  # noqa: E402

pytestmark = [pytest.mark.gvisor, pytest.mark.uploaded_acceptance]

PLUGIN = "probe-ref"
# harness folder -> (the dialect it speaks, the mock's action renderer for it)
HARNESSES = {"claude-code": ("anthropic_messages", "claude"), "codex": ("responses", "codex")}
OUTPUT_FIELD = {"anthropic_messages": "max_tokens", "responses": "max_output_tokens", "chat_completions": "max_tokens"}


@dataclass
class Attempt:
    case: dict[str, Any]
    attempt: dict[str, Any]
    events: list[dict[str, Any]]
    spans: dict[str, Any]
    accounting: dict[str, Any]

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [event for event in self.events if event["kind"] == kind]

    def refused_generations(self) -> list[dict[str, Any]]:
        """The gateway's rejections of anything but a route probe: Claude Code's `HEAD .../hello` connectivity check is not on the
        allowlist and is answered 404, which is the gateway working as designed and not a refused model request."""
        return [e for e in self.of("model_call.rejected") if not (e["data"]["code"] == "unsupported_route" and e["data"]["method"] == "HEAD")]


@dataclass
class Harness:
    name: str
    dialect: str
    run: dict[str, Any]
    attempts: dict[str, Attempt]  # "answer" and "refuse"
    handle: RunHandle
    client: BenchmarkClient
    worker_log: str


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable() or support.container_unavailable()
    if reason:
        pytest.skip(reason)
    with rush_server() as server:
        yield server


@pytest.fixture(scope="module")
def benchmark(rush: RushServer) -> Iterator[tuple[str, Path, Cli]]:
    run_dir = support.SCRATCH / f"reference-{uuid.uuid4().hex[:8]}"
    run_dir.mkdir(parents=True)
    cli = Cli(rush.base_url, rush.workspace_id, rush.token, support.FINAL / "reference-harnesses" / run_dir.name, rush.user_id)
    rush.seed_plugin(pack(plugins.variant(run_dir / "plugin", plugin_id=PLUGIN)))
    gate.cases_file(run_dir / "cases.json", PLUGIN, ["alpha"], ["refuse-me"], "Synthetic.")
    gate.publish_benchmark(cli, run_dir / "step1", name="reference", cases=run_dir / "cases.json")
    yield "reference", run_dir, cli


def run_harness(name: str, rush: RushServer, benchmark: tuple[str, Path, Cli]) -> Harness:
    dialect, renderer = HARNESSES[name]
    benchmark_name, run_dir, cli = benchmark
    client = BenchmarkClient(rush.base_url, rush.workspace_id, rush.token)
    with MockProvider() as provider:
        handle = provider.register(load_scenario(support.SCENARIOS / "reference-harness.yaml"), harness=renderer, model=support.MODEL, refs={"reference": REFERENCE})
        config = run_dir / f"{name}-worker.yaml"
        worker = support.Worker(f"reference-{name}", config, cli.logs / f"{name}-worker.log", credential=worker_credential(cli.base_url, cli.token))
        config.write_text(
            support.worker_yaml(
                base_url=f"http://{support.HOST}:{rush.base_url.rsplit(':', 1)[1]}",
                upstream=handle.base_url.replace("127.0.0.1", support.HOST),
                index="https://pypi.org/simple",
                socket=gate.SOCKET,
                scratch=f"{worker.home}/scratch",
            )
        )
        worker.start()
        try:
            # One attempt at a time, in case order: the answer case, then the refusal case, so each takes its own scripted turns.
            report = gate.submit(
                cli, run_dir / f"step2-{name}", benchmark_name, plugin=PLUGIN, key=f"reference-{name}", source=None, reference=name, policy="coding",
                follow_timeout=2400,
            )
        finally:
            worker.stop()
        run = client.run(report.run_id)
        attempts = {}
        for case in run["cases"]:
            attempt = case["attempts"][0]
            attempts["answer" if case["kind"] == "answer" else "refuse"] = Attempt(
                case, attempt, client.events(attempt["attempt_id"]).events, client.spans(attempt["attempt_id"]), client.accounting(attempt["attempt_id"])
            )
        # Keep the stored evidence with the logs: build/ is scratch.
        kept = support.FINAL / "reference-harnesses" / name
        kept.mkdir(parents=True, exist_ok=True)
        (kept / "run.json").write_text(json.dumps(run, indent=1))
        for kind, attempt in attempts.items():
            (kept / f"{kind}-events.json").write_text(json.dumps(attempt.events, indent=1))
            (kept / f"{kind}-spans.json").write_text(json.dumps(attempt.spans, indent=1))
            (kept / f"{kind}-accounting.json").write_text(json.dumps(attempt.accounting, indent=1))
        (kept / "ledger.json").write_text(json.dumps([{"dialect": c.dialect, "kind": c.kind, "status": c.status, "body": c.request.body if c.request else None} for c in handle.ledger.calls], indent=1, default=str))
        return Harness(name, dialect, run, attempts, handle, client, worker.text())


@pytest.fixture(scope="module", params=list(HARNESSES))
def harness(request: pytest.FixtureRequest, rush: RushServer, benchmark: tuple[str, Path, Cli]) -> Harness:
    return run_harness(request.param, rush, benchmark)


def test_the_harness_builds_with_the_default_limits_and_answers_and_refuses(harness: Harness) -> None:
    run = harness.run
    assert run["policy"] == "coding" and run["status"] == "complete" and run["limits"]["max_output_tokens_per_call"] == 4096
    answer, refuse = harness.attempts["answer"], harness.attempts["refuse"]
    assert (answer.attempt["execution"]["status"], answer.attempt["verdict"]) == ("answered", "pass"), answer.attempt
    assert (refuse.attempt["execution"]["status"], refuse.attempt["verdict"]) == ("refused", "pass"), refuse.attempt
    assert run["score"]["value"] == 1 and run["score"]["scored"] == 2
    for attempt in (answer, refuse):
        assert not attempt.of("build.completed") and attempt.attempt["sealed"]


def test_answer_json_is_read_from_the_frozen_workspace(harness: Harness) -> None:
    [answered] = harness.attempts["answer"].of("result.read")
    assert answered["data"]["outcome"] == {"status": "answered", "answer": {"digest": REFERENCE}}
    [refused] = harness.attempts["refuse"].of("result.read")
    assert refused["data"]["outcome"]["status"] == "refused" and "no digest" in refused["data"]["outcome"]["reason"]
    [snapshot] = harness.attempts["answer"].of("snapshot.taken")
    assert [entry["path"] for entry in snapshot["data"]["diff"]] == ["answer.json"]


def test_the_first_generation_request_carries_the_pinned_user_prompt_byte_for_byte(harness: Harness) -> None:
    for attempt in harness.attempts.values():
        user = attempt.case["prompt"]["user"]
        assert attempt.case["prompt"]["system"] is None and user
        admitted = attempt.of("model_call.admitted")
        # The gateway accepted it: it refuses a first generation request without the exact prompt until one has completed.
        assert admitted and attempt.refused_generations() == []
        first = next(e for e in admitted if e["data"].get("submitted_request_sha256"))
        body = json.loads(harness.client.payload(attempt.attempt["attempt_id"], first["data"]["submitted_request_sha256"]).data)
        assert contains_first_prompt(harness.dialect, body, user, None), body


def test_only_function_tools_reach_the_gateway_and_the_output_cap_is_respected(harness: Harness) -> None:
    cap = harness.run["limits"]["max_output_tokens_per_call"]
    requests = [call.request for call in harness.handle.ledger.calls if call.request is not None]
    assert requests and not harness.handle.ledger.violations
    for request in requests:
        for tool in request.body.get("tools") or []:
            assert tool.get("type", "function") in ("function", "custom"), tool
        limit = request.body.get(OUTPUT_FIELD[harness.dialect])
        assert limit is None or limit <= cap, (OUTPUT_FIELD[harness.dialect], limit)
    for attempt in harness.attempts.values():
        assert attempt.refused_generations() == []
    assert {call.dialect for call in harness.handle.ledger.calls} == {{"anthropic_messages": "anthropic", "responses": "responses"}[harness.dialect]}


def test_the_trace_is_complete_and_accounting_is_the_gateways_alone(harness: Harness) -> None:
    served = 0
    for attempt in harness.attempts.values():
        coverage = attempt.attempt["coverage"]
        assert coverage["status"] == "complete" and coverage["loss_reasons"] == [] and coverage["collector_complete"] is True, coverage
        sources = {event["source"] for event in attempt.events}
        assert {"worker", "gateway", "process"} <= sources and "tool_broker" not in sources, sources
        assert attempt.of("process.exec") and attempt.of("case.launched") and not attempt.of("verifier.completed")
        assert attempt.spans["spans"] is not None
        responses = attempt.of("model_call.response")
        assert responses and attempt.accounting["totals"]["calls"] == len(responses) == attempt.attempt["metrics"]["model_calls"]
        served += len(responses)
    # Every request the mock served arrived through the gateway: the recorded calls are exactly the ones it answered.
    assert served == len([call for call in harness.handle.ledger.calls if call.status == 200])
