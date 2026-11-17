"""The sandbox supervisor against a fake docker: argument construction, termination mapping, fail-closed paths."""

from __future__ import annotations

import io
import json
import subprocess
import sys
import tarfile
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest

from nanoagent.uploaded.archive import tar_of_tree
from nanoagent.uploaded.collector import CollectorHealth, ProcessEvent, ProcessEventKind, ProcessEvidence
from nanoagent.uploaded.contract import ContractError, HarnessManifest
from nanoagent.uploaded.dockercli import DockerResult
from nanoagent.uploaded.sandbox import (
    CWD_CHECK,
    CWD_CHECK_TIMEOUT_S,
    CWD_LINK,
    CWD_MISSING,
    BuildSpec,
    CaseSpec,
    DockerSandboxSupervisor,
    Limits,
    SandboxError,
    Termination,
    TerminationKind,
    map_termination,
)
from nanoagent.uploaded.toolchains import DependencyClosure, toolchain

CID = "a" * 64
PROBE_ID = "b" * 64
PROFILE = toolchain("python-3")


def ok(stdout: bytes | str = b"", **kw) -> DockerResult:
    return DockerResult(0, stdout.encode() if isinstance(stdout, str) else stdout, b"", **kw)


def state(**fields) -> DockerResult:
    base = {"Running": False, "Paused": False, "OOMKilled": False, "ExitCode": 0, "Error": "", "StartedAt": "2026-01-01T00:00:00Z"}
    return ok(json.dumps({**base, **fields}))


def tar(entries: dict[str, bytes | None], links: dict[str, str] | None = None, root: str = "workspace") -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        d = tarfile.TarInfo(root)
        d.type = tarfile.DIRTYPE
        archive.addfile(d)
        for name, data in entries.items():
            info = tarfile.TarInfo(f"{root}/{name}")
            if data is None:
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            else:
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        for name, target in (links or {}).items():
            info = tarfile.TarInfo(f"{root}/{name}")
            info.type = tarfile.SYMTYPE
            info.linkname = target
            archive.addfile(info)
    return buffer.getvalue()


class FakeDocker:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.stdin: dict[int, bytes] = {}
        self.overrides: dict[str, Callable[[Sequence[str]], DockerResult]] = {}

    def run(self, args, *, timeout_s=None, stdin=None, capture_bytes=1 << 20):
        args = list(args)
        self.calls.append(args)
        self.timeouts = getattr(self, "timeouts", []) + [(args[0], timeout_s)]
        if stdin is not None:
            self.stdin[len(self.calls) - 1] = stdin
        key = {"cp": f"cp:{args[1]}", "start": "start-a" if "-a" in args else "start"}.get(args[0], args[0])
        for k in (key, args[0]):
            if k in self.overrides:
                return self.overrides[k](args)
        return {"create": lambda: ok(CID), "inspect": lambda: state(), "image": lambda: ok(), "start": lambda: ok("out"), "volume": lambda: ok(), "network": lambda: ok(), "rm": lambda: ok(), "kill": lambda: ok(), "pause": lambda: ok(), "unpause": lambda: ok(), "cp": lambda: ok(tar({})), "exec": lambda: ok("done")}.get(args[0], lambda: ok())()

    def find(self, subcommand: str) -> list[list[str]]:
        return [c for c in self.calls if c[0] == subcommand]


class FakeCollector:
    def __init__(self, listening: bool = True, evidence: ProcessEvidence | None = None) -> None:
        self.listening = listening
        self._evidence = evidence
        self.sessions: list[str] = []
        self.discarded: list[str] = []

    def health(self):
        return CollectorHealth(self.listening, 0, 0, 0, 0)

    def session(self, container_id):
        self.sessions.append(container_id)

    def snapshot(self, container_id):
        return self._evidence or probe_evidence(container_id)

    def finish(self, container_id, *, timeout_s=10.0):
        return self._evidence or probe_evidence(container_id)

    def discard(self, container_id):
        self.discarded.append(container_id)


def event(kind, tgid=1, start=10, tid=None, **kw) -> ProcessEvent:
    return ProcessEvent(0, kind, 1, CID, tgid, start, tgid if tid is None else tid, start, 0, "p", "/", False, **kw)


def probe_evidence(container_id=PROBE_ID, *, complete=True, exited=True) -> ProcessEvidence:
    events = [event(ProcessEventKind.CONTAINER_START, argv=("/bin/true",))]
    if exited:
        events.append(event(ProcessEventKind.TASK_EXIT, exit_status=0, exit_code=0))
    return ProcessEvidence(container_id, tuple(events), complete, () if complete else ("dropped",), 2, 0, 0, 0, 1, 0)


@pytest.fixture(autouse=True)
def no_evidence_wait(monkeypatch):
    monkeypatch.setattr("nanoagent.uploaded.sandbox.EXEC_EVIDENCE_WAIT_S", 0.0)


@pytest.fixture
def docker():
    return FakeDocker()


@pytest.fixture
def collector():
    return FakeCollector()


@pytest.fixture
def supervisor(docker, collector):
    s = DockerSandboxSupervisor(docker, collector=collector, clock=iter(range(1000)).__next__, wall_clock_ns=lambda: 7)
    s.startup(PROFILE)
    docker.calls.clear()
    collector.discarded.clear()
    collector.sessions.clear()
    return s


@pytest.mark.parametrize(
    ("code", "oom", "timed_out", "expected"),
    [
        (0, False, False, Termination(TerminationKind.EXITED, 0, None)),
        (3, False, False, Termination(TerminationKind.NONZERO_EXIT, 3, None)),
        (137, False, False, Termination(TerminationKind.NONZERO_EXIT, 137, None)),
        (139, False, False, Termination(TerminationKind.NONZERO_EXIT, 139, None)),
        (128, False, False, Termination(TerminationKind.NONZERO_EXIT, 128, None)),
        (255, False, False, Termination(TerminationKind.NONZERO_EXIT, 255, None)),
        (137, True, False, Termination(TerminationKind.SIGNALED, None, 9, oom_killed=True)),
        (137, False, True, Termination(TerminationKind.TIMED_OUT, None, 9)),
    ],
)
def test_exit_status_maps_to_clean_nonzero_oom_or_timeout_and_never_infers_a_signal(code, oom, timed_out, expected):
    assert map_termination(code, oom_killed=oom, timed_out=timed_out) == expected


def test_member_source_is_refused_until_the_collector_self_test_passes(docker, collector, tmp_path):
    s = DockerSandboxSupervisor(docker, collector=collector)
    with pytest.raises(SandboxError) as caught:
        s.start_case(case_spec(s, tmp_path))
    assert caught.value.code == "collector_unverified"


def test_self_test_requires_a_listening_collector(docker):
    with pytest.raises(SandboxError) as caught:
        DockerSandboxSupervisor(docker, collector=FakeCollector(listening=False)).startup(PROFILE)
    assert caught.value.code == "collector_unhealthy"


@pytest.mark.parametrize("evidence", [probe_evidence(complete=False), probe_evidence(exited=False)])
def test_self_test_fails_when_exec_and_exit_are_not_both_observed_completely(docker, evidence):
    s = DockerSandboxSupervisor(docker, collector=FakeCollector(evidence=evidence))
    with pytest.raises(SandboxError) as caught:
        s.startup(PROFILE)
    assert caught.value.code == "collector_self_test_failed"
    assert docker.find("rm"), "the probe container is removed even on failure"


def test_self_test_runs_the_probe_under_the_rush_runtime_without_network(docker, collector):
    DockerSandboxSupervisor(docker, collector=collector).startup(PROFILE)
    create = docker.find("create")[-1]
    assert "--runtime=runsc-rush" in create and "--network=none" in create and create[-1] == PROFILE.runtime_image


def case_spec(s, tmp_path, **kw) -> CaseSpec:
    artifact_dir = tmp_path / "harness"
    artifact_dir.mkdir(exist_ok=True)
    from nanoagent.uploaded.sandbox import AttemptNetwork, BuildArtifact

    artifact = BuildArtifact(artifact_dir, ("main.py",), "d", b"", b"", 0.0)
    return CaseSpec(
        attempt_id=kw.pop("attempt_id", "att1"),
        profile=PROFILE,
        run_argv=("python", "/harness/main.py"),
        artifact=artifact,
        request_json=b'{"x":1}',
        attempt_token="tok-SECRET",
        network=AttemptNetwork(s._docker, "rush-net-att1"),
        workdir=tmp_path / "work",
        **kw,
    )


def test_case_container_is_unprivileged_read_only_bounded_and_attached_only_to_the_attempt_network(supervisor, docker, tmp_path):
    limits = Limits(cpus=2, memory_bytes=512 << 20, pids=64, workspace_bytes=1 << 20, wall_s=30)
    handle = supervisor.start_case(case_spec(supervisor, tmp_path, limits=limits))
    handle.wait()
    create = docker.find("create")[-1]
    joined = " ".join(create)
    for expected in (
        "--runtime=runsc-rush", "--network=rush-net-att1", "--user=10001:10001", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--cpus=2", f"--memory={512 << 20}", f"--memory-swap={512 << 20}", "--pids-limit=64",
        "--workdir /rush/workspace", "--entrypoint python",
        f"type=bind,src={tmp_path / 'harness'},dst=/harness,readonly",
        f"type=bind,src={tmp_path / 'work' / 'request.json'},dst=/rush/request.json,readonly",
        "dst=/rush/out", "dst=/rush/workspace",
    ):
        assert expected in joined, expected
    assert create[-2:] == [PROFILE.runtime_image, "/harness/main.py"], "argv is exactly run.argv, nothing appended"
    assert "tok-SECRET" not in joined, "the attempt token must not appear on the docker command line"
    volume = docker.find("volume")[0]
    assert "o=size=1048576,uid=10001,gid=10001,mode=0755" in volume


def test_case_environment_is_exactly_the_documented_variables_plus_platform_values(supervisor, docker, tmp_path, monkeypatch):
    seen: dict[str, str] = {}

    def capture_create(args):
        if "--env-file" in args:
            path = Path(args[args.index("--env-file") + 1])
            seen.update(line.split("=", 1) for line in path.read_text().splitlines())
        return ok(CID)

    docker.overrides["create"] = capture_create
    supervisor.start_case(case_spec(supervisor, tmp_path)).wait()
    assert {k for k in seen if k.startswith("RUSH_")} == {"RUSH_REQUEST", "RUSH_RESULT", "RUSH_WORKSPACE", "RUSH_ATTEMPT_TOKEN"}
    assert seen["RUSH_REQUEST"] == "/rush/request.json" and seen["RUSH_RESULT"] == "/rush/out/result.json"
    assert seen["RUSH_WORKSPACE"] == "/rush/workspace" and seen["RUSH_ATTEMPT_TOKEN"] == "tok-SECRET"
    assert not list((tmp_path / "work").glob("env-*")), "the env file is deleted after create"


def test_collector_session_is_opened_before_the_container_starts(supervisor, docker, collector, tmp_path):
    order: list[str] = []
    docker.overrides["start-a"] = lambda a: (order.append("start"), ok())[1]
    original = collector.session
    collector.session = lambda c: (order.append("session"), original(c))[1]
    supervisor.start_case(case_spec(supervisor, tmp_path)).wait()
    assert order == ["session", "start"]


def test_a_sandbox_the_runtime_refuses_to_start_is_a_start_failure_and_is_cleaned_up(supervisor, docker, collector, tmp_path):
    docker.overrides["start-a"] = lambda a: DockerResult(125, b"", b"cannot init config: connect(seccheck.sock)")
    docker.overrides["inspect"] = lambda a: state(Status="created", StartedAt="0001-01-01T00:00:00Z", Error="connect(seccheck.sock)", ExitCode=127)
    with pytest.raises(SandboxError) as caught:
        supervisor.start_case(case_spec(supervisor, tmp_path))
    assert caught.value.code == "start_failed" and "seccheck.sock" in caught.value.message
    assert docker.find("rm") and len(docker.find("volume")) >= 4 and collector.discarded == [CID]


def root_evidence(wait_status: int | None) -> ProcessEvidence:
    """Evidence whose init process exited with this wait(2) status; None leaves the root exit unobserved."""
    events = [event(ProcessEventKind.CONTAINER_START, argv=("python", "/harness/main.py"))]
    if wait_status is not None:
        signal = wait_status & 0x7F or None
        events.append(event(ProcessEventKind.TASK_EXIT, exit_status=wait_status, exit_code=None if signal else wait_status >> 8, exit_signal=signal))
    return ProcessEvidence(CID, tuple(events), True, (), 2, 0, 0, 0, 1, 0)


@pytest.mark.parametrize(
    ("docker_code", "wait_status", "timed_out", "kind", "exit_code", "signal"),
    [
        (0, 0, False, TerminationKind.EXITED, 0, None),
        (2, 2 << 8, False, TerminationKind.NONZERO_EXIT, 2, None),
        (143, 15, False, TerminationKind.SIGNALED, None, 15),
        (137, 9, False, TerminationKind.SIGNALED, None, 9),
        (137, 137 << 8, False, TerminationKind.NONZERO_EXIT, 137, None),  # `exit 137` is not SIGKILL
        (137, 9, True, TerminationKind.TIMED_OUT, None, 9),
    ],
)
def test_wait_takes_exit_versus_signal_from_the_root_task_exit_evidence(
    supervisor, docker, collector, tmp_path, docker_code, wait_status, timed_out, kind, exit_code, signal
):
    collector._evidence = root_evidence(wait_status)
    docker.overrides["start-a"] = lambda a: DockerResult(docker_code, b"o", b"e", timed_out=timed_out)
    docker.overrides["inspect"] = lambda a: state(ExitCode=docker_code)
    handle = supervisor.start_case(case_spec(supervisor, tmp_path, limits=Limits(wall_s=5)))
    outcome = handle.wait()
    assert (outcome.termination.kind, outcome.termination.exit_code, outcome.termination.signal) == (kind, exit_code, signal)
    assert (outcome.stdout, outcome.stderr) == (b"o", b"e")
    assert bool(docker.find("kill")) == timed_out
    assert ("start", 5) in docker.timeouts
    assert handle.evidence().complete


def test_a_missing_root_exit_reports_exited_with_the_raw_code_and_marks_evidence_incomplete(supervisor, docker, collector, tmp_path):
    collector._evidence = root_evidence(None)
    docker.overrides["start-a"] = lambda a: DockerResult(137, b"", b"")
    docker.overrides["inspect"] = lambda a: state(ExitCode=137)
    handle = supervisor.start_case(case_spec(supervisor, tmp_path))
    termination = handle.wait().termination
    assert (termination.kind, termination.exit_code, termination.signal) == (TerminationKind.EXITED, 137, None)
    evidence = handle.evidence()
    assert not evidence.complete and "root_exit_missing" in evidence.loss_reasons


def test_launch_and_exit_use_the_injected_monotonic_clock(supervisor, tmp_path):
    outcome = supervisor.start_case(case_spec(supervisor, tmp_path)).wait()
    assert outcome.exited_at > outcome.launched_at and isinstance(outcome.launched_at, int | float)


def test_attempt_network_is_internal_and_has_no_host_gateway(supervisor, docker):
    network = supervisor.create_network("att9")
    create = docker.find("network")[0]
    assert create[:4] == ["network", "create", "--internal", "--driver"]
    assert "com.docker.network.bridge.gateway_mode_ipv4=isolated" in create and create[-1] == "rush-net-att9"
    network.connect("gateway-1", aliases=["gateway"])
    assert docker.find("network")[1] == ["network", "connect", "--alias", "gateway", "rush-net-att9", "gateway-1"]


def test_service_address_comes_from_the_networks_own_inspect_output(supervisor, docker):
    docker.overrides["inspect"] = lambda a: ok("172.20.0.2\n")
    assert supervisor.create_network("att9").address_of("gateway-1") == "172.20.0.2"
    assert 'rush-net-att9' in docker.find("inspect")[-1][2]
    docker.overrides["inspect"] = lambda a: ok("\n")
    with pytest.raises(SandboxError) as caught:
        supervisor.create_network("att9").address_of("gateway-1")
    assert caught.value.code == "network_failed"


def test_fixtures_are_preloaded_and_the_snapshot_diff_reports_added_modified_deleted(supervisor, docker, tmp_path):
    fixtures = tmp_path / "fixtures"
    fixtures.mkdir()
    (fixtures / "keep.txt").write_text("same")
    (fixtures / "edit.txt").write_text("before")
    (fixtures / "gone.txt").write_text("bye")
    handle = supervisor.start_case(case_spec(supervisor, tmp_path, fixtures=fixtures))
    assert any("cp" == c[0] and c[1] == "-" for c in docker.calls)
    docker.overrides["inspect"] = lambda a: state(Running=True)
    docker.overrides["cp:" + CID + ":/hold/workspace"] = lambda a: ok(
        tar({"keep.txt": b"same", "edit.txt": b"after", "new.txt": b"n"}, links={"lnk": "/etc/passwd"})
    )
    snapshot = handle.stop_and_drain()
    assert docker.find("pause"), "every writer is frozen before the snapshot"
    assert (snapshot.added, snapshot.modified, snapshot.deleted) == (("new.txt",), ("edit.txt",), ("gone.txt",))
    assert snapshot.skipped == {"lnk": "symlink"} and not (snapshot.directory / "lnk").exists()
    assert (snapshot.directory / "new.txt").read_bytes() == b"n"


def test_snapshot_beyond_the_bound_is_rejected(supervisor, docker, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path, limits=Limits(workspace_bytes=4)))
    docker.overrides["cp:" + CID + ":/hold/workspace"] = lambda a: ok(tar({"big": b"x" * 100}))
    with pytest.raises(ContractError) as caught:
        handle.stop_and_drain()
    assert caught.value.code == "snapshot_too_large"


def test_read_result_returns_only_result_json_and_ignores_other_files(supervisor, docker, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path))
    docker.overrides["cp:" + CID + ":/hold/out"] = lambda a: ok(tar({"result.json": b'{"ok":1}', "other": b"x"}, root="out"))
    assert handle.read_result() == b'{"ok":1}'


def test_read_result_without_result_json_is_missing_result(supervisor, docker, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path))
    docker.overrides["cp:" + CID + ":/hold/out"] = lambda a: ok(tar({"other": b"x"}, links={"result.json": "/etc/passwd"}, root="out"))
    with pytest.raises(ContractError) as caught:
        handle.read_result()
    assert caught.value.code == "missing_result"


def test_managed_exec_runs_in_the_case_sandbox_with_its_identity_and_bounded_timeout(supervisor, docker, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path, limits=Limits(wall_s=10)))
    outcome = handle.exec_in_case(["echo", "hi"], ".", 60_000, Limits(output_bytes=10))
    call = docker.find("exec")[0]
    assert call[:8] == ["exec", "--user=10001:10001", "--workdir", "/rush/workspace", "-e", "PYTHONUNBUFFERED=", CID, "timeout"]
    assert call[8:10] == ["--kill-after=2", "--signal=TERM"] and float(call[10]) <= 10
    assert call[11:] == ["/usr/bin/env", "-u", f"RUSH_LAUNCH_{outcome.launch_id}", "echo", "hi"]
    assert outcome.absolute_cwd == "/rush/workspace" and outcome.stdout == b"done" and outcome.argv == ("echo", "hi") and len(outcome.launch_id) == 32
    assert outcome.launched_wall_ns == outcome.returned_wall_ns == 7


def test_managed_exec_timeout_needs_timeouts_exit_code_and_an_elapsed_deadline(docker, collector, tmp_path):
    now = [0.0]
    s = DockerSandboxSupervisor(docker, collector=collector, clock=lambda: now[0], wall_clock_ns=lambda: 7)
    s.startup(PROFILE)
    handle = s.start_case(case_spec(s, tmp_path, limits=Limits(wall_s=100)))

    def timed_out_exec(args):
        now[0] += 5  # far past the 0.1s timeout
        return DockerResult(124, b"partial", b"", stdout_truncated=True)

    docker.overrides["exec"] = timed_out_exec
    # the deadline elapsed on the worker clock, so timeout's 124 means timed out
    elapsed = handle.exec_in_case(["sleep", "9"], ".", 100, Limits())
    assert elapsed.termination.kind is TerminationKind.TIMED_OUT and elapsed.stdout_truncated and elapsed.argv == ("sleep", "9")


def test_a_command_that_itself_exits_124_before_the_deadline_is_not_a_timeout(supervisor, docker, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path, limits=Limits(wall_s=100)))
    docker.overrides["exec"] = lambda a: DockerResult(124, b"", b"")
    outcome = handle.exec_in_case(["sh", "-c", "exit 124"], ".", 60_000, Limits())
    assert (outcome.termination.kind, outcome.termination.exit_code) == (TerminationKind.NONZERO_EXIT, 124)


def member_evidence(launch_id, *, exit_status):
    """An exec-session root (`timeout`), its child's marker exec and member exec, and the child's task exit."""

    def at(kind, tgid, start, tid=None, **kw):
        return ProcessEvent(0, kind, 1, CID, tgid, start, tgid if tid is None else tid, start, 0, "p", "/rush/workspace", True, **kw)

    clone = at(ProcessEventKind.CLONE, 20, 2000, created_thread_group_id=21, created_thread_group_start_time_ns=2100)
    marker = at(ProcessEventKind.EXEC, 21, 2100, argv=("/usr/bin/env", "-u", f"RUSH_LAUNCH_{launch_id}", "sh"))
    member = at(ProcessEventKind.EXEC, 21, 2100, argv=("sh",))
    exit_ = at(ProcessEventKind.TASK_EXIT, 21, 2100, exit_status=exit_status, exit_code=exit_status >> 8 if not exit_status & 0x7F else None, exit_signal=exit_status & 0x7F or None)
    return ProcessEvidence(CID, (clone, marker, member, exit_), True, (), 4, 0, 0, 0, 1, 0)


def exec_with_evidence(docker, collector, supervisor, tmp_path, *, returncode, exit_status):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path, limits=Limits(wall_s=100)))
    docker.overrides["exec"] = lambda a: DockerResult(returncode, b"", b"")

    def snapshot(container_id):
        call = docker.find("exec")[-1]
        marker = call[call.index("-u") + 1]  # the launch ID is made inside exec_in_case
        return member_evidence(marker.removeprefix("RUSH_LAUNCH_"), exit_status=exit_status)

    collector.snapshot = snapshot
    return handle.exec_in_case(["sh", "-c", "kill -9 $$"], ".", 60_000, Limits())


def test_a_managed_command_killed_by_a_signal_is_signaled_from_the_joined_evidence(supervisor, docker, collector, tmp_path):
    outcome = exec_with_evidence(docker, collector, supervisor, tmp_path, returncode=137, exit_status=9)
    assert (outcome.termination.kind, outcome.termination.exit_code, outcome.termination.signal) == (TerminationKind.SIGNALED, None, 9)


def test_a_managed_command_exiting_with_a_signals_code_is_a_plain_exit_by_the_evidence(supervisor, docker, collector, tmp_path):
    outcome = exec_with_evidence(docker, collector, supervisor, tmp_path, returncode=137, exit_status=137 << 8)
    assert (outcome.termination.kind, outcome.termination.exit_code, outcome.termination.signal) == (TerminationKind.NONZERO_EXIT, 137, None)


def test_a_nonzero_managed_command_without_exit_evidence_keeps_its_raw_code(supervisor, docker, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path, limits=Limits(wall_s=100)))
    docker.overrides["exec"] = lambda a: DockerResult(137, b"", b"")
    outcome = handle.exec_in_case(["sh"], ".", 60_000, Limits())
    assert (outcome.termination.kind, outcome.termination.exit_code) == (TerminationKind.NONZERO_EXIT, 137)


@pytest.mark.parametrize("cwd", ["../etc", "/abs", "a/../../b", "a\\b"])
def test_managed_exec_rejects_cwd_that_leaves_the_workspace(supervisor, tmp_path, cwd):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path))
    with pytest.raises(ContractError) as caught:
        handle.exec_in_case(["ls"], cwd, 1000, Limits())
    assert caught.value.code == "invalid_cwd"


def test_managed_exec_checks_a_deep_cwd_with_one_bounded_call(supervisor, docker, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path))
    deep = "/".join(["d"] * 500)
    handle.exec_in_case(["ls"], deep, 1000, Limits())
    assert docker.find("cp") == [] and len([c for c in docker.find("exec") if "-c" in c]) == 1
    assert ("exec", CWD_CHECK_TIMEOUT_S) in docker.timeouts


def test_managed_exec_rejects_cwd_through_a_symlink_and_a_missing_dir(supervisor, docker, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path))
    docker.overrides["exec"] = lambda a: DockerResult(CWD_LINK, b"", b"") if "-c" in a else ok("done")
    with pytest.raises(ContractError) as caught:
        handle.exec_in_case(["ls"], "a/b", 1000, Limits())
    assert "link" in caught.value.message
    docker.overrides["exec"] = lambda a: DockerResult(CWD_MISSING, b"", b"") if "-c" in a else ok("done")
    with pytest.raises(ContractError) as caught:
        handle.exec_in_case(["ls"], "nope", 1000, Limits())
    assert "does not exist" in caught.value.message
    docker.overrides["exec"] = lambda a: DockerResult(1, b"", b"no such container") if "-c" in a else ok("done")
    with pytest.raises(SandboxError) as caught:
        handle.exec_in_case(["ls"], "a", 1000, Limits())
    assert caught.value.code == "exec_failed"


def test_the_cwd_check_script_finds_links_and_missing_components(tmp_path):
    (tmp_path / "real" / "sub").mkdir(parents=True)
    (tmp_path / "lnk").symlink_to(tmp_path / "real")

    def check(cwd: str) -> int:
        return subprocess.run([sys.executable, "-c", CWD_CHECK, str(tmp_path), cwd]).returncode

    assert (check("real/sub"), check("real/nope"), check("lnk/sub")) == (0, CWD_MISSING, CWD_LINK)


def test_wait_woken_by_close_is_closed_not_an_inspect_failure(supervisor, docker, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path))
    handle._closing.set()  # close() has begun: the rm -f may win the race with wait()'s inspect
    docker.overrides["inspect"] = lambda a: DockerResult(1, b"", b"no such container")
    with pytest.raises(SandboxError) as caught:
        handle.wait()
    assert caught.value.code == "closed"
    handle._closing.clear()
    with pytest.raises(SandboxError) as caught:
        handle.wait()
    assert caught.value.code == "inspect_failed"


def test_managed_exec_rejects_nul_in_argv(supervisor, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path))
    with pytest.raises(ContractError):
        handle.exec_in_case(["echo", "a\0b"], ".", 1000, Limits())


def test_close_unfreezes_kills_and_removes_everything(supervisor, docker, collector, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path))
    docker.overrides["inspect"] = lambda a: state(Running=True)
    handle.stop_and_drain()
    docker.calls.clear()
    handle.close()
    assert [c[0] for c in docker.calls][:2] == ["unpause", "kill"]
    assert docker.find("rm") and len(docker.find("volume")) == 2 and collector.discarded == [CID]


def build_spec(s, tmp_path, outputs=("main.py",), argv=("cp", "main.py", "/build-out/main.py")) -> BuildSpec:
    source = tmp_path / "source"
    source.mkdir(exist_ok=True)
    (source / "main.py").write_text("print(1)")
    deps = tmp_path / "deps"
    deps.mkdir(exist_ok=True)
    manifest = HarnessManifest("h", "1", ("chat_completions",), "python-3", (), argv, outputs, ("python", "/harness/main.py"))
    return BuildSpec("att1", PROFILE, manifest, source, DependencyClosure(deps, {}), tmp_path / "bw")


def test_build_runs_offline_with_read_only_inputs_and_accepts_only_declared_outputs(supervisor, docker, tmp_path):
    docker.overrides["cp:" + CID + ":/hold/build-out"] = lambda a: ok(tar({"main.py": b"print(1)", "junk": b"x"}, root="build-out"))
    artifact = supervisor.build(build_spec(supervisor, tmp_path))
    create = docker.find("create")[-1]
    joined = " ".join(create)
    for expected in ("--network=none", "--read-only", "--user=10001:10001", "--workdir /src", "dst=/src,readonly", "dst=/deps,readonly", "dst=/build-out"):
        assert expected in joined, expected
    assert (artifact.directory / "main.py").read_bytes() == b"print(1)" and not (artifact.directory / "junk").exists()
    assert create[-3:] == [PROFILE.build_image, "main.py", "/build-out/main.py"]
    assert artifact.outputs == ("main.py",) and len(artifact.digest) == 64


def test_build_output_that_is_missing_or_contains_a_link_is_rejected(supervisor, docker, tmp_path):
    docker.overrides["cp:" + CID + ":/hold/build-out"] = lambda a: ok(tar({"other": b"x"}, root="build-out"))
    with pytest.raises(SandboxError) as caught:
        supervisor.build(build_spec(supervisor, tmp_path))
    assert caught.value.code == "output_invalid" and "was not produced" in caught.value.message
    docker.overrides["cp:" + CID + ":/hold/build-out"] = lambda a: ok(tar({"lib": None, "lib/a": b"x"}, links={"lib/evil": "/etc/passwd"}, root="build-out"))
    with pytest.raises(SandboxError) as caught:
        supervisor.build(build_spec(supervisor, tmp_path, outputs=("lib",)))
    assert caught.value.code == "output_invalid" and "link" in caught.value.message


@pytest.mark.parametrize("output", ["../escape", "/abs", "a/../b", ""])
def test_build_rejects_declared_outputs_that_are_not_canonical_relative_paths(supervisor, tmp_path, output):
    with pytest.raises(SandboxError) as caught:
        supervisor.build(build_spec(supervisor, tmp_path, outputs=(output,)))
    assert caught.value.code == "output_invalid"


def test_build_failure_and_timeout_are_specific_and_clean_up(supervisor, docker, tmp_path):
    docker.overrides["inspect"] = lambda a: state(ExitCode=2)
    docker.overrides["start-a"] = lambda a: DockerResult(2, b"", b"boom")
    with pytest.raises(SandboxError) as caught:
        supervisor.build(build_spec(supervisor, tmp_path))
    assert caught.value.code == "build_failed" and "boom" in caught.value.message and docker.find("rm")
    docker.overrides["start-a"] = lambda a: DockerResult(-9, b"", b"", timed_out=True)
    with pytest.raises(SandboxError) as caught:
        supervisor.build(build_spec(supervisor, tmp_path))
    assert caught.value.code == "build_timeout" and docker.find("kill")


def test_build_refuses_source_containing_a_link(supervisor, tmp_path):
    spec = build_spec(supervisor, tmp_path)
    (spec.source_root / "evil").symlink_to("/etc/passwd")
    with pytest.raises(SandboxError) as caught:
        supervisor.build(spec)
    assert caught.value.code == "output_invalid" and "link" in caught.value.message


def test_tar_of_tree_widens_modes_for_the_unprivileged_user_and_refuses_links(tmp_path):
    (tmp_path / "f").write_text("x")
    (tmp_path / "d").mkdir()
    with tarfile.open(fileobj=io.BytesIO(tar_of_tree(tmp_path))) as archive:
        modes = {m.name: m.mode for m in archive}
    assert modes == {"f": 0o666, "d": 0o777}
    (tmp_path / "l").symlink_to("f")
    with pytest.raises(ContractError):
        tar_of_tree(tmp_path)


# ---- tool container, plugin preparation and CPU counters -----------------------------------------------------------------


def tool_spec(tmp_path, **kw):
    from nanoagent.uploaded.sandbox import ToolContainerSpec

    (tmp_path / "plugin").mkdir(exist_ok=True)
    return ToolContainerSpec("rush-tool-x", tmp_path / "plugin", **kw)


def tooled(docker, collector, tmp_path, **kw):
    uv = tmp_path / "uv"
    uv.write_text("")
    s = DockerSandboxSupervisor(docker, collector=collector, uv=uv, **kw)
    s.startup(PROFILE)
    return s, uv


def test_tool_container_has_no_network_the_workspace_volume_and_read_only_plugin_and_fixtures(docker, collector, tmp_path):
    s, uv = tooled(docker, collector, tmp_path)
    fixtures = tmp_path / "fx"
    fixtures.mkdir()
    s.create_case(case_spec(s, tmp_path, tool=tool_spec(tmp_path, fixtures=fixtures)))
    harness, tool = docker.find("create")[-2:]
    joined = " ".join(tool)
    for expected in (
        "--name=rush-tool-x", "--runtime=runsc-rush", "--network=none", "--user=10001:10001", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--cpus=1.0", "--pids-limit=256", "--workdir /plugin", "--entrypoint sleep",
        f"type=bind,src={tmp_path / 'plugin'},dst=/plugin,readonly", f"type=bind,src={uv},dst=/usr/local/bin/uv,readonly",
        f"type=bind,src={fixtures},dst=/fixtures,readonly",
    ):
        assert expected in joined, expected
    assert "dst=/rush/workspace,volume-nocopy" in joined and "src=rush-ws-" in joined
    for private in ("request.json", "/rush/out", "/harness", "tok-SECRET", "--env"):
        assert private not in joined, private
    # The tool container mounts the very volume the harness does.
    volume = next(a for a in harness if "dst=/rush/workspace" in a)
    assert next(a for a in tool if "dst=/rush/workspace" in a) == volume
    assert collector.sessions[-1] == CID and any(c[0] == "start" and c[-1] == CID for c in docker.calls)


def test_tools_need_the_uv_binary(supervisor, tmp_path):
    with pytest.raises(SandboxError) as caught:
        supervisor.create_case(case_spec(supervisor, tmp_path, tool=tool_spec(tmp_path)))
    assert caught.value.code == "tool_unavailable"


def test_launcher_execs_the_plugin_as_the_unprivileged_user_with_only_the_given_environment(docker, collector, tmp_path):
    from nanoagent.plugin.manifest import load_manifest

    manifest = load_manifest(Path(__file__).resolve().parents[1] / "plugins" / "acceptance-probe")
    s, _ = tooled(docker, collector, tmp_path)
    s.create_case(case_spec(s, tmp_path, tool=tool_spec(tmp_path, fixtures=tmp_path)))
    with s.tool_launcher("rush-tool-x").launch(manifest, {"NANOAGENT_WORKSPACE": "/rush/workspace"}) as (argv, env):
        pass
    assert argv[:6] == ["docker", "exec", "-i", "--user=10001:10001", "--workdir", "/plugin"]
    assert argv[-7:] == ["rush-tool-x", "uv", "run", "--frozen", "python", "-m", "plugin"]
    given = dict(a.split("=", 1) for a in argv if "=" in a and not a.startswith("--"))
    assert given == {
        "NANOAGENT_WORKSPACE": "/rush/workspace", "HOME": "/tmp", "UV_CACHE_DIR": "/tmp/uv-cache", "UV_NO_SYNC": "1", "UV_OFFLINE": "1",
        "NANOAGENT_FIXTURES": "/fixtures",
    }
    with pytest.raises(SandboxError, match="tool container nope"):
        with s.tool_launcher("nope").launch(manifest, {}):
            pass


def test_stop_and_drain_kills_the_tool_container_before_the_snapshot_and_close_removes_it(docker, collector, tmp_path):
    s, _ = tooled(docker, collector, tmp_path)
    handle = s.create_case(case_spec(s, tmp_path, tool=tool_spec(tmp_path)))
    docker.overrides["inspect"] = lambda a: state(Running=True)
    handle.launch()
    handle.stop_and_drain()
    verbs = [c[0] for c in docker.calls]
    assert verbs.index("kill") < verbs.index("pause") < len(verbs) - verbs[::-1].index("cp") - 1
    handle.close()
    assert len([c for c in docker.find("rm") if CID in c]) >= 2 and "rush-tool-x" not in s._tool_cases


def test_prepare_plugin_syncs_inside_the_pinned_prep_image_in_gvisor(docker, collector, tmp_path):
    from nanoagent.uploaded.sandbox import PLUGIN_PREP_IMAGE

    s, uv = tooled(docker, collector, tmp_path)
    docker.overrides["logs"] = lambda a: ok("ready")
    docker.overrides["inspect"] = lambda a: ok("10.1.2.3")
    s.prepare_plugin(tmp_path / "plugin", 60)
    run = docker.find("run")[0]
    joined = " ".join(run)
    assert PLUGIN_PREP_IMAGE.startswith("python@sha256:") and PLUGIN_PREP_IMAGE in run
    for expected in ("--runtime=runsc-rush", "--cap-drop=ALL", f"type=bind,src={tmp_path / 'plugin'},dst=/plugin ", "--entrypoint uv"):
        assert expected in joined + " ", expected
    assert run[-6:] == ["sync", "--frozen", "--no-dev", "--python", "/usr/local/bin/python", "--quiet"]
    # Egress: a private internal network whose only member besides the sandbox is the relay to the host's allowlisting proxy.
    [network] = [c for c in docker.find("network") if c[1] == "create"]
    assert "--internal" in network and f"--network={network[-1]}" in run and "--network=bridge" not in run
    assert "HTTPS_PROXY=http://10.1.2.3:3128" in run and "https_proxy=http://10.1.2.3:3128" in run
    relay = next(c for c in docker.find("create") if any(a.startswith("--name=rush-prep-relay-") for a in c))
    assert f"--network={network[-1]}" in relay and "--runtime=runc" in relay and "dst=/sock,readonly" in " ".join(relay)
    assert [c[:3] for c in docker.find("network") if c[1] == "rm"] == [["network", "rm", network[-1]]]
    assert any(CID in c for c in docker.find("rm")), "the relay is removed"
    docker.overrides["run"] = lambda a: DockerResult(1, b"", b"git failed")
    with pytest.raises(SandboxError, match="git failed"):
        s.prepare_plugin(tmp_path / "plugin", 60)


TOOL_ID = "t" * 64


def distinct_ids(docker):
    docker.overrides["create"] = lambda a: ok(TOOL_ID if "--name=rush-tool-x" in a else CID)


def fake_cgroups(tmp_path, pid, user_usec, system_usec):
    proc, cg = tmp_path / "proc", tmp_path / "cgroup"
    (proc / str(pid)).mkdir(parents=True, exist_ok=True)
    (proc / str(pid) / "cgroup").write_text("0::/system.slice/docker-x.scope\n")
    directory = cg / "system.slice" / "docker-x.scope"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "cpu.stat").write_text(f"usage_usec {user_usec + system_usec}\nuser_usec {user_usec}\nsystem_usec {system_usec}\n")
    return proc, cg


def test_cpu_counters_come_from_each_containers_cgroup_with_role_and_container_identity(docker, collector, tmp_path):
    proc, cg = fake_cgroups(tmp_path, 42, 1500, 500)
    s, _ = tooled(docker, collector, tmp_path, proc_root=proc, cgroup_root=cg, cpu_interval_s=0.001)
    distinct_ids(docker)
    handle = s.create_case(case_spec(s, tmp_path, tool=tool_spec(tmp_path)))
    docker.overrides["inspect"] = lambda a: state(Running=True, Pid=42)
    handle.launch()
    handle.stop_and_drain()
    assert handle.cpu_counters() == [
        {"identity": {"role": "harness", "container": CID}, "user_ns": 1_500_000, "system_ns": 500_000},
        {"identity": {"role": "tool", "container": TOOL_ID}, "user_ns": 1_500_000, "system_ns": 500_000},
    ]
    handle.close()


def test_an_unreadable_cgroup_yields_no_counters_at_all(docker, collector, tmp_path):
    proc, cg = fake_cgroups(tmp_path, 42, 10, 10)
    s, _ = tooled(docker, collector, tmp_path, proc_root=proc, cgroup_root=cg)
    distinct_ids(docker)
    handle = s.create_case(case_spec(s, tmp_path, tool=tool_spec(tmp_path)))
    docker.overrides["inspect"] = lambda a: state(Running=True, Pid=42)
    handle.launch()
    # The tool container's cgroup vanishes (it never ran its meter's last read): only the harness is readable.
    handle._meters[TOOL_ID] = None
    handle.stop_and_drain()
    assert handle.cpu_counters() == []
    handle.close()


def test_a_case_whose_pid_is_unknown_has_no_counters(supervisor, tmp_path):
    handle = supervisor.start_case(case_spec(supervisor, tmp_path))
    handle.wait()
    handle.stop_and_drain()
    assert handle.cpu_counters() == []
