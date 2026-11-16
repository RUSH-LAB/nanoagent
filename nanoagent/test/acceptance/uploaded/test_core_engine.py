"""CLI acceptance gate 1: the NanoAgent core engine uploaded as a Python harness, and the process collector's startup and loss.

Run on the host (the worker itself runs in the worker container, see support.py):

    .venv/bin/python -m pytest test/acceptance/uploaded -m uploaded_acceptance

Everything is driven through the CLI steps in subprocesses with YAML configuration plus overrides: a scratch RUSH server, step 1
(publish the probe suite), step 2 (submit the source and follow the run), the real worker in the worker container with the real source build,
gVisor sandbox, gateway, tool broker, process collector and plugin verifier, and step 3 to read the saved trace, in a fresh process
with the scripted upstream and the worker stopped. Assertions use the CLI's machine-readable output and stored evidence.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from slimconfig import load_layout

NANOAGENT = Path(__file__).resolve().parents[3]
sys.path[:0] = [
    str(NANOAGENT / "test" / "uploaded"),
    str(NANOAGENT / "test" / "acceptance" / "benchmark"),
    str(NANOAGENT / "examples" / "uploaded_benchmark"),
    str(NANOAGENT / "examples" / "benchmark"),
]

import step2_submit_run  # noqa: E402
import step3_trace  # noqa: E402
import support  # noqa: E402
from mockllm import MockProvider, RunHandle, load_scenario  # noqa: E402
from rush_server import RushServer, rush_server, unavailable, worker_credential  # noqa: E402
from support import REFERENCE, Cli, Worker  # noqa: E402

from nanoagent.plugin.package import pack  # noqa: E402

pytestmark = [pytest.mark.gvisor, pytest.mark.uploaded_acceptance]

PROBE = NANOAGENT / "test" / "plugins" / "acceptance-probe"
SUITE = "core-engine-probe"
SOCKET = "/run/rush-gvisor/seccheck.sock"


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable() or support.container_unavailable()
    if reason:
        pytest.skip(reason)
    with rush_server() as server:
        server.seed_plugin(pack(PROBE))
        yield server


@pytest.fixture(scope="module")
def run_dir() -> Path:
    path = support.SCRATCH / f"core-{uuid.uuid4().hex[:8]}"
    path.mkdir(parents=True)
    return path


@pytest.fixture(scope="module")
def cli(rush: RushServer, run_dir: Path) -> Cli:
    return Cli(rush.base_url, rush.workspace_id, rush.token, support.FINAL / "core-engine" / run_dir.name, rush.user_id)


@pytest.fixture(scope="module")
def source(run_dir: Path) -> tuple[Path, str]:
    """The uploaded project and the NanoAgent revision it vendors."""
    folder = run_dir / "source"
    return folder, support.build_source(folder)


@pytest.fixture(scope="module")
def registry(run_dir: Path) -> Iterator[int]:
    """The mocked dependency registry: a simple index of exactly the wheels the fixture's requirements.txt pins."""
    with support.serve_directory(support.wheelhouse(support.FIXTURE / "requirements.txt", run_dir / "registry")) as port:
        yield port


def publish_probe_suite(cli: Cli, run_dir: Path, suite: str) -> None:
    """Step 1: the probe plugin's first case only, so the one scripted upstream run is the whole benchmark."""
    cases = json.loads((NANOAGENT / "test" / "acceptance" / "benchmark" / "cases" / "probe_cases.json").read_text())
    cases |= {"answer": cases["answer"][:1], "refuse": []}
    (run_dir / "cases.json").write_text(json.dumps(cases))
    cli.step("1", "publish_benchmark", run_dir / f"step1-{suite}", *support.publish_args(name=suite, cases=run_dir / "cases.json"))


def submit(cli: Cli, run_dir: Path, folder: Path, suite: str, *, follow: bool) -> Any:
    """Step 2: submit the source to the benchmark (its one answer case) under the task tools policy; the run's report."""
    home = run_dir / f"step2-{suite}"
    cli.step("2", "submit_run", home, *support.submit_args(suite, plugin="acceptance-probe", key=suite, source=folder, follow=follow, follow_timeout=900))
    return load_layout(home, step2_submit_run.RunLayout).run


def read_trace(cli: Cli, attempt: str, home: Path, *payloads: str) -> Any:
    cli.step("3", "trace", home, f"attempt_id={attempt}", *([f"payloads=[{','.join(payloads)}]"] if payloads else []))
    return load_layout(home, step3_trace.TraceLayout).trace


def fetch_payloads(cli: Cli, attempt: str, digests: list[str], folder: Path) -> dict[str, bytes]:
    """The payloads with these digests through step 3 (a few per process: an override must stay a short argument)."""
    found: dict[str, bytes] = {}
    for number in range(0, len(digests), 3):
        batch = digests[number : number + 3]
        home = folder / f"batch{number // 3}"
        read_trace(cli, attempt, home, *batch)
        found |= {digest: (home / "payloads" / digest).read_bytes() for digest in batch}
    return found


def start_worker(name: str, rush: RushServer, cli: Cli, run_dir: Path, *, upstream: str, index: int, socket: str = SOCKET, **options: Any) -> Worker:
    """The real worker in the worker container, reaching the host's RUSH server, scripted upstream and dependency index as host.docker.internal."""
    config = run_dir / f"{name}.yaml"
    worker = Worker(name, config, cli.logs / f"{name}-worker.log", credential=worker_credential(cli.base_url, cli.token), **options)
    config.write_text(
        support.worker_yaml(
            base_url=f"http://{support.HOST}:{rush.base_url.rsplit(':', 1)[1]}",
            upstream=upstream.replace("127.0.0.1", support.HOST),
            index=f"http://{support.HOST}:{index}/simple",
            socket=socket.replace("<home>", worker.home),
            scratch=f"{worker.home}/scratch",
        )
    )
    worker.start()
    return worker


# -- gate: the NanoAgent core engine ------------------------------------------------------------------------------------


@dataclass
class Evidence:
    revision: str
    handle: RunHandle
    calls_served: int
    run: Any  # step 2's RunReport
    attempt_id: str
    trace: Any  # step 3's Trace while everything was up
    reopened: Any  # step 3's Trace with the upstream and the worker stopped
    payloads: dict[str, bytes]
    ledger_after: int
    worker_log: str
    worker_status: int | None

    @property
    def attempt(self) -> Any:
        return self.run.attempts[0]

    def events(self, kind: str) -> list[dict[str, Any]]:
        return [event for event in self.trace.events if event["kind"] == kind]

    def payload(self, digest: str) -> Any:
        return json.loads(self.payloads[digest])


@pytest.fixture(scope="module")
def core(rush: RushServer, cli: Cli, run_dir: Path, source: tuple[Path, str], registry: int) -> Iterator[Evidence]:
    folder, revision = source
    publish_probe_suite(cli, run_dir, SUITE)
    with MockProvider() as provider:
        scenario = load_scenario(support.SCENARIOS / "core-engine.yaml")
        handle = provider.register(scenario, harness="nanoagent", model=support.MODEL, refs={"reference": REFERENCE})
        worker = start_worker("core", rush, cli, run_dir, upstream=handle.base_url, index=registry)
        try:
            report = submit(cli, run_dir, folder, SUITE, follow=True)
            attempt = report.attempts[0].attempt_id
            trace = read_trace(cli, attempt, run_dir / "trace-live")
            digests = sorted({d for event in trace.events for d in event.get("payload_sha256s", [])})
            payloads = fetch_payloads(cli, attempt, digests, run_dir / "payloads-live")
            calls_served = len(handle.ledger.calls)
        finally:
            status = worker.stop()
    # The upstream (closed on leaving the `with`) and the worker are gone: reopen the sealed trace in fresh processes.
    reopened = read_trace(cli, attempt, run_dir / "trace-reopened")
    assert fetch_payloads(cli, attempt, digests, run_dir / "payloads-reopened") == payloads
    yield Evidence(revision, handle, calls_served, report, attempt, trace, reopened, payloads, len(handle.ledger.calls), worker.text(), status)


def user_prompts(messages: list[dict[str, Any]]) -> list[str]:
    return [message["content"] for message in messages if message["role"] == "user"]


def test_the_harness_is_the_pinned_nanoagent_revision(core: Evidence, source: tuple[Path, str]) -> None:
    folder, revision = source
    assert core.revision == support.pinned_revision() == revision
    assert (folder / "NANOAGENT_REVISION").read_text().strip() == revision
    for name in support.git("ls-tree", "-r", "--name-only", revision, "--", "src/nanoagent/core").decode().split():
        vendored = (folder / "nanoagent" / Path(name).relative_to("src/nanoagent")).read_bytes()
        blob = hashlib.sha1(b"blob %d\0" % len(vendored) + vendored).hexdigest()
        assert blob == support.git("rev-parse", f"{revision}:./{name}").decode().strip(), f"{name} differs from the pinned revision"
    [admitted, *_] = core.events("model_call.admitted")
    # The first request was made by httpx 0.28.1, which only the hashed, offline-staged dependency closure provides.
    assert admitted["data"]["request_headers"]["user-agent"] == "python-httpx/0.28.1"
    assert core.attempt.execution_status == "answered"


def test_the_first_user_prompt_is_the_pinned_rendered_prompt(core: Evidence) -> None:
    # task_tools, agent task: the pinned prompt is a system and a user text, and the first request carries both byte for byte.
    pinned = core.trace.attempt["prompt"]
    assert isinstance(pinned["user"], str) and isinstance(pinned["system"], str)
    first = core.handle.ledger.calls[0].request
    assert first is not None and user_prompts(first.messages) == [pinned["user"]]
    assert [m["content"] for m in first.messages if m["role"] == "system"] == [pinned["system"]]
    # Stored evidence agrees: the submitted request of the first physical call carries the same prompt.
    [admitted, *_] = core.events("model_call.admitted")
    assert user_prompts(core.payload(admitted["data"]["submitted_request_sha256"])["messages"]) == [pinned["user"]]


def test_a_streamed_proposal_is_executed_by_the_hosted_tool_broker(core: Evidence) -> None:
    [first, *_] = core.events("model_call.response")
    [proposal] = first["data"]["proposals"]
    assert (proposal["name"], proposal["call_id"], proposal["arguments"]) == ("wait", "call_0", {"wait_seconds": 1})
    assert core.events("model_call.admitted")[0]["data"]["stream"] is True and first["data"]["frame_count"] > 1
    [invoked] = core.events("tool.invoked")
    [completed] = core.events("tool.completed")
    assert invoked["data"]["cause"] == {"model_call_id": first["data"]["call_id"], "tool_call_id": "call_0"}
    assert invoked["data"]["tool"] == "wait" and invoked["data"]["adapted"] is False and invoked["source"] == "tool_broker"
    assert completed["data"]["ok"] is True and core.payload(completed["data"]["output_sha256"]) == {"waited": 1.0}
    [link] = [link for link in core.trace.links if link["kind"] == "proposal_invocation"]
    assert (link["from"], link["to"], link["method"]) == (f"m:{first['data']['call_id']}/call_0", f"t:{invoked['data']['call_id']}", "broker_cause")
    assert [span["kind"] for span in core.trace.spans if span["id"] == link["to"]] == ["tool"]


def test_the_follow_up_model_turn_carries_the_tool_result(core: Evidence) -> None:
    [_, second, _] = core.events("model_call.response")
    [completed] = core.events("tool.completed")
    [link] = [link for link in core.trace.links if link["kind"] == "result_delivery"]
    assert (link["from"], link["to"], link["method"]) == (f"t:{completed['data']['call_id']}", f"m:{second['data']['call_id']}", "tool_result_call_id")
    assert link["attributes"]["tool_call_id"] == "call_0" and link["attributes"]["content_match"] == "exact"
    first, upstream = (call.request for call in core.handle.ledger.main_calls[:2])
    assert first is not None and upstream is not None
    [tool_message] = [message for message in upstream.messages if message["role"] == "tool"]
    assert tool_message["tool_call_id"] == "call_0" and json.loads(tool_message["content"]) == {"waited": 1.0}
    assert user_prompts(upstream.messages) == user_prompts(first.messages)


def test_the_answer_is_submitted_atomically_and_scored_by_the_pinned_verifier(core: Evidence) -> None:
    [outcome] = core.events("result.read")
    assert outcome["data"]["outcome"] == {"status": "answered", "answer": {"digest": REFERENCE}}
    assert core.events("case.exited")[0]["data"]["termination"] == {"status": "exited", "exit_code": 0}
    assert (core.attempt.execution_status, core.attempt.verdict, core.attempt.sealed) == ("answered", "pass", True)
    assert (core.run.benchmark["name"], core.run.score["value"], core.run.score["unavailable_reason"]) == (SUITE, 1, None)
    assert core.run.status == "complete" and core.run.model == support.MODEL and core.run.endpoint_profile == "mock"
    assert not core.events("verifier.completed") and core.attempt.verdict == "pass"
    assert not core.handle.ledger.violations


def test_recorded_token_counts_reconcile_with_the_upstream_ledger(core: Evidence) -> None:
    served = core.handle.ledger.main_calls
    assert len(served) == len(core.handle.ledger.calls) == 3
    recorded = [event["data"]["usage"] for event in core.events("model_call.response")]
    for usage, call in zip(recorded, served, strict=True):
        assert call.usage is not None
        assert (usage["input"], usage["cache_read"], usage["cache_write"], usage["output"], usage["reasoning"]) == (
            call.usage.input,
            call.usage.cached,
            call.usage.cache_write,
            call.usage.output,
            call.usage.reasoning,
        )
        assert usage["total"] == call.usage.input + call.usage.output and usage["discrepancies"] == []
    ledger = core.handle.ledger.usage()
    metrics = core.run.metrics
    assert (ledger.input, ledger.output, ledger.cached, ledger.cache_write) == (3700, 90, 1000, 300)
    assert {key: metrics[key]["total"] for key in metrics if key != "elapsed_ms"} == {
        "total_tokens": ledger.input + ledger.output,
        "input_tokens": ledger.input,
        "output_tokens": ledger.output,
        "cache_read_tokens": ledger.cached,
        "cache_write_tokens": ledger.cache_write,
    }
    assert all(metrics[key]["missing_attempts"] == 0 for key in metrics)
    assert core.attempt.metrics["usage_complete"] is True and core.attempt.metrics["model_calls"] == 3
    assert all(count == 0 for count in core.attempt.metrics["missing_calls"].values())
    accounting = core.trace.accounting
    assert accounting is not None and accounting["totals"]["calls"] == 3 == len(core.handle.ledger.calls)


def test_process_evidence_is_complete(core: Evidence) -> None:
    coverage = core.attempt.coverage
    assert coverage["status"] == "complete" and coverage["loss_reasons"] == [] and coverage["collector_complete"] is True
    assert {"worker", "gateway", "process", "tool_broker"} <= set(coverage["expected_sources"]) <= set(coverage["observed_sources"])
    [health] = core.events("collector.health")
    assert health["data"]["complete"] is True and health["data"]["loss_reasons"] == [] and health["data"]["reported_drops"] == 0
    assert health["data"]["frames"] > 0
    [exec_event] = core.events("process.exec")
    assert (exec_event["data"]["argv"], exec_event["data"]["cwd"]) == (["python", "/harness/main.py"], "/rush/workspace")
    [exit_event] = core.events("process.exit")
    assert exit_event["data"]["exit_code"] == 0 and exit_event["data"]["start_time"] == exec_event["data"]["start_time"]
    assert core.events("case.launched")[0]["data"]["argv"] == ["python", "/harness/main.py"]
    assert not core.events("build.completed") and not core.events("build.started")


def test_the_sealed_trace_reopens_with_the_upstream_and_the_worker_stopped(core: Evidence) -> None:
    assert core.worker_status is not None
    live, reopened = core.trace, core.reopened
    assert live.sealed and reopened.sealed
    assert (reopened.final_cursor, reopened.high_water_cursor) == (live.final_cursor, live.high_water_cursor) == (len(live.events), len(live.events))
    assert reopened.events == live.events  # prompts, payload digests, usage and the verdict ride in the same sealed events
    assert reopened.attempt == live.attempt and reopened.spans == live.spans and reopened.links == live.links
    assert (reopened.attempt["verdict"], reopened.attempt["prompt"]["sha256"]) == ("pass", live.attempt["prompt"]["sha256"])
    assert reopened.accounting == live.accounting
    # Zero new upstream requests: the ledger is unchanged since the run, and the mock was not even listening.
    assert core.ledger_after == core.calls_served == 3


# -- gate: collector startup and loss -----------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def probe_run(rush: RushServer, cli: Cli, run_dir: Path, source: tuple[Path, str]) -> Any:
    """A queued run no worker has claimed yet, for the startup refusals."""
    publish_probe_suite(cli, run_dir, "collector-startup")
    return submit(cli, run_dir, source[0], "collector-startup", follow=False)


@pytest.mark.parametrize(
    ("name", "socket", "message"),
    [
        ("socket-unusable", "/nonexistent-collector-dir/seccheck.sock", "socket_unavailable"),
        ("collector-unwired", "<home>/unwired.sock", "collector_self_test_failed"),
    ],
)
def test_the_worker_refuses_to_start_or_claim_when_the_collector_is_unavailable(
    name: str, socket: str, message: str, rush: RushServer, cli: Cli, run_dir: Path, registry: int, probe_run: Any
) -> None:
    attempt = probe_run.attempts[0].attempt_id
    with MockProvider() as provider:
        scenario = load_scenario(support.SCENARIOS / "core-engine.yaml")
        handle = provider.register(scenario, harness="nanoagent", model=support.MODEL, refs={"reference": REFERENCE})
        worker = start_worker(name, rush, cli, run_dir, upstream=handle.base_url, index=registry, socket=socket)
        try:
            status = worker.exit_code(timeout=300)
        finally:
            worker.stop()
        assert not handle.ledger.calls
    assert status != 0, worker.text()
    assert message in worker.text() and "Traceback" in worker.text(), worker.text()
    # It never polled for work: the run's attempt is exactly as submitted.
    trace = read_trace(cli, attempt, run_dir / f"trace-{name}")
    assert trace.attempt["state"] == "queued" and trace.attempt["claimed_at"] is None and trace.events == [] and not trace.sealed


@dataclass
class Loss:
    attempt: str
    midway: Any
    final: Any
    worker_log: str


@pytest.fixture(scope="module")
def loss(rush: RushServer, cli: Cli, run_dir: Path, source: tuple[Path, str], registry: int, probe_run: Any) -> Iterator[Loss]:
    """A case whose collector is stopped while its tool is in flight (a long `wait`): the worker still finishes the attempt."""
    # The startup tests left their attempt queued (that is what they prove); cancel it so this worker claims only its own.
    cli.step("2", "submit_run", run_dir / "cancel-startup-run", "action=cancel", "policy=task_tools", f"run_id={probe_run.run_id}", "follow=false")
    publish_probe_suite(cli, run_dir, "collector-loss")
    with MockProvider() as provider:
        scenario = load_scenario(support.SCENARIOS / "core-engine-long-wait.yaml")
        handle = provider.register(scenario, harness="nanoagent", model=support.MODEL, refs={"reference": REFERENCE})
        trigger = f"/tmp/rush-lose-collector-{uuid.uuid4().hex[:8]}"  # noqa: S108 - a path in the worker container, outside the repository
        worker = start_worker(
            "collector-loss",
            rush,
            cli,
            run_dir,
            upstream=handle.base_url,
            index=registry,
            entry=(str(Path(support.__file__).with_name("loss_worker.py")),),
            env={"RUSH_LOSE_COLLECTOR_FILE": trigger},
        )
        try:
            attempt = submit(cli, run_dir, source[0], "collector-loss", follow=False).attempts[0].attempt_id
            deadline = time.monotonic() + 600
            while True:
                midway = read_trace(cli, attempt, run_dir / "trace-loss-midway")
                if any(event["kind"] == "tool.invoked" for event in midway.events):
                    break
                assert not midway.sealed, f"the attempt ended before its tool ran: {handle.ledger.violations}\n{worker.text()[-3000:]}"
                assert time.monotonic() < deadline, worker.text()
                time.sleep(0.5)
            assert not any(event["kind"] == "tool.completed" for event in midway.events), "the tool must still be running when the collector is lost"
            assert support.inside("touch", trigger).returncode == 0
            while True:
                final = read_trace(cli, attempt, run_dir / "trace-loss-final")
                if final.sealed:
                    break
                assert time.monotonic() < deadline, worker.text()
                time.sleep(1)
        finally:
            worker.stop()
            support.inside("rm", "-f", trigger)
        yield Loss(attempt, midway, final, worker.text())


def test_a_forced_collector_loss_marks_the_trace_partial_and_keeps_existing_evidence(loss: Loss, cli: Cli, run_dir: Path) -> None:
    final = loss.final
    coverage = final.attempt["coverage"]
    assert coverage["status"] == "partial" and "collector_stopped" in coverage["loss_reasons"], coverage
    assert coverage["collector_complete"] is False
    [health] = [event for event in final.events if event["kind"] == "collector.health"]
    assert health["data"]["complete"] is False and "collector_stopped" in health["data"]["loss_reasons"]
    # Everything captured before the loss is still stored, unchanged and in order.
    assert loss.midway.events and all(final.events[event["cursor"] - 1] == event for event in loss.midway.events)
    assert {"case.launched", "model_call.response", "tool.invoked"} <= {event["kind"] for event in loss.midway.events}
    # The case itself ran to the end and the verifier scored it: only the process evidence is incomplete.
    assert final.attempt["execution"]["status"] == "answered" and final.attempt["verdict"] == "pass" and final.sealed
    reopened = read_trace(cli, loss.attempt, run_dir / "trace-loss-reopened")
    assert reopened.events == final.events and reopened.attempt["coverage"] == coverage
