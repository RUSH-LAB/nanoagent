"""The attempt runner with every dependency faked: each phase failing, and lease loss with a model stream in flight."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import anyio
import httpx
import pytest
import runner_fakes as fx
import service_fakes as sf
from nanoagent.plugin.verifier import CaseVerdict, VerifierError
from nanoagent.uploaded.app import AttemptServices
from nanoagent.uploaded.execservice import ExecError
from nanoagent.uploaded.collector import ProcessEvent, ProcessEventKind, ProcessEvidence
from nanoagent.uploaded.rush_worker import LeaseLost, RushError, RushUnavailable
from nanoagent.uploaded.runner import EXEC_THREADS, AttemptRunner, CaseCommands, RunnerConfig, default_project
from nanoagent.uploaded.sandbox import SandboxError, Termination, TerminationKind
from nanoagent.uploaded.toolchains import DependencyClosure
from nanoagent.uploaded.worker import runner_config  # noqa: F401  (imported so the worker module stays importable)


class Rig:
    def __init__(self, tmp_path: Path, *, rush: fx.FakeRush | None = None, script: fx.CaseScript | None = None, build_error: Exception | None = None, case_error: Exception | None = None, transport: Any = None, verify: Any = None, clock_ns: Any = None) -> None:
        self.rush = rush or fx.FakeRush()
        self.supervisor = fx.FakeSupervisor(tmp_path, script, build_error, case_error)
        self.relay = fx.FakeRelay()
        self.services: list[AttemptServices] = []
        self.verified: list[dict[str, Any]] = []
        self.references: list[Any] = []
        self.transport = transport
        self.verify_result: Any = verify or CaseVerdict("pass", 1.0, None)

        def services_factory(**kwargs: Any) -> AttemptServices:
            services = AttemptServices(transport=transport, **kwargs)
            self.services.append(services)
            return services

        def verify_case(manifest: Any, task: str, arguments: dict, outcome: dict, reference: Any, workspace: Path) -> CaseVerdict:
            self.verified.append(outcome)
            self.references.append(reference)
            if isinstance(self.verify_result, Exception):
                raise self.verify_result
            return self.verify_result

        config = RunnerConfig(
            "w-1", sf.make_endpoint(), {"test/model": (sf.Decimal("0.000001"), sf.Decimal("0.000004"))}, tmp_path / "scratch",
            capabilities=fx.CAPABILITIES, renew_interval_s=0.05, drain_timeout_s=3,
        )
        (tmp_path / "scratch").mkdir()
        self.runner = AttemptRunner(
            config, supervisor=self.supervisor, worker=self.rush, relay=self.relay, plugins=fx.FakePlugins(),  # type: ignore[arg-type]
            services_factory=services_factory, verify_task_case=verify_case, project=fx.fake_project, **({} if clock_ns is None else {"clock_ns": clock_ns}),
        )

    async def run(self, job: Any = None):
        return await self.runner.run(job or fx.job())


async def test_answered_attempt_runs_the_whole_lifecycle_and_finalizes_once(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    result = await rig.run()
    assert result.outcome == "finalized" and result.execution == {"status": "answered", "reason": None}
    [final] = rig.rush.finalized
    assert final["execution"] == {"status": "answered", "reason": None}
    assert final["verdict"] == "pass" and final["verifier_error"] is None and final["explanation"] is None and "score" not in final
    assert final["coverage"] == {"status": "complete"}
    kinds = rig.rush.kinds()
    expected = ["attempt.started", "case.launched", "case.exited", "case.quiesced", "snapshot.taken", "collector.health", "result.read"]
    assert [kind for kind in kinds if kind in expected] == expected
    assert rig.verified == [{"status": "answered", "answer": {"sum": 3}}]
    assert rig.rush.span_bodies and rig.supervisor.networks[0].removed and rig.relay.handle.closed and rig.supervisor.case.closed
    assert rig.rush.of("attempt.started")[0]["expected_sources"] == ["worker", "gateway", "process"]
    assert not rig.rush.events_after_loss and rig.rush.sealed


async def test_request_points_the_guest_at_the_relay(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run()
    import json

    request = json.loads(rig.supervisor.specs[0].request_json)
    assert request["openrouter"]["base_url"] == "http://10.1.2.3:8080/api/v1"
    assert request["exec_url"] == "http://10.1.2.3:8080/exec" and request["tools"]["url"].endswith("/tools")
    assert request["limits"] == fx.LIMITS and request["policy"] == "task_tools" and request["workspace"] == "/rush/workspace"
    assert request["prompt"] == {"system": None, "user": fx.PROMPT, "sha256": "c" * 64}
    assert request["task"] == {"id": "probe", "kind": "agent", "description": "Sum the numbers.", "instructions": "Be exact.", "plugin_name": "Acceptance probe"}
    assert request["case"]["case_id"] == "c1" and request["case"]["context"] == "numbers" and "kind" not in request["case"]
    assert rig.supervisor.specs[0].attempt_token == rig.services[0].attempt.policy.token


async def test_source_rejection_finalizes_a_source_failure_without_executing(tmp_path: Path) -> None:
    rig = Rig(tmp_path, rush=fx.FakeRush(fx.source_zip(manifest=False)))
    result = await rig.run()
    assert result.execution == {"status": "build_failed", "reason": "missing_manifest"}
    assert rig.supervisor.builds == 0 and rig.supervisor.case is None and rig.rush.finalized[0]["verdict"] is None
    assert "toolchain" not in rig.rush.of("attempt.started")[0]


async def test_unknown_toolchain_is_rejected_before_execution(tmp_path: Path) -> None:
    rig = Rig(tmp_path, rush=fx.FakeRush(fx.source_zip("cobol-1")))
    result = await rig.run()
    assert result.execution == {"status": "build_failed", "reason": "unknown_toolchain"}
    assert rig.supervisor.builds == 0 and "build.completed" not in rig.rush.kinds()


async def test_build_failure_is_a_build_failed_attempt(tmp_path: Path) -> None:
    rig = Rig(tmp_path, build_error=SandboxError("build_failed", "build exited 2"))
    result = await rig.run()
    assert result.execution == {"status": "build_failed", "reason": "build_failed"}
    assert rig.supervisor.case is None and not [kind for kind in rig.rush.kinds() if kind.startswith("build.")]


async def test_timeout_is_an_execution_failure_scored_by_the_verifier(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(termination=Termination(TerminationKind.TIMED_OUT, None, 9), result=SandboxError("missing_result", "none")))
    result = await rig.run()
    assert result.execution == {"status": "execution_failed", "reason": "timed_out"}
    assert rig.verified == [{"status": "execution_failed", "reason": "timed_out"}]
    assert rig.rush.finalized[0]["verdict"] == "pass"  # the verifier scored it (a fake that always passes)
    assert rig.rush.of("case.exited")[0]["termination"] == {"status": "timed_out"}


@pytest.mark.parametrize(
    ("result", "reason"),
    [(SandboxError("missing_result", "no result.json"), "missing_result"), (b'{"protocol":"rush.harness.v1","status":"answered","answer":{"sum":"x"}}', "invalid_result"), (b"nope", "invalid_result")],
)
async def test_missing_and_invalid_results_are_execution_failures(tmp_path: Path, result: Any, reason: str) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(result=result))
    out = await rig.run()
    assert out.execution == {"status": "execution_failed", "reason": reason}
    assert rig.verified == [{"status": "execution_failed", "reason": reason}]


async def test_nonzero_exit_with_incomplete_process_evidence_leaves_the_score_unavailable(tmp_path: Path) -> None:
    script = fx.CaseScript(termination=Termination(TerminationKind.NONZERO_EXIT, 3, None), evidence=fx.evidence(False, ("root_exit_missing",)))
    rig = Rig(tmp_path, script=script)
    result = await rig.run()
    assert result.execution == {"status": "execution_failed", "reason": "nonzero_exit"}
    assert rig.verified == [] and rig.rush.finalized[0]["verdict"] is None and rig.rush.finalized[0]["verifier_error"] is None
    assert rig.rush.of("collector.health")[0]["complete"] is False


async def test_verifier_error_keeps_the_trace_and_leaves_the_score_unavailable(tmp_path: Path) -> None:
    rig = Rig(tmp_path, verify=VerifierError("boom: private detail"))
    result = await rig.run()
    assert result.execution == {"status": "answered", "reason": None}
    assert rig.rush.finalized[0]["verdict"] is None and rig.rush.finalized[0]["verifier_error"] == "verifier_error"
    assert not [kind for kind in rig.rush.kinds() if kind.startswith("verifier.")]
    assert "private detail" not in str(rig.rush.events)


async def test_cancel_stops_the_case_and_finalizes_canceled_without_a_score(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(block=True))
    rig.rush.canceled = True
    result = await rig.run()
    assert result.outcome == "canceled"
    assert rig.rush.finalized[0]["execution"] == {"status": "canceled", "reason": None} and rig.rush.finalized[0]["verdict"] is None
    assert rig.supervisor.case.closed and rig.verified == []


async def test_cancel_woken_wait_that_fails_as_closed_is_still_a_cancel(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(block=True, closed_wait=True))
    rig.rush.canceled = True
    result = await rig.run()
    assert result.outcome == "canceled" and rig.supervisor.case.closed


async def test_a_workspace_over_its_bound_is_a_scored_failure_not_a_platform_fault(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(drain_error=SandboxError("snapshot_too_large", "more than 20000 files")))
    result = await rig.run()
    assert result.execution == {"status": "execution_failed", "reason": "invalid_result"}
    assert rig.verified == [{"status": "execution_failed", "reason": "invalid_result"}]
    assert rig.rush.finalized[0]["verdict"] == "pass"  # went through verification (a fake that always passes) and finalize


async def test_an_output_folder_over_its_bound_is_a_scored_failure(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(result=SandboxError("snapshot_too_large", "more than 20000 files")))
    result = await rig.run()
    assert result.execution == {"status": "execution_failed", "reason": "invalid_result"}
    assert rig.verified == [{"status": "execution_failed", "reason": "invalid_result"}]


async def test_other_drain_errors_stay_platform_faults(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(drain_error=SandboxError("freeze_failed", "freeze the sandbox")))
    assert (await rig.run()).outcome == "platform_fault"


async def test_cancel_during_the_build_stops_the_attempt_before_any_case_runs_and_finalizes_canceled(tmp_path: Path) -> None:
    rig = Rig(tmp_path, case_error=RuntimeError("a case must not be created for a canceled attempt"))
    build = rig.supervisor.build

    def canceled_while_building(spec: Any) -> Any:
        rig.rush.canceled = True
        time.sleep(0.3)  # six renewal intervals: the renewal answers 409 canceled while the build runs
        return build(spec)

    rig.supervisor.build = canceled_while_building  # type: ignore[method-assign]
    result = await rig.run()
    assert result.outcome == "canceled"
    assert rig.rush.finalized[0]["execution"] == {"status": "canceled", "reason": None} and rig.rush.finalized[0]["verdict"] is None
    assert rig.supervisor.specs == [] and rig.verified == []


async def test_lease_loss_during_the_build_finalizes_nothing_and_runs_no_case(tmp_path: Path) -> None:
    rig = Rig(tmp_path, case_error=RuntimeError("a case must not be created for an attempt that lost its lease"))
    build = rig.supervisor.build

    def lease_lost_while_building(spec: Any) -> Any:
        rig.rush.renew_error = LeaseLost(409, "lease_lost", "expired")
        time.sleep(0.3)
        return build(spec)

    rig.supervisor.build = lease_lost_while_building  # type: ignore[method-assign]
    result = await rig.run()
    assert result.outcome == "lease_lost" and rig.rush.finalized == [] and rig.supervisor.specs == []


async def test_lease_loss_with_a_model_stream_in_flight_revokes_and_keeps_the_call_reserved(tmp_path: Path) -> None:
    hold = anyio.Event()
    rig = Rig(tmp_path, script=fx.CaseScript(block=True), transport=sf.ScriptedTransport(sf.stream_script(hold=hold)))
    responses: list[httpx.Response] = []

    async def model_call() -> None:
        while not rig.services:
            await anyio.sleep(0.01)
        services = rig.services[0]
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=services.app), base_url="http://svc.test", headers={"authorization": f"Bearer {services.attempt.policy.token}"}
        ) as client:
            responses.append(await client.post(sf.PATHS["chat_completions"], json=sf.chat_request(fx.PROMPT, stream=True)))

    async def lose_lease() -> None:
        while not rig.rush.admissions or not rig.transport.responses:
            await anyio.sleep(0.01)
        await anyio.sleep(0.05)
        rig.rush.lost = True

    async with anyio.create_task_group() as group:
        group.start_soon(model_call)
        group.start_soon(lose_lease)
        result = await rig.run()
    assert result.outcome == "lease_lost" and not rig.rush.finalized and not rig.rush.sealed
    [call_id] = rig.rush.admissions
    assert [(c, outcome) for c, outcome, _, _ in rig.rush.settles] == [(call_id, "uncertain")], "the in-flight call stays reserved, never reissued"
    assert rig.services[0].attempt.revoked and rig.supervisor.case.closed and rig.transport.responses[0].closed
    assert len(rig.transport.requests) == 1
    assert responses and responses[0].status_code in (200, 403)
    assert rig.supervisor.networks[0].removed and rig.relay.handle.closed


async def test_no_events_are_committed_after_the_seal(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run()
    committed = len(rig.rush.events)
    from nanoagent.uploaded.rush_worker import Lease, RushJournal

    journal = RushJournal(rig.rush, Lease(fx.ATTEMPT_ID, 1))
    await journal.append_record({"event_id": "late-1", "source": "worker", "kind": "late", "sequence": 99, "occurred_ns": 1, "data": {}, "payload_sha256s": []})
    assert len(rig.rush.events) == committed and journal.closed and journal.dropped == 1


async def test_a_lost_lease_before_the_first_fetch_fails_the_attempt_quietly(tmp_path: Path) -> None:
    rush = fx.FakeRush()

    async def lost(*_: Any) -> bytes:
        raise LeaseLost(409, "lease_lost", "gone")

    rush.source = lost  # type: ignore[method-assign]
    rig = Rig(tmp_path, rush=rush)
    assert (await rig.run()).outcome == "lease_lost" and not rush.events


async def test_cpu_counters_are_emitted_after_the_drain_when_the_sandbox_read_them(tmp_path: Path) -> None:
    counters = [{"identity": {"role": "harness", "container": "c1"}, "user_ns": 5, "system_ns": 2}]
    rig = Rig(tmp_path, script=fx.CaseScript(cpu=counters))
    await rig.run()
    assert rig.rush.of("cpu.counters") == [{"processes": counters}]
    assert rig.rush.kinds().index("cpu.counters") > rig.rush.kinds().index("snapshot.taken")


async def test_no_cpu_counters_are_emitted_when_none_were_read(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run()
    assert rig.rush.of("cpu.counters") == []


async def test_a_tool_suite_prepares_the_plugin_and_runs_it_in_a_tool_container_before_the_harness_starts(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run(fx.parse_job(fx.job_body(tools=[fx.WAIT_TOOL])))
    [spec] = rig.supervisor.specs
    assert spec.tool is not None and spec.tool.name.startswith("rush-tool-22222222-") and spec.tool.fixtures is None
    assert rig.supervisor.prepared == [spec.tool.plugin_root]
    assert rig.supervisor.case.launched


async def test_a_tool_container_launch_failure_ends_only_that_attempt_and_leaves_nothing_behind(tmp_path: Path) -> None:
    rig = Rig(tmp_path, case_error=SandboxError("start_failed", "create tool container: injected"))
    result = await rig.run(fx.parse_job(fx.job_body(tools=[fx.WAIT_TOOL])))
    assert result.outcome == "platform_fault" and "start_failed" in result.execution["error"]
    assert not rig.rush.finalized and not rig.rush.sealed, "the server interrupts it when the lease expires; the worker finalizes nothing"
    assert rig.supervisor.networks[0].removed and rig.relay.handle.closed
    assert not (tmp_path / "scratch" / fx.ATTEMPT_ID).exists()
    assert "attempt.started" in rig.rush.kinds() and "case.launched" not in rig.rush.kinds()
    renews = rig.rush.renew_attempts
    await anyio.sleep(0.3)  # six renewal intervals
    assert rig.rush.renew_attempts == renews, "a faulted attempt stops renewing its lease"


async def test_a_fault_after_launch_stops_the_case_and_commits_the_process_evidence(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(result=RuntimeError("the result volume vanished")))
    result = await rig.run()
    assert result.outcome == "platform_fault" and "the result volume vanished" in result.execution["error"]
    assert not rig.rush.finalized and rig.supervisor.case.closed and rig.supervisor.networks[0].removed
    assert rig.rush.of("collector.health"), "the evidence the collector had is kept on the interrupted attempt"
    assert rig.services[0].attempt.revoked


@pytest.mark.parametrize("tools", [[], [fx.WAIT_TOOL]], ids=["coding", "task_tools"])
async def test_a_worker_shutdown_mid_case_still_closes_the_case_and_removes_its_network_and_relay(tmp_path: Path, tools: list) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(block=True))
    with anyio.fail_after(10):
        async with anyio.create_task_group() as group:
            group.start_soon(rig.run, fx.parse_job(fx.job_body(tools=tools)))
            while "case.launched" not in rig.rush.kinds():
                await anyio.sleep(0.01)
            group.cancel_scope.cancel()  # what Ctrl-C, or another attempt's fault, does to every attempt in flight
    assert rig.supervisor.case.closed and rig.supervisor.networks[0].removed and rig.relay.handle.closed


async def test_the_worker_goes_on_to_its_next_job_after_a_platform_fault(tmp_path: Path) -> None:
    from nanoagent.uploaded import worker

    first = fx.job_body(attempt_id="11111111-1111-4111-8111-111111111111", tools=[fx.WAIT_TOOL])
    rig = Rig(tmp_path, case_error=SandboxError("start_failed", "create tool container: injected"))
    rig.rush.jobs = [fx.parse_job(first), fx.job()]
    config = worker.PollConfig(idle_s=0.01, max_idle_s=0.01)
    stub = type("Config", (), {"poll": config})()

    async def run_jobs() -> None:
        async with anyio.create_task_group() as background:
            await worker.poll(stub, rig.runner.config, rig.rush, rig.runner, None, background)  # type: ignore[arg-type]

    with pytest.raises(BaseExceptionGroup) as stopped:
        await run_jobs()
    assert stopped.group_contains(fx.StopPolling)
    assert len(rig.supervisor.specs) == 2, "the second job reached the sandbox after the first one faulted"


async def test_a_lease_that_cannot_be_renewed_lapses_locally_and_the_services_refuse_new_work(tmp_path: Path) -> None:
    now = [0]
    rig = Rig(tmp_path, script=fx.CaseScript(block=True), clock_ns=lambda: now[0])
    rig.rush.renew_error = RushUnavailable("the server is unreachable")

    async def lapse() -> None:
        while rig.supervisor.case is None or not rig.supervisor.case.launched:
            await anyio.sleep(0.01)
        now[0] += 61 * 1_000_000_000  # past the 60 s lease, with every renewal failing

    async with anyio.create_task_group() as group:
        group.start_soon(lapse)
        result = await rig.run()
    assert result.outcome == "lease_lost" and not rig.rush.finalized
    assert rig.supervisor.case.closed
    assert rig.services[0].attempt.revoked


async def test_a_renewal_interval_that_cannot_keep_the_lease_alive_is_a_platform_fault(tmp_path: Path) -> None:
    body = fx.job_body(lease_seconds=0.01)
    rig = Rig(tmp_path)
    result = await rig.run(fx.parse_job(body))
    assert result.outcome == "platform_fault" and "renew_interval_s" in result.execution["error"]
    assert rig.supervisor.builds == 0


# -- policies, limits and the network (rush.harness.v1) --------------------------------------------------------------------


def answer_file(content: bytes | str) -> dict[str, bytes]:
    return {"answer.json": content.encode() if isinstance(content, str) else content}


async def test_the_tool_policy_gives_the_task_tools_and_reads_rush_result(tmp_path: Path) -> None:
    import json

    rig = Rig(tmp_path, script=fx.CaseScript(workspace=answer_file('{"sum": 99}')))
    await rig.run(fx.parse_job(fx.job_body(tools=[fx.WAIT_TOOL])))
    request = json.loads(rig.supervisor.specs[0].request_json)
    assert [tool["name"] for tool in request["tools"]["available"]] == ["wait"] and "writes" not in request["tools"]["available"][0]
    assert rig.supervisor.specs[0].tool is not None
    assert rig.verified == [{"status": "answered", "answer": {"sum": 3}}], "answer.json is not read under the task tools policy"
    assert rig.rush.of("attempt.started")[0]["expected_sources"] == ["worker", "gateway", "process", "tool_broker"]


async def test_the_coding_policy_has_no_tools_and_reads_answer_json_from_the_frozen_workspace(tmp_path: Path) -> None:
    import json

    body = fx.job_body("coding", tools=[fx.WAIT_TOOL])  # even a claim that lists tools gets none
    rig = Rig(tmp_path, script=fx.CaseScript(result=SandboxError("missing_result", "RUSH_RESULT is ignored"), workspace=answer_file('{"sum": 7}')))
    result = await rig.run(fx.parse_job(body))
    assert result.execution == {"status": "answered", "reason": None}
    request = json.loads(rig.supervisor.specs[0].request_json)
    assert request["policy"] == "coding" and request["tools"]["available"] == []
    assert rig.supervisor.specs[0].tool is None and rig.supervisor.prepared == []
    assert rig.verified == [{"status": "answered", "answer": {"sum": 7}}]
    # Not applicable under coding: null (omitted from the record), as the run's effective config says, never an empty list.
    assert "egress_hosts" not in rig.rush.of("attempt.started")[0]  # records omit null fields
    assert rig.rush.of("attempt.started")[0]["expected_sources"] == ["worker", "gateway", "process"]


@pytest.mark.parametrize(
    ("workspace", "status", "reason"),
    [
        ({}, "execution_failed", "missing_result"),
        (answer_file("not json"), "execution_failed", "invalid_result"),
        (answer_file("[1]"), "execution_failed", "invalid_result"),
        (answer_file('{"refused": "  "}'), "execution_failed", "invalid_result"),
        (answer_file('{"refused": "no data"}'), "refused", "no data"),
        (answer_file('{"sum": "not an integer"}'), "answered", None),
    ],
)
async def test_coding_policy_outcomes_follow_read_answer(tmp_path: Path, workspace: dict[str, bytes], status: str, reason: str | None) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(workspace=workspace))
    result = await rig.run(fx.parse_job(fx.job_body("coding")))
    assert result.execution["status"] == status
    [outcome] = rig.verified
    assert outcome["status"] == status and outcome.get("reason") == reason
    assert (result.execution["reason"] if status == "execution_failed" else None) == (reason if status == "execution_failed" else None)


async def test_a_coding_harness_that_failed_to_exit_cleanly_is_an_execution_failure_whatever_it_wrote(tmp_path: Path) -> None:
    script = fx.CaseScript(termination=Termination(TerminationKind.TIMED_OUT, None, 9), workspace=answer_file('{"sum": 1}'))
    rig = Rig(tmp_path, script=script)
    result = await rig.run(fx.parse_job(fx.job_body("coding")))
    assert result.execution == {"status": "execution_failed", "reason": "timed_out"}


@pytest.mark.parametrize("policy", ["task_tools", "coding"])
async def test_both_policies_hand_the_verifier_the_same_outcome_and_reference(tmp_path: Path, policy: str) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(workspace=answer_file('{"sum": 3}')))
    await rig.run(fx.parse_job(fx.job_body(policy, private_reference="no such value")))
    assert rig.references == ["no such value"] and rig.verified == [{"status": "answered", "answer": {"sum": 3}}]


async def test_an_answer_case_with_no_reference_reaches_the_verifier_with_none(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run(fx.parse_job(fx.job_body(private_reference=None)))
    assert rig.references == [None] and rig.rush.finalized[0]["verdict"] == "pass"


async def test_the_runs_limits_are_applied_to_the_attempt_and_pinned_in_its_record(tmp_path: Path) -> None:
    limits = {"wall_time_ms": 12_000, "max_model_calls": 3, "max_output_tokens_per_call": 77, "cpus": 0.5, "memory_mb": 256, "pids": 32, "workspace_bytes": 1 << 20, "workspace_files": 77, "tmp_bytes": 2 << 20, "build_wall_ms": 9_000}
    rig = Rig(tmp_path)
    await rig.run(fx.parse_job(fx.job_body(limits=limits)))
    [spec] = rig.supervisor.specs
    assert (spec.limits.wall_s, spec.limits.cpus, spec.limits.memory_bytes, spec.limits.pids) == (12.0, 0.5, 256 << 20, 32)
    assert (spec.limits.workspace_bytes, spec.limits.workspace_files, spec.limits.tmp_bytes) == (1 << 20, 77, 2 << 20)
    policy = rig.services[0].attempt.policy
    assert (policy.max_model_calls, policy.max_output_tokens_per_call) == (3, 77)
    started = rig.rush.of("attempt.started")[0]
    assert started["policy"] == "task_tools" and started["limits"] == {**fx.LIMITS, **limits}


async def test_the_build_gets_its_own_limits_not_the_workspace_ones(tmp_path: Path) -> None:
    seen: list[Any] = []
    rig = Rig(tmp_path)
    original = rig.supervisor.build

    def build(spec: Any) -> Any:
        seen.append(spec.limits)
        return original(spec)

    rig.supervisor.build = build  # type: ignore[method-assign]
    build_limits = {"build_wall_ms": 4_500, "build_memory_mb": 2048, "build_output_bytes": 3 << 20, "build_files": 55, "build_tmp_bytes": 5 << 20, "memory_mb": 256, "workspace_bytes": 1 << 20, "workspace_files": 7}
    await rig.run(fx.parse_job(fx.job_body(limits=build_limits)))
    assert (seen[0].wall_s, seen[0].memory_bytes, seen[0].workspace_bytes, seen[0].workspace_files, seen[0].tmp_bytes) == (4.5, 2048 << 20, 3 << 20, 55, 5 << 20)


@pytest.mark.parametrize("internet", [True, False])
async def test_the_harness_network_follows_internet_access(tmp_path: Path, internet: bool) -> None:
    rig = Rig(tmp_path)
    await rig.run(fx.parse_job(fx.job_body(limits={"internet_access": internet})))
    assert [network.internet for network in rig.supervisor.networks] == [internet]
    assert rig.rush.of("attempt.started")[0]["limits"]["internet_access"] is internet


@pytest.mark.parametrize(("limits", "message"), [({"wall_time_ms": 600_001}, "wall_time_ms"), ({"memory_mb": 2048}, "memory_mb"), ({"max_cost_usd": 2.0}, "max_cost_usd")])
async def test_a_run_asking_for_more_than_the_worker_advertised_is_refused_before_anything_runs(tmp_path: Path, limits: dict[str, Any], message: str) -> None:
    rig = Rig(tmp_path)
    result = await rig.run(fx.parse_job(fx.job_body(limits=limits)))
    assert result.outcome == "platform_fault" and message in result.execution["error"]
    assert not rig.rush.finalized and rig.supervisor.builds == 0 and not rig.supervisor.networks


async def test_internet_access_is_refused_by_a_worker_that_does_not_support_it(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.runner.config = replace(rig.runner.config, capabilities={**fx.CAPABILITIES, "internet_access": False})
    result = await rig.run(fx.parse_job(fx.job_body(limits={"internet_access": True})))
    assert result.outcome == "platform_fault" and "internet_access" in result.execution["error"]
    assert rig.supervisor.builds == 0


@pytest.mark.parametrize("name", ["workspace_files", "build_memory_mb", "build_output_bytes", "build_files", "build_tmp_bytes"])
async def test_the_new_limits_are_checked_against_the_workers_capabilities(tmp_path: Path, name: str) -> None:
    rig = Rig(tmp_path)
    rig.runner.config = replace(rig.runner.config, capabilities={**fx.CAPABILITIES, name: 1})
    result = await rig.run(fx.parse_job(fx.job_body(limits={name: 2})))
    assert result.outcome == "platform_fault" and name in result.execution["error"]
    assert rig.supervisor.builds == 0


async def test_an_unknown_policy_is_refused(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    result = await rig.run(fx.parse_job(fx.job_body("agentic")))
    assert result.outcome == "platform_fault" and "agentic" in result.execution["error"]


async def test_the_tool_container_gets_the_declared_hosts_and_the_record_pins_them(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run(fx.parse_job(fx.job_body(tools=[fx.WAIT_TOOL])))
    [spec] = rig.supervisor.specs
    assert spec.tool.egress_hosts == ("api.example.com",)
    assert rig.rush.of("attempt.started")[0]["egress_hosts"] == ["api.example.com"]


async def test_the_worker_runs_at_most_its_advertised_concurrency_of_attempts_at_once(tmp_path: Path) -> None:
    from nanoagent.uploaded import worker

    rig = Rig(tmp_path)
    rig.runner.config = replace(rig.runner.config, capabilities={**fx.CAPABILITIES, "concurrency": 2})
    rig.rush.jobs = [fx.parse_job(fx.job_body(attempt_id=f"{n}1111111-1111-4111-8111-111111111111")) for n in range(5)]
    running = peak = finished = 0

    async def run(job: Any) -> Any:
        nonlocal running, peak, finished
        running += 1
        peak = max(peak, running)
        await anyio.sleep(0.05)
        running -= 1
        finished += 1
        return await original(job)

    original = rig.runner.run
    rig.runner.run = run  # type: ignore[method-assign]
    stub = type("Config", (), {"poll": worker.PollConfig(idle_s=0.01, max_idle_s=0.01)})()
    with pytest.raises(BaseExceptionGroup):
        async with anyio.create_task_group() as background:
            await worker.poll(stub, rig.runner.config, rig.rush, rig.runner, None, background)  # type: ignore[arg-type]
    assert peak == 2 and finished == 5
    assert all(claim["concurrency"] == 2 for claim in rig.rush.claims)


async def test_an_error_escaping_one_attempt_leaves_the_worker_running_the_others(tmp_path: Path) -> None:
    from nanoagent.uploaded import worker

    rig = Rig(tmp_path)
    rig.rush.jobs = [fx.parse_job(fx.job_body(attempt_id=f"{n}1111111-1111-4111-8111-111111111111")) for n in range(3)]
    outcomes: list[str] = []

    async def run(job: Any) -> Any:
        if job.attempt_id.startswith("0"):
            raise RushUnavailable("POST /renew failed after 6 attempts")  # e.g. a renewal the runner does not handle
        result = await original(job)
        outcomes.append(result.outcome)
        return result

    original = rig.runner.run
    rig.runner.run = run  # type: ignore[method-assign]
    stub = type("Config", (), {"poll": worker.PollConfig(idle_s=0.01, max_idle_s=0.01)})()
    with pytest.raises(BaseExceptionGroup) as raised:
        async with anyio.create_task_group() as background:
            await worker.poll(stub, rig.runner.config, rig.rush, rig.runner, None, background)  # type: ignore[arg-type]
    assert len(outcomes) == 2, "both other attempts ran"
    assert not raised.group_contains(RushUnavailable), "the failed attempt's error stays with it"


async def test_managed_commands_use_a_small_thread_limit_of_their_own() -> None:
    gate, lock = threading.Event(), threading.Lock()
    running = peak = 0

    class Handle:
        def exec_in_case(self, argv: Any, cwd: str, timeout_ms: int, limits: Any) -> Any:
            nonlocal running, peak
            with lock:
                running += 1
                peak = max(peak, running)
            gate.wait(5)
            with lock:
                running -= 1
            raise SandboxError("exec_failed", "stop here")

    commands = CaseCommands(None)  # type: ignore[arg-type]
    commands.handle = Handle()  # type: ignore[assignment]

    async def call() -> None:
        with pytest.raises(ExecError):
            await commands.exec(["ls"], ".", 1000, None)

    async with anyio.create_task_group() as group:
        for _ in range(EXEC_THREADS * 3):
            group.start_soon(call)
        await anyio.sleep(0.3)
        assert peak == EXEC_THREADS
        gate.set()


@pytest.mark.parametrize(("losses", "verdict"), [
    (("journal_overflow",), "fail"),
    (("journal_overflow", "root_exit_missing"), "fail"),
    (("root_exit_missing",), None),
    (("journal_overflow", "root_exit_missing", "connection_lost"), None),
])
async def test_a_crash_that_overflows_the_collector_is_scored_unless_other_evidence_is_lost(tmp_path: Path, losses: tuple[str, ...], verdict: str | None) -> None:
    script = fx.CaseScript(termination=Termination(TerminationKind.NONZERO_EXIT, 3, None), evidence=fx.evidence(False, losses))
    rig = Rig(tmp_path, script=script, verify=CaseVerdict("fail", 0.0, None))
    await rig.run()
    assert rig.rush.finalized[0]["verdict"] == verdict
    assert len(rig.verified) == (verdict is not None)


@pytest.mark.parametrize("policy", ["task_tools", "coding"])
async def test_an_outcome_with_a_lone_surrogate_is_an_invalid_result_not_a_platform_fault(tmp_path: Path, policy: str) -> None:
    if policy == "coding":
        script = fx.CaseScript(result=SandboxError("missing_result", "ignored"), workspace={"answer.json": b'{"sum": "\\udc80"}'})
    else:
        script = fx.CaseScript(result=b'{"protocol":"rush.harness.v1","status":"answered","answer":"\\udc80"}')
    rig = Rig(tmp_path, script=script)
    result = await rig.run(fx.parse_job(fx.job_body(policy)))
    assert result.outcome == "finalized" and result.execution == {"status": "execution_failed", "reason": "invalid_result"}
    for event in rig.rush.events:
        json.dumps(event, ensure_ascii=False).encode("utf-8")


class StrictSpansRush(fx.FakeRush):
    """RUSH's spansBody limits: 2000 spans and 4000 links per request."""

    async def spans(self, attempt_id: str, body: dict[str, Any]) -> None:
        if len(body["spans"]) > 2000 or len(body["links"]) > 4000:
            raise RushError(400, "invalid_request", "too many spans")
        await super().spans(attempt_id, body)


def many_processes(n: int) -> ProcessEvidence:
    events = []
    for i in range(n):
        pid = 100 + i
        events.append(ProcessEvent(2 * i, ProcessEventKind.EXEC, 1_000_000 + i, "c1", pid, 5000 + i, pid, 5000 + i, 1, "true", "/", False, ("/bin/true",)))
        events.append(ProcessEvent(2 * i + 1, ProcessEventKind.TASK_EXIT, 1_000_500 + i, "c1", pid, 5000 + i, pid, 5000 + i, 1, "true", "/", False, exit_code=0))
    return ProcessEvidence("c1", tuple(events), True, (), len(events), 0, 0, 0, 1, 0)


async def test_a_harness_with_thousands_of_processes_posts_its_spans_in_chunks_and_is_finalized(tmp_path: Path) -> None:
    rig = Rig(tmp_path, rush=StrictSpansRush(), script=fx.CaseScript(evidence=many_processes(2100)), verify=CaseVerdict("fail", 0.0, None))
    rig.runner.project = default_project
    result = await rig.run()
    assert result.outcome == "finalized" and rig.rush.finalized[0]["verdict"] == "fail"
    assert len(rig.rush.span_bodies) >= 2


async def test_a_refused_span_upload_does_not_withhold_the_verdict(tmp_path: Path) -> None:
    class Refusing(fx.FakeRush):
        async def spans(self, attempt_id: str, body: dict[str, Any]) -> None:
            raise RushError(413, "too_many_spans", "An attempt keeps 10000 spans at most")

    rig = Rig(tmp_path, rush=Refusing(), verify=CaseVerdict("fail", 0.0, None))
    result = await rig.run()
    assert result.outcome == "finalized"
    [final] = rig.rush.finalized
    assert final["verdict"] == "fail" and final["coverage"]["status"] == "partial" and final["coverage"]["reasons"] == ["trace_unavailable: RushError"]


async def test_a_projection_crash_does_not_withhold_the_verdict(tmp_path: Path) -> None:
    def crash(records: Any, payloads: Any, redactions: Any) -> Any:
        raise TypeError("unhashable type: 'list'")

    rig = Rig(tmp_path, verify=CaseVerdict("pass", 1.0, None))
    rig.runner.project = crash
    result = await rig.run()
    assert result.outcome == "finalized" and rig.rush.finalized[0]["verdict"] == "pass"
    assert rig.rush.finalized[0]["coverage"]["reasons"] == ["trace_unavailable: TypeError"]


async def test_a_lost_lease_during_the_span_upload_is_still_a_lost_lease(tmp_path: Path) -> None:
    class Losing(fx.FakeRush):
        async def spans(self, attempt_id: str, body: dict[str, Any]) -> None:
            raise LeaseLost(409, "lease_lost", "lease lost")

    rig = Rig(tmp_path, rush=Losing())
    result = await rig.run()
    assert result.outcome == "lease_lost" and rig.rush.finalized == []


async def test_the_build_gets_the_runs_wall_time_for_resolving_dependencies(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[float] = []

    def resolve(*args: Any, timeout_s: float, **kwargs: Any) -> Any:
        seen.append(timeout_s)
        return DependencyClosure(tmp_path, {})

    monkeypatch.setattr("nanoagent.uploaded.runner.resolve_dependencies", resolve)
    rig = Rig(tmp_path)
    await rig.run()
    assert seen == [600.0]  # the job's build_wall_ms


@pytest.mark.parametrize("cap", [10**6, 10])
async def test_a_snapshot_event_carries_the_diff_that_fits_and_says_when_it_is_cut(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cap: int) -> None:
    monkeypatch.setattr("nanoagent.uploaded.runner.SNAPSHOT_EVENT_DIFF_BYTES", cap)
    rig = Rig(tmp_path, verify=CaseVerdict("pass", 1.0, None))
    assert (await rig.run()).outcome == "finalized"
    [snapshot] = rig.rush.of("snapshot.taken")
    if cap == 10:
        assert snapshot["diff"] == [] and snapshot["diff_truncated"] is True
    else:
        assert [entry["path"] for entry in snapshot["diff"]] == ["out.txt"] and snapshot["diff_truncated"] is False


async def _with_harness(rig: Rig, post: Any) -> Any:
    """Runs the attempt with a blocked case; `post(client)` is the harness talking to its /events, then the harness exits."""

    async def harness() -> None:
        while not rig.services or rig.supervisor.case is None or not rig.supervisor.case.launched:
            await anyio.sleep(0.01)
        services = rig.services[0]
        headers = {"authorization": f"Bearer {services.attempt.policy.token}"}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=services.app), base_url="http://svc.test", headers=headers) as client:
            await post(client)
        await anyio.sleep(0.2)
        rig.supervisor.case.released.set()

    async with anyio.create_task_group() as group:
        group.start_soon(harness)
        return await rig.run()


async def test_a_huge_refusal_in_answer_json_is_still_scored_on_the_whole_answer(tmp_path: Path) -> None:
    reason = "x" * 300_000
    script = fx.CaseScript(result=fx.SandboxError("missing_result", "ignored"), workspace={"answer.json": json.dumps({"refused": reason}).encode()})
    rush = fx.StrictRush()
    rig = Rig(tmp_path, rush=rush, script=script, verify=CaseVerdict("fail", 0.0, "refused_answer_case"))
    result = await rig.run(fx.parse_job(fx.job_body("coding")))
    assert result.outcome == "finalized" and rush.refusals == []
    assert rig.verified == [{"status": "refused", "reason": reason}]  # the verifier saw the whole reason
    [final] = rush.finalized
    assert final["verdict"] == "fail"
    [read] = rush.of("result.read")
    assert read["outcome"]["status"] == "refused" and read["outcome"]["reason"] == reason[:64] and read["data_truncated"]
    assert json.loads(rush.payloads[read["data_payload_sha256"]])["outcome"]["reason"] == reason


async def test_a_long_argv_does_not_unscore_the_case(tmp_path: Path) -> None:
    argv = ("/bin/true", *(["A" * 4096] * 80))
    events = (
        ProcessEvent(0, ProcessEventKind.EXEC, 1_000_000, "c1", 100, 5000, 100, 5000, 1, "true", "/", False, argv),
        ProcessEvent(1, ProcessEventKind.TASK_EXIT, 1_000_500, "c1", 100, 5000, 100, 5000, 1, "true", "/", False, exit_code=0),
    )
    rush = fx.StrictRush()
    rig = Rig(tmp_path, rush=rush, script=fx.CaseScript(evidence=ProcessEvidence("c1", events, True, (), 2, 0, 0, 0, 1, 0)), verify=CaseVerdict("fail", 0.0, None))
    result = await rig.run()
    assert result.outcome == "finalized" and rush.refusals == [] and rush.finalized[0]["verdict"] == "fail"
    [exec_record] = [e for e in rush.events if e["kind"] == "process.exec"]
    assert exec_record["data"]["data_truncated"] and len(exec_record["data"]["argv"]) < len(argv)


async def test_one_event_with_a_huge_unknown_key_does_not_unscore_the_case(tmp_path: Path) -> None:
    rush = fx.StrictRush()
    rig = Rig(tmp_path, rush=rush, script=fx.CaseScript(block=True), verify=CaseVerdict("fail", 0.0, None))

    async def post(client: httpx.AsyncClient) -> None:
        body = {"protocol": "rush.harness.v1", "event": "log", "emitter_id": "e", "sequence": 1, "span_id": "s", "message": "m", "k" * 300_000: 1}
        assert (await client.post("/events", json=body)).status_code == 400

    result = await _with_harness(rig, post)
    assert result.outcome == "finalized" and rush.refusals == [] and rush.finalized[0]["verdict"] == "fail"
    [rejected] = rush.of("harness.rejected")
    assert rejected["data_truncated"] and rejected["http_status"] == 400


@pytest.mark.parametrize("queue_pressure", [False, True])
async def test_harness_event_spam_past_the_event_budget_is_dropped_and_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, queue_pressure: bool) -> None:
    class SlowRush(fx.StrictRush):
        async def append_events(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            await anyio.sleep(0.001)
            return await super().append_events(*args, **kwargs)

    monkeypatch.setattr("nanoagent.uploaded.rush_worker.EVENT_BUDGET", 40)
    rush = (SlowRush if queue_pressure else fx.StrictRush)(max_events=60)
    rig = Rig(tmp_path, rush=rush, script=fx.CaseScript(block=True), verify=CaseVerdict("fail", 0.0, None))
    rig.runner.project = default_project

    async def post(client: httpx.AsyncClient) -> None:
        if queue_pressure:
            rig.services[0].attempt.recorder._max_items = 1
        for _ in range(80):
            await client.post("/events", content=b"not json")  # a rejected post is journaled too

    result = await _with_harness(rig, post)
    if queue_pressure:
        assert rush.of("journal.backpressure")  # these harness-multiplied gateway records must obey the same budget
    assert result.outcome == "finalized" and rush.refusals == [] and len(rush.events) <= 60
    [final] = rush.finalized
    assert final["verdict"] == "fail" and final["coverage"]["status"] == "partial" and "event_budget" in final["coverage"]["loss_reasons"]
    assert any(reason.startswith("event_budget_exceeded") for reason in final["coverage"]["reasons"])
    assert "result.read" in rush.kinds() and "case.quiesced" in rush.kinds()  # the worker's closing records still fit


async def test_fifty_thousand_short_processes_stay_under_the_real_event_cap(tmp_path: Path) -> None:
    events = []
    for i in range(50_001):
        pid = 100 + i
        events.append(ProcessEvent(2 * i, ProcessEventKind.EXEC, 1_000_000 + i, "c1", pid, 5000 + i, pid, 5000 + i, 1, "true", "/", False, ("/bin/true",)))
        events.append(ProcessEvent(2 * i + 1, ProcessEventKind.TASK_EXIT, 1_000_500 + i, "c1", pid, 5000 + i, pid, 5000 + i, 1, "true", "/", False, exit_code=0))
    rush = fx.StrictRush()
    rig = Rig(tmp_path, rush=rush, script=fx.CaseScript(evidence=ProcessEvidence("c1", tuple(events), True, (), len(events), 0, 0, 0, 1, 0)), verify=CaseVerdict("fail", 0.0, None))
    rig.runner.project = default_project
    result = await rig.run()
    assert result.outcome == "finalized" and rush.refusals == [] and len(rush.events) <= 100_000
    [final] = rush.finalized
    assert final["verdict"] == "fail" and "result.read" in rush.kinds() and "event_budget" in final["coverage"]["loss_reasons"]


async def test_rejection_messages_do_not_overflow_the_finalize_coverage(tmp_path: Path) -> None:
    rush = fx.StrictRush()
    rig = Rig(tmp_path, rush=rush, script=fx.CaseScript(block=True), verify=CaseVerdict("fail", 0.0, None))
    rig.runner.project = default_project

    async def post(client: httpx.AsyncClient) -> None:
        for sequence in range(3):
            body = {"protocol": "rush.harness.v1", "event": "log", "emitter_id": "e", "sequence": sequence, "span_id": "s", "message": "m", "k" * 100_000: 1}
            await client.post("/events", json=body)

    result = await _with_harness(rig, post)
    assert result.outcome == "finalized" and rush.refusals == [] and rush.finalized[0]["verdict"] == "fail"
