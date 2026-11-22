"""The attempt runner with every dependency faked: each phase failing, and lease loss with a model stream in flight."""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import importlib.util
import io
import json
import os
import shutil
import tarfile
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
from nanoagent.plugin.verifier import CaseVerdict, VerifierError, Verification
from nanoagent.uploaded.app import AttemptServices
from nanoagent.uploaded.execservice import ExecError
from nanoagent.uploaded.outcome import answer_instructions
from nanoagent.uploaded.collector import ProcessEvent, ProcessEventKind, ProcessEvidence
from nanoagent.uploaded.rush_worker import LeaseLost, RushError, RushUnavailable
from nanoagent.uploaded.clis import CLIS
from nanoagent.uploaded.reference import FOLDER
from nanoagent.uploaded.runner import EXEC_THREADS, AttemptRunner, CaseCommands, RunnerConfig, default_project
from nanoagent.uploaded.sandbox import CLIS_DIR, BuildArtifact, SandboxError, Termination, TerminationKind
from nanoagent.uploaded.toolchains import DependencyClosure
from nanoagent.uploaded.worker import runner_config  # noqa: F401  (imported so the worker module stays importable)
from test_workspace_upload import members


CHECKS = [{"name": "outcome_exists", "status": "passed", "message": "the file is there"}, {"name": "schema_valid", "status": "failed", "message": "digest is missing"}]


def verification(valid: bool = True) -> Verification:
    return Verification(valid, 1.0 if valid else 0.0, "message", {"checks": CHECKS})


class Rig:
    def __init__(self, tmp_path: Path, *, rush: fx.FakeRush | None = None, script: fx.CaseScript | None = None, build_error: Exception | None = None, case_error: Exception | None = None, transport: Any = None, verify: Any = None, clock_ns: Any = None) -> None:
        self.rush = rush or fx.FakeRush()
        self.supervisor = fx.FakeSupervisor(tmp_path, script, build_error, case_error)
        self.relay = fx.FakeRelay()
        self.services: list[AttemptServices] = []
        self.verified: list[dict[str, Any]] = []  # the outcomes verify_task_verifier_case decided
        self.judged: list[dict[str, Any]] = []  # the answers verify_task judged (an answered answer case)
        self.references: list[Any] = []
        self.frozen: list[bool] = []  # per verifier call: whether the frozen workspace it was given held .rush/
        self.transport = transport
        self.verify_result: Any = verify or CaseVerdict("pass", 1.0, None)

        def services_factory(**kwargs: Any) -> AttemptServices:
            services = AttemptServices(transport=transport, **kwargs)
            self.services.append(services)
            return services

        def verify_task(manifest: Any, task: str, arguments: dict, answer: dict, reference: Any, workspace: Path) -> Verification:
            self.judged.append(answer)
            self.frozen.append((workspace / ".rush").exists())
            self.references.append(reference)
            if isinstance(self.verify_result, Exception):
                raise self.verify_result
            return verification(self.verify_result.verdict == "pass")

        def verify_case(manifest: Any, task: str, arguments: dict, outcome: dict, reference: Any, workspace: Path) -> CaseVerdict:
            self.verified.append(outcome)
            self.frozen.append((workspace / ".rush").exists())
            self.references.append(reference)
            if isinstance(self.verify_result, Exception):
                raise self.verify_result
            return self.verify_result

        config = RunnerConfig(
            "w-1", sf.make_endpoint(), {"test/model": (sf.Decimal("0.000001"), sf.Decimal("0.000004"))}, tmp_path / "scratch",
            output_maxima={"test/model": 64_000}, capabilities=fx.CAPABILITIES, renew_interval_s=0.05, drain_timeout_s=3,
        )
        (tmp_path / "scratch").mkdir(parents=True)
        self.runner = AttemptRunner(
            config, supervisor=self.supervisor, worker=self.rush, relay=self.relay, plugins=fx.FakePlugins(),  # type: ignore[arg-type]
            services_factory=services_factory, verify_task_case=verify_case, verify_task=verify_task, project=fx.fake_project, **({} if clock_ns is None else {"clock_ns": clock_ns}),
        )

        # The case's CLI is there at once (a test that installs one replaces this); each install asked for is kept, with whether its case's
        # VM had been made yet.
        self.installs: list[tuple[str, bool]] = []

        async def install_cli(job: Any, name: str) -> Any:
            self.installs.append((name, bool(self.supervisor.specs)))
            yield {"path": f"/opt/rush/clis/{name}/harness", "key": name}

        self.runner._install_cli = install_cli  # type: ignore[method-assign]

    async def run(self, job: Any = None):
        return await self.runner.run(job or fx.job())


async def test_answered_attempt_runs_the_whole_lifecycle_and_finalizes_once(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    result = await rig.run()
    assert result.outcome == "finalized" and result.execution == {"status": "answered", "reason": None}
    [final] = rig.rush.finalized
    assert final["execution"] == {"status": "answered", "reason": None}
    assert final["verdict"] == "pass" and final["verifier_error"] is None and final["explanation"] is None and "score" not in final
    assert final["checks"] == [{"name": "outcome_exists", "status": "passed"}, {"name": "schema_valid", "status": "failed"}]  # never their messages
    assert final["coverage"] == {"status": "complete"}
    kinds = rig.rush.kinds()
    expected = ["attempt.started", "case.launched", "case.exited", "case.quiesced", "snapshot.taken", "collector.health", "result.read", "verdict"]
    assert [kind for kind in kinds if kind in expected] == expected  # the harness exits, the workspace is frozen, then the verdict
    assert rig.judged == [{"digest": "abcdefabcdef"}] and rig.verified == []  # the verifier ran once, on the frozen workspace's answer
    assert rig.rush.of("verdict") == [{"verdict": "pass", "checks": [{"name": "outcome_exists", "status": "passed"}, {"name": "schema_valid", "status": "failed"}]}]  # records omit null fields
    assert rig.rush.span_bodies and rig.relay.handle.closed and rig.supervisor.case.closed
    assert rig.rush.of("attempt.started")[0]["expected_sources"] == ["worker", "gateway", "process"]
    assert not rig.rush.events_after_loss and rig.rush.sealed


async def test_request_points_the_guest_at_the_relay(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run()
    request = json.loads(rig.supervisor.specs[0].request_json)
    assert request["openrouter"]["base_url"] == "http://10.1.2.3:8080/api/v1"
    assert request["openrouter"]["dialects"] == ["chat_completions", "responses", "anthropic_messages"]  # the shell harness's
    assert request["exec_url"] == "http://10.1.2.3:8080/exec" and request["tools"]["url"].endswith("/tools")
    assert request["limits"] == fx.LIMITS and request["workspace"] == "/rush/workspace" and request["interactive"] is False
    assert request["prompt"] == {"system": answer_instructions({"output_schema": {"type": "object"}}), "user": fx.PROMPT, "sha256": "c" * 64}
    assert rig.services[0].attempt.policy.prompt_system == request["prompt"]["system"] and '{"type":"object"}' in request["prompt"]["system"]
    assert request["task"] == {"id": "probe", "kind": "agent", "description": "Wait, then digest a token", "plugin_name": "Acceptance probe"}
    assert request["case"] == {"case_id": "c1"} and request["harness"] == "claude" and "policy" not in request
    assert rig.supervisor.specs[0].attempt_token == rig.services[0].attempt.policy.token


async def test_the_request_and_the_vm_hold_the_prompt_alone_never_the_arguments_or_the_reference(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run()
    [spec] = rig.supervisor.specs
    wire = spec.request_json.decode()
    assert "arguments" not in wire and "input_schema" not in wire and "output_schema" not in wire and "private_reference" not in wire
    assert "wait_seconds" not in wire and "abcdefabcdef" not in wire  # the case's argument names and the reference's value
    assert rig.services[0].attempt.policy.prompt_user == fx.PROMPT


@pytest.mark.parametrize("harness", ["claude", "nanoagent", "rush mytool --flag"])
async def test_the_request_names_the_harness_the_run_pins_and_that_no_person_is_at_it(tmp_path: Path, harness: str) -> None:
    rig = Rig(tmp_path)
    body = fx.job_body(harness=harness)
    if harness.startswith("rush "):  # a member's own agent: installed in a kept Terminal session, pinned for the run and mounted in its VM
        body["run"]["run_id"] = "00000000-0000-0000-0000-000000000001"
        program = tmp_path / "scratch/sessions/s/workspace/.rush/python/bin/mytool"
        program.parent.mkdir(parents=True)
        program.write_text("#!/bin/sh\n")
        program.chmod(0o755)
        (tmp_path / "scratch/sessions/s/session.json").write_text(json.dumps({"ended_at": "2026-01-01"}))
        rig.runner.agents.remember("mytool")
    await rig.run(fx.parse_job(body))
    request = json.loads(rig.supervisor.specs[0].request_json)
    assert request["harness"] == harness and request["interactive"] is False and request["free_form"] is False
    pinned = tmp_path / "scratch/benchmark-installs/00000000-0000-0000-0000-000000000001"
    assert rig.supervisor.specs[0].agent == (pinned if harness.startswith("rush ") else None)
    if harness.startswith("rush "):
        assert (pinned / "python/bin/mytool").is_file()


SHELL = FOLDER / "shell"
HARNESSES = json.loads((SHELL / "harnesses.yaml").read_text())
_spec = importlib.util.spec_from_file_location("shell_harness", SHELL / "shell.py")
shell_harness = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shell_harness)


@pytest.mark.parametrize("entry", HARNESSES, ids=lambda entry: entry["name"])
async def test_a_case_names_a_harness_of_the_shells_table_and_the_shell_launches_its_bin_wrapper(tmp_path: Path, entry: dict) -> None:
    rig = Rig(tmp_path)
    await rig.run(fx.parse_job(fx.job_body(harness=entry["name"])))
    request = json.loads(rig.supervisor.specs[0].request_json)
    # The VM is faked, never the harness choice: the request carries the run's harness and the prompt shell.py ends the
    # argv with (tested against the table in test_shell_harnesses.py); the argv it resolves to starts at a wrapper of bin/.
    assert (request["harness"], request["interactive"], request["prompt"]["user"]) == (entry["name"], False, fx.PROMPT)
    assert (SHELL / "bin" / shell_harness.agent_argv(request["harness"])[0]).is_file()
    assert rig.supervisor.specs[0].run_argv == ("python", "/harness/shell.py")


def without_rush_files(found: dict[str, bytes]) -> dict[str, bytes]:
    """The workspace as the case's files alone: the session's own `.rush/` (its remembered agents, its agents' homes) is beside them."""
    return {path: data for path, data in found.items() if not path.startswith(".rush/")}


async def test_the_case_fixtures_are_fetched_checked_unpacked_and_seed_the_workspace(tmp_path: Path) -> None:
    data, files = fx.fixtures_archive({"inputs/a.csv": b"x,y\n1,2\n", "inputs/cloud.json": b"{}"})
    body = fx.job_body()
    body["case"]["fixtures"] = {"sha256": hashlib.sha256(data).hexdigest(), "files": files}
    rig = Rig(tmp_path, rush=fx.FakeRush(data))
    result = await rig.run(fx.parse_job(body))
    assert result.outcome == "finalized"
    [spec] = rig.supervisor.specs
    assert spec.fixtures is not None and spec.fixtures.name == "fixtures"
    assert without_rush_files(rig.supervisor.case.found) == {"inputs/a.csv": b"x,y\n1,2\n", "inputs/cloud.json": b"{}", "answer.json": SEEDED_ANSWER}  # the workspace at start holds the fixtures and the unfilled answer


SEEDED_ANSWER = b"{}\n"  # the skeleton of the probe task's output schema, `{"type": "object"}`, in the seeded format


async def test_a_case_without_fixtures_fetches_none_and_starts_with_only_the_seeded_answer(tmp_path: Path) -> None:
    rig = Rig(tmp_path)  # a fetch would fail: FakeRush has no archive
    await rig.run()
    [spec] = rig.supervisor.specs
    assert spec.fixtures is not None  # a folder of its own, though the case has no fixtures
    assert without_rush_files(rig.supervisor.case.found) == {"answer.json": SEEDED_ANSWER}


async def test_the_seeded_answer_is_the_skeleton_of_the_tasks_output_schema_in_stable_format(tmp_path: Path) -> None:
    body = fx.job_body()
    body["task"]["output_schema"] = {"type": "object", "properties": {"digest": {"type": "string"}, "rows": {"type": "array", "items": {"type": "integer"}}}}
    rig = Rig(tmp_path)
    await rig.run(fx.parse_job(body))
    assert without_rush_files(rig.supervisor.case.found)["answer.json"] == b'{\n  "digest": null,\n  "rows": []\n}\n'


async def test_a_session_that_leaves_the_seeded_answer_untouched_has_no_result(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(workspace={"answer.json": SEEDED_ANSWER}))
    out = await rig.run()
    assert out.execution == {"status": "execution_failed", "reason": "missing_result"} and rig.verified == []


def assert_worker_error(rig: Rig, fragment: str) -> None:
    """The attempt was finalized as a worker error whose reason names `fragment`, with no verdict and no verifier run."""
    [body] = rig.rush.finalized
    assert body["execution"]["status"] == "worker_error" and fragment in body["execution"]["reason"] and len(body["execution"]["reason"]) <= 200
    assert body["verdict"] is None and body["verifier_error"] is None and rig.rush.sealed


@pytest.mark.parametrize("fault", ["wrong digest", "extra file", "link"])
async def test_fixtures_that_are_not_what_the_claim_says_end_the_attempt_as_a_worker_error(tmp_path: Path, fault: str) -> None:
    data, files = fx.fixtures_archive({"a.txt": b"a"})
    declared = {"sha256": hashlib.sha256(data).hexdigest(), "files": files}
    if fault == "wrong digest":
        declared["sha256"] = "0" * 64
    elif fault == "extra file":
        declared["files"] = {**files, "b.txt": "0" * 64}
    else:
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as tar:
            link = tarfile.TarInfo("a.txt")
            link.type, link.linkname = tarfile.SYMTYPE, "/etc/passwd"
            tar.addfile(link)
        data = gzip.compress(buffer.getvalue(), mtime=0)
        declared = {"sha256": hashlib.sha256(data).hexdigest(), "files": {}}
    body = fx.job_body()
    body["case"]["fixtures"] = declared
    rig = Rig(tmp_path, rush=fx.FakeRush(data))
    result = await rig.run(fx.parse_job(body))
    assert result.outcome == "worker_error" and "fixtures_" in result.execution["error"]
    assert rig.supervisor.specs == [] and rig.verified == [] and rig.judged == []
    assert_worker_error(rig, "fixtures_")


async def test_a_failing_shell_build_is_a_worker_error_not_a_member_failure(tmp_path: Path) -> None:
    rig = Rig(tmp_path, build_error=SandboxError("build_failed", "build exited 2"))
    result = await rig.run()
    assert result.outcome == "worker_error" and "build_failed" in result.execution["error"]
    assert rig.supervisor.case is None and rig.verified == [] and rig.judged == []
    assert_worker_error(rig, "build_failed")


async def test_a_free_form_sessions_fault_finalizes_nothing_and_it_expires_as_interrupted(tmp_path: Path) -> None:
    rig = Rig(tmp_path, build_error=SandboxError("build_failed", "build exited 2"))
    result = await rig.run(fx.free_job())
    assert result.outcome == "platform_fault" and "build_failed" in result.execution["error"]
    assert not rig.rush.finalized and not rig.rush.sealed


async def test_the_shell_is_the_only_harness_built_whatever_the_run_names(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run(fx.job(harness="codex"))
    started = rig.rush.of("attempt.started")[0]
    assert rig.supervisor.probed == ["shell-1"] and started["policy"] == "shell" and started["toolchain"] == "shell-1"
    assert rig.supervisor.specs[0].run_argv == ("python", "/harness/shell.py")


async def test_timeout_is_an_execution_failure_the_verifier_never_sees(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(termination=Termination(TerminationKind.TIMED_OUT, None, 9)))
    result = await rig.run()
    assert result.execution == {"status": "execution_failed", "reason": "timed_out"}
    assert rig.verified == [] and rig.judged == []  # no verifier ran; the case is a failure all the same
    assert (rig.rush.finalized[0]["verdict"], rig.rush.finalized[0]["explanation"], rig.rush.finalized[0].get("checks")) == ("fail", "execution_failed", None)
    assert rig.rush.of("case.exited")[0]["termination"] == {"status": "timed_out"}


@pytest.mark.parametrize(
    ("termination", "reason"),
    [
        (Termination(TerminationKind.TIMED_OUT, None, 9), "timed_out"),
        (Termination(TerminationKind.SIGNALED, None, 9), "signaled"),
        (Termination(TerminationKind.NONZERO_EXIT, 3, None), "nonzero_exit"),
        (Termination(TerminationKind.EXITED, 2, None), "nonzero_exit"),
    ],
)
async def test_a_harness_that_did_not_exit_cleanly_is_an_execution_failure_without_a_verifier_call_whatever_it_wrote(tmp_path: Path, termination: Termination, reason: str) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(termination=termination))  # answer.json is in its workspace
    result = await rig.run()
    assert result.execution == {"status": "execution_failed", "reason": reason}
    assert rig.verified == [] and rig.judged == [] and rig.rush.of("result.read") == [{"outcome": {"status": "execution_failed", "reason": reason}}]


@pytest.mark.parametrize(
    ("workspace", "reason"),
    [({}, "missing_result"), ({"answer.json": b"nope"}, "invalid_result"), ({"answer.json": b'{"sum": "\\udc80"}'}, "invalid_result")],
)
async def test_a_missing_or_invalid_answer_file_is_an_execution_failure_without_a_verifier_call(tmp_path: Path, workspace: dict[str, bytes], reason: str) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(workspace=workspace))
    out = await rig.run()
    assert out.outcome == "finalized" and out.execution == {"status": "execution_failed", "reason": reason}
    assert rig.verified == [] and rig.judged == []
    for event in rig.rush.events:
        json.dumps(event, ensure_ascii=False).encode("utf-8")  # a lone surrogate never reaches the journal


async def test_nonzero_exit_with_incomplete_process_evidence_leaves_the_score_unavailable(tmp_path: Path) -> None:
    script = fx.CaseScript(termination=Termination(TerminationKind.NONZERO_EXIT, 3, None), evidence=fx.evidence(False, ("root_exit_missing",)))
    rig = Rig(tmp_path, script=script)
    result = await rig.run()
    assert result.execution == {"status": "execution_failed", "reason": "nonzero_exit"}
    assert rig.verified == [] and rig.rush.finalized[0]["verdict"] is None and rig.rush.finalized[0]["verifier_error"] is None
    assert rig.rush.of("collector.health")[0]["complete"] is False


@pytest.mark.parametrize("error", [VerifierError("boom: private detail"), RuntimeError("boom: private detail"), ValueError("boom: private detail")])
async def test_a_verifier_that_raises_is_a_verifier_error_never_a_pass_and_keeps_the_trace(tmp_path: Path, error: Exception) -> None:
    rig = Rig(tmp_path, verify=error)
    result = await rig.run()
    assert result.execution == {"status": "answered", "reason": None}
    final = rig.rush.finalized[0]
    assert final["verdict"] is None and final["verifier_error"] == "verifier_error" and "checks" not in final
    assert rig.rush.of("verdict") == [{"verifier_error": "verifier_error"}]
    assert "private detail" not in str(rig.rush.events)


@pytest.mark.parametrize("checks", [[{"name": "a"}], "no", [{"name": "a", "status": "maybe"}], [{"name": "", "status": "passed"}], [{"name": "a", "status": "passed"}] * 101])
async def test_checks_that_are_not_named_statuses_are_a_verifier_error(tmp_path: Path, checks: Any) -> None:
    rig = Rig(tmp_path)
    rig.runner.verify_task = lambda *args: Verification(True, 1.0, "m", {"checks": checks})  # type: ignore[assignment]
    await rig.run()
    assert rig.rush.finalized[0]["verdict"] is None and rig.rush.finalized[0]["verifier_error"] == "verifier_error"


async def test_a_verifier_that_names_no_checks_finalizes_a_verdict_without_them(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.runner.verify_task = lambda *args: Verification(False, 0.0, "m", {})  # type: ignore[assignment]
    await rig.run()
    assert (rig.rush.finalized[0]["verdict"], rig.rush.finalized[0].get("checks"), rig.rush.finalized[0]["explanation"]) == ("fail", None, None)


async def test_a_free_form_session_is_seeded_no_answer_file(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run(fx.free_job())
    assert rig.supervisor.specs[0].fixtures is None and "answer.json" not in rig.supervisor.case.found


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


async def test_a_free_form_session_has_no_case_reads_no_result_and_ends_unscored(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(workspace=answer_file('{"digest": "abcdefabcdef"}')))
    result = await rig.run(fx.free_job())
    request = json.loads(rig.supervisor.specs[0].request_json)
    assert (request["free_form"], request["task"], request["case"], request["prompt"]) == (True, None, None, None)
    assert rig.rush.packages == 0  # nothing of the plugin is fetched, unpacked or synced
    assert rig.services[0].attempt.policy.prompt_user is None
    assert result.execution == {"status": "ended", "reason": None} and rig.verified == []
    assert rig.rush.finalized[0]["verdict"] is None and rig.rush.of("result.read") == [] and rig.rush.of("collector.health")
    # A session starts with none of a task's tools and no tool container: its `nanoagent` asks for them.
    assert request["tools"]["available"] == [] and rig.supervisor.specs[0].tool is None and rig.supervisor.prepared == []
    assert "egress_hosts" not in rig.rush.of("attempt.started")[0]
    assert rig.supervisor.probed == ["shell-1"]  # the tracer proven in the toolchain's image before the build


async def test_a_free_form_sessions_nanoagent_starts_the_plugins_tools_which_serve_its_token_alone(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(block=True))
    seen: dict[str, Any] = {}

    async def nanoagent(client: httpx.AsyncClient) -> None:
        assert rig.supervisor.attached == [] and rig.rush.opened == []  # the shell starts with no tools VM
        started = [(await client.post("/tools/start")).json() for _ in range(2)]
        token = started[0]["token"]
        seen["started"] = started
        seen["theirs"] = await client.post("/tools", json={"name": "wait", "arguments": {}}, headers={"authorization": f"Bearer {token}"})
        seen["shell"] = await client.post("/tools", json={"name": "wait", "arguments": {}})  # the attempt token every process holds

    result = await _with_harness(rig, nanoagent, fx.free_job())
    first, again = seen["started"]
    assert first == again and rig.rush.opened == [fx.ATTEMPT_ID]  # started once, for the session's first `nanoagent`
    instructions = fx.FakePlugins().manifest.task("probe").instructions  # the plugin's own, read from its package
    assert [tool["name"] for tool in first["tools"]] == ["wait"] and first["system"].endswith(f"Task: Wait, then digest a token.\n{instructions}")
    [attached] = rig.supervisor.attached  # one tool VM, booted beside the running case
    assert attached.egress_hosts == ("api.example.com",)
    assert seen["theirs"].json()["output"] == {"waited": 0.0} and seen["shell"].status_code == 401
    assert result.execution == {"status": "ended", "reason": None} and rig.rush.of("tool.completed")


async def test_a_free_form_sessions_tools_that_cannot_start_say_why_to_each_nanoagent(tmp_path: Path) -> None:
    rush = fx.FakeRush()
    rush.tools_error = fx.RushError(409, "package_unavailable", "acceptance-probe's installed version is not published")
    rig = Rig(tmp_path, rush=rush, script=fx.CaseScript(block=True))
    answers: list[httpx.Response] = []

    async def nanoagent(client: httpx.AsyncClient) -> None:
        answers.extend([await client.post("/tools/start"), await client.post("/tools/start")])

    result = await _with_harness(rig, nanoagent, fx.free_job())
    assert [answer.status_code for answer in answers] == [503, 503], answers[0].text
    assert rush.opened == [fx.ATTEMPT_ID]
    assert answers[0].json()["error"]["message"] == "the plugin's tools could not start: acceptance-probe's installed version is not published"
    assert rig.supervisor.attached == [] and result.execution == {"status": "ended", "reason": None}


async def test_a_cases_tools_that_cannot_start_are_a_worker_error_not_the_harnesss_failure(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(block=True))
    rig.supervisor.attach_error = SandboxError("start_failed", "create tool container: injected launch failure")
    answers: list[httpx.Response] = []

    async def nanoagent(client: httpx.AsyncClient) -> None:
        answers.append(await client.post("/tools/start"))

    result = await _with_harness(rig, nanoagent, fx.parse_job(fx.job_body(tools=[fx.WAIT_TOOL])))
    assert [answer.status_code for answer in answers] == [503]
    assert result.outcome == "worker_error" and "start_failed" in result.execution["error"]
    assert_worker_error(rig, "start_failed")  # unscored: a worker error, not a failed attempt of the harness


async def test_a_free_form_session_is_kept_to_resume_and_a_resuming_one_starts_on_its_workspace(tmp_path: Path) -> None:
    state = Path(__file__).parent / "fixtures" / "claude_state"  # two `claude -p` runs
    made = {"notes.txt": b"made here", ".rush/clis/claude": b"key"} | {
        str(path.relative_to(state)): path.read_bytes() for path in state.rglob("*.jsonl")
    }
    rig = Rig(tmp_path / "first", script=fx.CaseScript(made=made))
    await rig.run(fx.free_job(attempt_id="11111111-1111-4111-8111-000000000001"))
    finalized = rig.rush.finalized[0]
    assert finalized["resumable"] is True and finalized["evicted"] == [] and rig.supervisor.case.found == {".rush/agents": b""}  # no program remembered yet
    assert [(chat["agent"], chat["title"]) for chat in finalized["chats"]] == [("claude", "say ok"), ("claude", "List the files in this folder")]
    uploaded = finalized["workspace"]  # its files went to RUSH too, without the agents' state
    archive = tmp_path / "uploaded.tar.zst"
    archive.write_bytes(b"".join(rig.rush.payloads[sha] for sha in uploaded["chunks"]))
    assert uploaded["bytes"] == archive.stat().st_size and set(members(archive)) == {"notes.txt"}

    def later(name: str) -> Rig:  # another session on the same computer
        rig = Rig(tmp_path / name)
        shutil.copytree(tmp_path / "first" / "scratch" / "sessions", tmp_path / name / "scratch" / "sessions")
        return rig

    first = "aaaa1111-0000-4000-8000-000000000001"
    rig = later("second")
    resume = {"attempt_id": "11111111-1111-4111-8111-000000000001", "at": "2026-11-18T22:31:00Z", "chat": {"agent": "claude", "id": first, "run": None}}
    await rig.run(fx.free_job(attempt_id="11111111-1111-4111-8111-000000000002", resume=resume))
    found = rig.supervisor.case.found  # the workspace as the shell started
    own = {name: data for name, data in made.items() if not name.startswith(".rush/clis/")}  # the chat's own files: no other state
    assert {name: found[name] for name in own} == own and ".rush/clis/claude" not in found
    said = json.loads(found[".rush/resume-0.json"])
    assert said["line"].startswith("Reopened your claude session from Nov 18") and said["run"] == f"claude --resume {first}"
    assert rig.rush.finalized[0]["chats"] == []  # it held none it did not talk in
    # A session this computer does not have says so, and the terminal starts empty.
    rig = later("third")
    await rig.run(fx.free_job(attempt_id="11111111-1111-4111-8111-000000000003", resume={"attempt_id": "11111111-1111-4111-8111-000000000004", "at": "2026-11-18T22:31:00Z", "chat": None}))
    found = rig.supervisor.case.found
    assert sorted(found) == [".rush/agents", ".rush/resume-0.json"] and "it is not on this computer" in json.loads(found[".rush/resume-0.json"])["line"]
    # A new session started under an agent runs its CLI in its first terminal.
    rig = Rig(tmp_path / "fourth")
    await rig.run(fx.free_job(attempt_id="11111111-1111-4111-8111-000000000005", start="codex"))
    assert json.loads(rig.supervisor.case.found[".rush/resume-0.json"]) == {"run": "codex"}


async def test_a_free_form_session_over_the_upload_cap_uploads_nothing_and_says_so(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(made={"noise.bin": os.urandom(256 << 10)}))
    rig.runner.config = replace(rig.runner.config, workspace_upload_bytes=64 << 10)
    await rig.run(fx.free_job())
    finalized = rig.rush.finalized[0]
    assert finalized["workspace"] == {"error": "its files are larger than the 0.0625 MB a session uploads, compressed"}
    assert not any(data.startswith(b"\x28\xb5\x2f\xfd") for data in rig.rush.payloads.values())  # no piece of a zstd archive went


async def test_a_free_form_session_its_member_left_is_recorded_whole_and_kept_to_resume_and_a_scored_one_never_is(tmp_path: Path) -> None:
    # Stop, leaving the page or opening another session cancels a Terminal session: that is how its member ends it, so its case ends
    # as at an exit (its processes killed under the tracer, the VM kept) and it is recorded as one that exited is.
    events = (
        ProcessEvent(0, ProcessEventKind.EXEC, 1_000_000, "c1", 100, 5000, 100, 5000, 1, "claude", "/", False, ("claude",)),
        ProcessEvent(1, ProcessEventKind.TASK_EXIT, 1_000_500, "c1", 100, 5000, 100, 5000, 1, "claude", "/", False, exit_code=0),
    )
    cpu = [{"identity": {"role": "harness", "container": "c1"}, "user_ns": 5, "system_ns": 0}]
    script = fx.CaseScript(block=True, made={"a.txt": b"a"}, evidence=ProcessEvidence("c1", events, True, (), 2, 0, 0, 0, 1, 0), cpu=cpu)
    rig = Rig(tmp_path, script=script)
    rig.rush.canceled = True
    await rig.run(fx.free_job(attempt_id="11111111-1111-4111-8111-000000000005"))
    assert rig.rush.finalized[0]["execution"]["status"] == "canceled" and rig.rush.finalized[0]["resumable"] is True
    assert rig.supervisor.case.ended and rig.supervisor.case.drained
    kinds = rig.rush.kinds()
    assert {"case.exited", "snapshot.taken", "cpu.counters", "collector.health", "process.exec", "process.exit"} <= set(kinds)
    assert kinds.index("case.exited") < kinds.index("case.quiesced")
    assert (tmp_path / "scratch" / "sessions" / "11111111-1111-4111-8111-000000000005" / "workspace" / "a.txt").read_bytes() == b"a"
    scored = Rig(tmp_path / "scored")
    await scored.run()
    assert "resumable" not in scored.rush.finalized[0] and not (tmp_path / "scored" / "scratch" / "sessions").exists()


async def test_a_running_free_form_session_sends_its_processes_as_they_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # The Dashboard names a session's agents and chats from its spans, so a running one sends its trace so far, the processes the tracer
    # has written projected with the journal, each span under the id the session's end gives it.
    monkeypatch.setattr("nanoagent.uploaded.runner.LIVE_SPANS_S", 0.01)
    started = (ProcessEvent(0, ProcessEventKind.EXEC, 1_000_000, "c1", 100, 5000, 100, 5000, 1, "codex", "/", False, ("codex",)),)
    rig = Rig(tmp_path, script=fx.CaseScript(block=True, evidence=ProcessEvidence("c1", started, True, (), 1, 0, 0, 0, 1, 0)))
    projected: list[list[str]] = []

    def project(records: list[dict], payloads: Any, redactions: Any) -> fx.FakeProjection:
        projected.append([record["kind"] for record in records])
        return fx.FakeProjection()

    rig.runner.project = project

    async def leave() -> None:
        while not projected:
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.1)  # ticks that find nothing new
        rig.rush.canceled = True  # the member leaves the page

    async with asyncio.TaskGroup() as group:
        group.create_task(leave())
        await rig.run(fx.free_job())
    live = projected[:-1]  # the last is the session's end
    assert live and all("process.exec" in kinds and "collector.health" not in kinds for kinds in live)
    assert len(live) == 1 and len(rig.rush.span_bodies) == 2  # nothing new, nothing sent again


async def test_a_workspace_over_its_bound_is_a_scored_failure_not_a_platform_fault(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(drain_error=SandboxError("snapshot_too_large", "more than 20000 files")))
    result = await rig.run()
    assert result.execution == {"status": "execution_failed", "reason": "invalid_result"}
    assert rig.verified == [] and rig.judged == []  # the verifier did not run
    assert rig.rush.finalized[0]["verdict"] == "fail" and rig.rush.finalized[0]["explanation"] == "execution_failed"


async def test_other_drain_errors_are_worker_errors(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(drain_error=SandboxError("freeze_failed", "freeze the sandbox")))
    assert (await rig.run()).outcome == "worker_error"


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
    assert rig.relay.handle.closed


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

    rush.package = lost  # type: ignore[method-assign]
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


async def test_a_tool_suite_prepares_the_plugin_before_the_harness_starts_and_its_tool_container_comes_when_nanoagent_asks(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run(fx.parse_job(fx.job_body(tools=[fx.WAIT_TOOL])))
    [spec] = rig.supervisor.specs
    assert spec.tool is None and len(rig.supervisor.prepared) == 1  # the plugin is synced for the verifier and its tools
    assert rig.supervisor.attached == [] and rig.rush.opened == []  # no `nanoagent` asked, so no tool VM
    assert rig.supervisor.case.launched


async def test_a_plugin_synced_once_serves_the_next_tooled_attempt_without_another_sync(tmp_path: Path) -> None:
    for name in ("first", "second"):
        (tmp_path / name).mkdir()
    first, second = Rig(tmp_path / "first"), Rig(tmp_path / "second")
    second.runner.config = first.runner.config  # the same scratch folder, as one worker's attempts share
    for rig in (first, second):
        await rig.run(fx.parse_job(fx.job_body(tools=[fx.WAIT_TOOL])))
        assert rig.supervisor.case.launched
    assert (len(first.supervisor.prepared), len(second.supervisor.prepared)) == (1, 0)


async def test_a_tool_container_launch_failure_ends_only_that_attempt_and_leaves_nothing_behind(tmp_path: Path) -> None:
    rig = Rig(tmp_path, case_error=SandboxError("start_failed", "create tool container: injected"))
    result = await rig.run(fx.parse_job(fx.job_body(tools=[fx.WAIT_TOOL])))
    assert result.outcome == "worker_error" and "start_failed" in result.execution["error"]
    assert_worker_error(rig, "start_failed")  # the worker finalizes it as a worker error, and RUSH queues the case again
    assert rig.relay.handle.closed
    assert not (tmp_path / "scratch" / fx.ATTEMPT_ID).exists()
    assert "attempt.started" in rig.rush.kinds() and "case.launched" not in rig.rush.kinds()
    renews = rig.rush.renew_attempts
    await anyio.sleep(0.3)  # six renewal intervals
    assert rig.rush.renew_attempts == renews, "a faulted attempt stops renewing its lease"


async def test_a_fault_after_launch_stops_the_case_and_commits_the_process_evidence(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(drain_error=RuntimeError("the workspace volume vanished")))
    result = await rig.run()
    assert result.outcome == "worker_error" and "the workspace volume vanished" in result.execution["error"]
    assert_worker_error(rig, "the workspace volume vanished")
    assert rig.supervisor.case.closed
    assert rig.rush.of("collector.health"), "the evidence the collector had is kept on the interrupted attempt"
    assert rig.services[0].attempt.revoked


@pytest.mark.parametrize("tools", [[], [fx.WAIT_TOOL]], ids=["no_tools", "task_tools"])
async def test_a_worker_shutdown_mid_case_still_closes_the_case_and_its_relay(tmp_path: Path, tools: list) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(block=True))
    with anyio.fail_after(10):
        async with anyio.create_task_group() as group:
            group.start_soon(rig.run, fx.parse_job(fx.job_body(tools=tools)))
            while "case.launched" not in rig.rush.kinds():
                await anyio.sleep(0.01)
            group.cancel_scope.cancel()  # what Ctrl-C, or another attempt's fault, does to every attempt in flight
    assert rig.supervisor.case.closed and rig.relay.handle.closed


async def test_the_worker_goes_on_to_its_next_job_after_a_worker_error(tmp_path: Path) -> None:
    from nanoagent.uploaded import worker

    first = fx.job_body(attempt_id="11111111-1111-4111-8111-111111111111", tools=[fx.WAIT_TOOL])
    rig = Rig(tmp_path, case_error=SandboxError("start_failed", "create tool container: injected"))
    rig.rush.jobs = [fx.parse_job(first), fx.job()]
    config = worker.PollConfig(idle_s=0.01)
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


async def test_a_renewal_interval_that_cannot_keep_the_lease_alive_is_a_worker_error(tmp_path: Path) -> None:
    body = fx.job_body(lease_seconds=0.01)
    rig = Rig(tmp_path)
    result = await rig.run(fx.parse_job(body))
    assert result.outcome == "worker_error" and "renew_interval_s" in result.execution["error"]
    assert rig.supervisor.builds == 0


# -- policies, limits and the network (rush.harness.v1) --------------------------------------------------------------------


def answer_file(content: bytes | str) -> dict[str, bytes]:
    return {"answer.json": content.encode() if isinstance(content, str) else content}


async def test_a_case_session_gets_the_tasks_tools_and_reads_answer_json_from_the_frozen_workspace(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(workspace=answer_file('{"digest": "999999999999"}')))
    await rig.run(fx.parse_job(fx.job_body(tools=[fx.WAIT_TOOL])))
    request = json.loads(rig.supervisor.specs[0].request_json)
    assert request["tools"]["available"] == [] and rig.supervisor.specs[0].tool is None  # its tools are `nanoagent`'s, started when it asks
    assert rig.judged == [{"digest": "999999999999"}]
    assert rig.rush.of("attempt.started")[0]["expected_sources"] == ["worker", "gateway", "process"]


async def test_a_case_session_captures_what_a_terminal_session_does_before_its_verdict(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run()
    [final] = rig.rush.finalized
    kinds = rig.rush.kinds()
    assert final["chats"] == [] and "workspace" in final and "resumable" not in final  # held beside the verdict; a case is not resumed
    assert "collector.health" in kinds and kinds.index("case.exited") < kinds.index("snapshot.taken") < kinds.index("verdict")


async def test_a_task_without_tools_has_no_tool_container(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    result = await rig.run()
    request = json.loads(rig.supervisor.specs[0].request_json)
    assert result.execution == {"status": "answered", "reason": None}
    assert request["tools"]["available"] == [] and rig.supervisor.specs[0].tool is None and rig.supervisor.prepared == []
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
        (answer_file('{"digest": 7}'), "answered", None),
    ],
)
async def test_outcomes_follow_the_answer_file(tmp_path: Path, workspace: dict[str, bytes], status: str, reason: str | None) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(workspace=workspace))
    result = await rig.run()
    assert result.execution["status"] == status
    [outcome] = rig.rush.of("result.read")
    assert outcome["outcome"]["status"] == status and outcome["outcome"].get("reason") == reason
    # An answer of the wrong shape and a refusal are decided without plugin code; an execution failure never reaches a verifier.
    assert [item["status"] for item in rig.verified] == ([] if status == "execution_failed" else [status]) and rig.judged == []


async def test_an_answer_case_hands_verify_task_the_reference_and_a_refusal_case_its_error(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    await rig.run(fx.parse_job(fx.job_body(private_reference={"digest": "abcdefabcdef"})))
    assert rig.references == [{"digest": "abcdefabcdef"}] and rig.verified == []
    (tmp_path / "refusal").mkdir()
    refusal = Rig(tmp_path / "refusal")
    await refusal.run(fx.parse_job(fx.job_body(private_reference="no such value")))
    assert refusal.references == ["no such value"] and refusal.judged == []  # answered a refusal case: decided without the plugin
    assert refusal.verified == [{"status": "answered", "answer": {"digest": "abcdefabcdef"}}]


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
    assert started["policy"] == "shell" and started["limits"] == {**fx.LIMITS, **limits}


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
    assert result.outcome == "worker_error" and message in result.execution["error"]
    assert_worker_error(rig, message)
    assert rig.supervisor.builds == 0 and not rig.supervisor.networks


async def test_internet_access_is_refused_by_a_worker_that_does_not_support_it(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.runner.config = replace(rig.runner.config, capabilities={**fx.CAPABILITIES, "internet_access": False})
    result = await rig.run(fx.parse_job(fx.job_body(limits={"internet_access": True})))
    assert result.outcome == "worker_error" and "internet_access" in result.execution["error"]
    assert rig.supervisor.builds == 0


@pytest.mark.parametrize("name", ["workspace_files", "build_memory_mb", "build_output_bytes", "build_files", "build_tmp_bytes"])
async def test_the_new_limits_are_checked_against_the_workers_capabilities(tmp_path: Path, name: str) -> None:
    rig = Rig(tmp_path)
    rig.runner.config = replace(rig.runner.config, capabilities={**fx.CAPABILITIES, name: 1})
    result = await rig.run(fx.parse_job(fx.job_body(limits={name: 2})))
    assert result.outcome == "worker_error" and name in result.execution["error"]
    assert rig.supervisor.builds == 0


async def test_the_tool_container_nanoagent_asks_for_gets_the_declared_hosts(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(block=True))

    async def nanoagent(client: httpx.AsyncClient) -> None:
        response = await client.post("/tools/start")
        assert response.status_code == 200, response.text

    await _with_harness(rig, nanoagent, fx.parse_job(fx.job_body(tools=[fx.WAIT_TOOL])))
    [tool] = rig.supervisor.attached
    assert tool.egress_hosts == ("api.example.com",)


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
    stub = type("Config", (), {"poll": worker.PollConfig(idle_s=0.01)})()
    with pytest.raises(BaseExceptionGroup):
        async with anyio.create_task_group() as background:
            await worker.poll(stub, rig.runner.config, rig.rush, rig.runner, None, background)  # type: ignore[arg-type]
    assert peak == 2 and finished == 5
    assert all(claim["concurrency"] == 2 for claim in rig.rush.claims)


async def test_a_scored_run_runs_beside_an_open_terminal_in_the_slot_kept_for_it(tmp_path: Path) -> None:
    from nanoagent.uploaded import worker

    rig = Rig(tmp_path)
    rig.runner.config = replace(rig.runner.config, capabilities={**fx.CAPABILITIES, "concurrency": 1})
    terminal = fx.job_body(attempt_id="11111111-1111-4111-8111-111111111111")
    terminal["run"]["interactive"] = True
    rig.rush.jobs = [fx.parse_job(terminal), fx.parse_job(fx.job_body(attempt_id="21111111-1111-4111-8111-111111111111"))]
    scored_while_open: list[bool] = []
    open_terminal = anyio.Event()

    async def run(job: Any) -> Any:
        if job.run["interactive"]:  # the member works at the terminal until the scored run has run
            open_terminal.set()
            with anyio.fail_after(5):
                while not scored_while_open:
                    await anyio.sleep(0.01)
        else:
            await open_terminal.wait()
            scored_while_open.append(True)
        return await original(job)

    original = rig.runner.run
    rig.runner.run = run  # type: ignore[method-assign]
    stub = type("Config", (), {"poll": worker.PollConfig(idle_s=0.01)})()
    with pytest.raises(BaseExceptionGroup):
        async with anyio.create_task_group() as background:
            await worker.poll(stub, rig.runner.config, rig.rush, rig.runner, None, background)  # type: ignore[arg-type]
    assert scored_while_open == [True]


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
    stub = type("Config", (), {"poll": worker.PollConfig(idle_s=0.01)})()
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
    assert rig.verified == [] and rig.judged == []  # an execution failure is a failed case with no verifier


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


async def _with_harness(rig: Rig, post: Any, job: Any = None) -> Any:
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
        return await rig.run(job)


async def test_a_huge_refusal_in_answer_json_is_still_scored_on_the_whole_answer(tmp_path: Path) -> None:
    reason = "x" * 300_000
    script = fx.CaseScript(workspace={"answer.json": json.dumps({"refused": reason}).encode()})
    rush = fx.StrictRush()
    rig = Rig(tmp_path, rush=rush, script=script, verify=CaseVerdict("fail", 0.0, "refused_answer_case"))
    result = await rig.run()
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


async def test_a_later_attempt_of_the_same_source_runs_the_build_an_earlier_one_kept(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    first = await rig.run()
    rig.runner.worker = fx.FakeRush()  # the next attempt's lease
    second = await rig.run(fx.job(attempt_id="22222222-2222-4222-8222-222222222222"))
    assert first.outcome == second.outcome == "finalized" and rig.supervisor.builds == 1
    [kept] = (tmp_path / "scratch" / "builds").iterdir()
    assert rig.supervisor.specs[0].artifact.directory == rig.supervisor.specs[1].artifact.directory == kept / "harness"


async def test_a_terminal_session_is_handed_the_warm_terminal_the_one_before_it_left(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript())
    async with anyio.create_task_group() as group:
        group.start_soon(rig.runner.keep_warm)
        assert (await rig.run(fx.free_job())).execution == {"status": "ended", "reason": None}  # none warm yet: booted and launched
        with anyio.fail_after(5):
            while rig.runner._warm is None:
                await anyio.sleep(0.01)
        warm = rig.runner._warm.handle  # not the supervisor's last case: the CLIs' installs ahead of a session make cases too
        assert warm.launched and {"wait_go": True} in [json.loads(spec.request_json) for spec in rig.supervisor.specs]
        rig.rush = rig.runner.worker = fx.FakeRush()  # the next session's attempt
        # opened from another plugin's page: one warm terminal serves every plugin
        second = await rig.run(fx.free_job(attempt_id="33333333-3333-4333-8333-333333333333", plugin={"id": "another-plugin"}))
        assert second.execution == {"status": "ended", "reason": None}
        request, token = warm.went
        assert request["free_form"] is True and token and len(rig.supervisor.specs) >= 2
        assert json.loads((tmp_path / "scratch" / "warm.json").read_text()) == fx.LIMITS  # kept for the worker's next start
        group.cancel_scope.cancel()


async def test_a_worker_start_warms_a_terminal_from_the_limits_the_last_session_left(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    (tmp_path / "scratch" / "warm.json").write_text(json.dumps(fx.LIMITS))
    async with anyio.create_task_group() as group:
        group.start_soon(rig.runner.keep_warm)
        with anyio.fail_after(10):
            while rig.runner._warm is None:
                await anyio.sleep(0.01)
        [spec] = rig.supervisor.specs
        assert json.loads(spec.request_json) == {"wait_go": True} and spec.run_argv == ("python", "/harness/shell.py") and rig.supervisor.case.launched
        group.cancel_scope.cancel()


async def test_the_clis_install_ahead_of_sessions_and_a_session_typing_one_meanwhile_waits_on_that_install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runner = Rig(tmp_path).runner
    del runner._install_cli  # the real install, which this test is about
    gate, built = threading.Event(), []

    def build_now(attempt_id: str, run_limits: Any, archive: Any, profile: Any, work: Path) -> BuildArtifact:
        built.append(attempt_id)
        assert gate.wait(5)
        (work / "harness").mkdir()
        return BuildArtifact(work / "harness", ("install",), "digest", b"", b"", 0.0)

    monkeypatch.setattr(runner, "_build_now", build_now)
    ahead = asyncio.ensure_future(runner._install_clis(fx.LIMITS))
    with anyio.fail_after(5):
        while not built:
            await anyio.sleep(0.01)
    typed = runner._install_cli(fx.free_job(), "nanoagent")
    assert await anext(typed) == {"installing": "NanoAgent", "version": CLIS["nanoagent"].version()}
    gate.set()
    events = [event async for event in typed]
    assert events[-1]["path"].startswith(f"{CLIS_DIR}/") and events[-2]["installed"] == "NanoAgent"
    await ahead
    assert built == ["cli-nanoagent", "cli-claude", "cli-codex", "cli-pi", "cli-hermes", "cli-dsh"]  # each once, NanoAgent's shared with the session
    [found] = [event async for event in runner._install_cli(fx.free_job(), "dsh")]  # typed later: there at once
    assert found["path"] == f"{CLIS_DIR}/{found['key']}/harness"


async def test_the_trace_and_the_verifier_see_the_frozen_workspace_without_session_state(tmp_path: Path) -> None:
    state = {".rush/claude/state.json": b"{}"}
    rig = Rig(tmp_path, script=fx.CaseScript(workspace={"answer.json": fx.ANSWER, **state}, made=state))
    result = await rig.run()
    assert result.outcome == "finalized"
    assert rig.frozen == [False]  # the verifier's workspace has no .rush/
    [event] = rig.rush.of("snapshot.taken")
    assert [entry["path"] for entry in event["diff"]] == ["out.txt"]  # the trace's diff names only what the agent made
    payload = json.loads(rig.rush.payloads[event["payload_sha256"]])
    assert set(payload["files"]) == {"out.txt"} and [entry["path"] for entry in payload["diff"]] == ["out.txt"]


async def test_a_case_gets_the_sandbox_wall_and_its_timeout_is_a_failure(tmp_path: Path) -> None:
    # The wall itself is the sandbox's (sandbox.py `launch` gives the harness exec limits.wall_s).
    rig = Rig(tmp_path, script=fx.CaseScript(termination=Termination(TerminationKind.TIMED_OUT, None, 9)))
    result = await rig.run(fx.parse_job(fx.job_body(limits={"wall_time_ms": 12_000})))
    assert rig.supervisor.specs[0].limits.wall_s == 12.0
    assert result.execution == {"status": "execution_failed", "reason": "timed_out"}
    assert rig.verified == [] and rig.judged == []
    assert rig.rush.of("case.exited")[0]["termination"] == {"status": "timed_out"}


async def test_the_plugin_tools_hosts_are_recorded_when_the_tools_start(tmp_path: Path) -> None:
    rig = Rig(tmp_path, script=fx.CaseScript(block=True))

    async def nanoagent(client: httpx.AsyncClient) -> None:
        assert (await client.post("/tools/start")).status_code == 200

    await _with_harness(rig, nanoagent, fx.parse_job(fx.job_body(tools=[fx.WAIT_TOOL])))
    assert rig.rush.of("tools.started") == [{"egress_hosts": ["api.example.com"]}]
    assert rig.rush.kinds().index("tools.started") > rig.rush.kinds().index("attempt.started")


async def test_a_cases_cli_is_installed_before_its_vm_starts(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    result = await rig.run(fx.parse_job(fx.job_body(harness="mgen")))
    assert result.outcome == "finalized"
    assert rig.installs == [("nanoagent", False)]  # mgen is NanoAgent's CLI; installed with no case VM made yet, so not on the case's clock


async def test_a_cases_cli_that_fails_to_install_is_a_worker_error_not_a_failed_case(tmp_path: Path) -> None:
    rig = Rig(tmp_path)

    async def broken(job: Any, name: str) -> Any:
        yield {"installing": "Claude Code", "version": "1"}
        yield {"error": "installing Claude Code 1 failed: download_failed: the registry went away"}

    rig.runner._install_cli = broken  # type: ignore[method-assign]
    result = await rig.run()
    assert result.outcome == "worker_error" and "download_failed" in result.execution["error"]
    assert not rig.supervisor.specs and rig.verified == []  # no VM was made and nothing was scored
