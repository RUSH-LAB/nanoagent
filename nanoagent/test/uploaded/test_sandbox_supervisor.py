"""The supervisor's own rules, without booting a VM: terminations, refusals before the self-test, build outputs, managed-command
working directories, network policies and the tool launcher. The microVMs themselves are test_sandbox_microsandbox.py's."""

from __future__ import annotations

import asyncio
import subprocess
import sys
import tarfile
import tomllib
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace

import pytest
from packaging.requirements import Requirement

from nanoagent.uploaded.archive import Extracted
from nanoagent.uploaded.contract import ContractError, HarnessManifest
from nanoagent.uploaded.sandbox import (
    CASE_USER,
    CLOSURE_MOUNT,
    GUEST_HOST,
    MSB,
    BuildSpec,
    Limits,
    MicrosandboxSupervisor,
    SandboxError,
    Termination,
    TerminationKind,
    ToolContainerSpec,
    _Case,
    _network,
    _Run,
    map_termination,
    termination_from_root_exit,
)
from nanoagent.uploaded.collector import ProcessEvent, ProcessEventKind
from nanoagent.uploaded.toolchains import CLOSURE_ARCHIVE, DependencyClosure, toolchain

PROFILE = toolchain("python-3")


def manifest(outputs: tuple[str, ...] = ("main.py",)) -> HarnessManifest:
    return HarnessManifest("h", "1", ("chat_completions",), "python-3", (), ("true",), outputs, ("python", "/harness/main.py"))


@pytest.fixture
def supervisor(tmp_path) -> MicrosandboxSupervisor:
    return MicrosandboxSupervisor(tools=tmp_path / "tools")


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


def exit_event(**fields) -> ProcessEvent:
    return ProcessEvent(0, ProcessEventKind.TASK_EXIT, 1, "c", 1, 1, 1, 1, 0, "p", "/", False, **fields)


def test_wait_takes_exit_versus_signal_from_the_root_exit_evidence():
    assert termination_from_root_exit(exit_event(exit_signal=9), -1, oom_killed=False, timed_out=False) == Termination(TerminationKind.SIGNALED, None, 9)
    assert termination_from_root_exit(exit_event(exit_code=137), 137, oom_killed=False, timed_out=False).kind is TerminationKind.NONZERO_EXIT
    assert termination_from_root_exit(None, 3, oom_killed=False, timed_out=False) == Termination(TerminationKind.EXITED, 3, None), "unanswered, not guessed"
    assert termination_from_root_exit(exit_event(exit_code=0), 0, oom_killed=False, timed_out=True).kind is TerminationKind.TIMED_OUT


def test_member_source_is_refused_until_the_tracer_self_test_passes(supervisor, tmp_path):
    with pytest.raises(SandboxError) as caught:
        supervisor.build(BuildSpec("a", PROFILE, manifest(), tmp_path, None, tmp_path))  # type: ignore[arg-type]
    assert caught.value.code == "collector_unverified"


@pytest.mark.parametrize("output", ["/abs", "../up", "a/../b", "a//b", ""])
def test_build_rejects_declared_outputs_that_are_not_canonical_relative_paths(supervisor, tmp_path, output):
    supervisor._probed.add(PROFILE.runtime_image)
    with pytest.raises(SandboxError) as caught:
        supervisor.build(BuildSpec("a", PROFILE, manifest((output,)), tmp_path, None, tmp_path))  # type: ignore[arg-type]
    assert caught.value.code == "output_invalid"


@pytest.mark.parametrize("dependencies", [False, True])
def test_build_mounts_a_dependency_disk_only_for_a_closure_with_dependencies(supervisor, tmp_path, monkeypatch, dependencies):
    # An empty closure got a disk too small for microsandbox to format as ext4, so no Terminal (no lockfiles) could build.
    closure_dir = tmp_path / "deps"
    closure_dir.mkdir()
    with tarfile.open(closure_dir / CLOSURE_ARCHIVE, "w"):
        pass
    closure = DependencyClosure(closure_dir, {"demo.whl": "0" * 64} if dependencies else {}, int(dependencies))
    mounted: dict = {}

    async def create(name, image, limits, network, volumes, **_):
        mounted.update(volumes)
        raise SandboxError("start_failed", "stopped by the test")

    monkeypatch.setattr(supervisor, "_create", create)
    spec = BuildSpec("a", PROFILE, manifest(), tmp_path, closure, tmp_path / "build")
    with pytest.raises(SandboxError, match="stopped by the test"):
        asyncio.run(supervisor._build(spec, tmp_path, tmp_path / "out"))
    assert (PROFILE.offline.dependency_mount in mounted, CLOSURE_MOUNT in mounted, "/build-out" in mounted) == (dependencies, dependencies, True)


def test_build_refuses_source_containing_a_link(supervisor, tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "evil").symlink_to("/etc")
    with pytest.raises(SandboxError, match="link"):
        supervisor._stage_source(BuildSpec("a", PROFILE, manifest(), source, None, tmp_path / "work"))  # type: ignore[arg-type]


def test_build_accepts_only_declared_outputs_and_refuses_a_missing_one_or_a_link(supervisor, tmp_path):
    root = tmp_path / "out"
    (root / "lib").mkdir(parents=True)
    (root / "main.py").write_text("x")
    (root / "lib" / "m.py").write_text("y")
    (root / "stray").write_text("z")
    tree = Extracted({"main.py": "h1", "lib/m.py": "h2", "stray": "h3"}, ("lib",), {}, 3)
    spec = BuildSpec("a", PROFILE, manifest(("main.py", "lib")), tmp_path, None, tmp_path / "work")  # type: ignore[arg-type]
    artifact = supervisor._accept_outputs(spec, (tree, root), _Run(0, b"", b"", False, False, False), 1.0)
    assert sorted(p.relative_to(artifact.directory).as_posix() for p in artifact.directory.rglob("*") if p.is_file()) == ["lib/m.py", "main.py"]
    with pytest.raises(SandboxError, match="was not produced"):
        supervisor._accept_outputs(BuildSpec("a", PROFILE, manifest(("gone",)), tmp_path, None, tmp_path / "w2"), (tree, root), _Run(0, b"", b"", False, False, False), 1.0)  # type: ignore[arg-type]
    linked = Extracted({"main.py": "h1"}, (), {"main.py": "symlink"}, 1)
    with pytest.raises(SandboxError, match="link or special"):
        supervisor._accept_outputs(spec, (linked, root), _Run(0, b"", b"", False, False, False), 1.0)


def case(supervisor: MicrosandboxSupervisor, tmp_path: Path, tool: ToolContainerSpec | None = None) -> _Case:
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    spec = SimpleNamespace(limits=Limits(), workdir=tmp_path, tool=tool)
    return _Case(supervisor, spec, "rush-case-x", object(), None, workspace, tmp_path / "out", {})  # type: ignore[arg-type]


@pytest.mark.parametrize("cwd", ["../etc", "/abs", "a/../../b", "a\\b"])
def test_managed_exec_rejects_cwd_that_leaves_the_workspace(supervisor, tmp_path, cwd):
    with pytest.raises(ContractError) as caught:
        case(supervisor, tmp_path)._resolve_cwd(cwd)
    assert caught.value.code == "invalid_cwd"


def test_managed_exec_checks_every_component_of_its_cwd_without_following_a_link(supervisor, tmp_path):
    handle = case(supervisor, tmp_path)
    (handle.workspace / "real" / "sub").mkdir(parents=True)
    (handle.workspace / "lnk").symlink_to(handle.workspace / "real")
    assert handle._resolve_cwd(".") == "/rush/workspace"
    assert handle._resolve_cwd("real/sub") == "/rush/workspace/real/sub"
    for cwd, message in (("lnk", "link"), ("lnk/sub", "link"), ("nope", "does not exist"), ("real/nope", "does not exist")):
        with pytest.raises(ContractError, match=message):
            handle._resolve_cwd(cwd)


def test_a_case_network_denies_everything_but_its_ports_and_internet_adds_only_public_addresses_and_dns():
    closed = _network([]).policy
    assert (closed.default_egress.value, closed.default_ingress.value, closed.rules) == ("deny", "deny", ())
    services = _network([4100]).policy.rules
    assert [(r.action.value, r.destination.value, r.port) for r in services] == [("allow", "host", 4100)]
    public = _network([4100], internet=True).policy.rules
    assert {r.destination.value for r in public} == {"host", "public"}
    assert {r.port for r in public if r.destination.value == "host"} == {4100, 53}, "DNS goes to the sandbox's own resolver"


def test_an_internet_case_cannot_resolve_the_model_providers_apis_and_a_closed_one_needs_no_list():
    hosts = ("api.openai.com", "openrouter.ai")
    assert _network([4100], internet=True, model_hosts=hosts).deny_domains == hosts
    assert _network([4100], model_hosts=hosts).deny_domains == (), "a case without internet resolves nothing"


def test_internet_access_without_the_model_hosts_to_block_is_refused():
    with pytest.raises(SandboxError, match="egress.model_hosts"):
        MicrosandboxSupervisor(tools=Path("t"), internet=True)


def test_the_egress_fence_fails_when_a_model_api_host_resolves(monkeypatch):
    supervisor = MicrosandboxSupervisor(tools=Path("t"), internet=True, model_hosts=("api.openai.com", "openrouter.ai"))

    async def probe(port):
        return False, ["openrouter.ai"]

    monkeypatch.setattr(supervisor, "_egress_probe", probe)
    with pytest.raises(SandboxError, match="resolved the model API hosts openrouter.ai"):
        supervisor.verify_egress()


def test_internet_access_is_refused_on_a_worker_without_it(supervisor):
    assert supervisor.create_network("a").ports == []
    with pytest.raises(SandboxError, match="not enabled"):
        supervisor.create_network("a", internet=True)
    assert MicrosandboxSupervisor(tools=Path("t"), internet=True, model_hosts=("api.openai.com",)).create_network("b", internet=True).internet


def test_the_launcher_execs_the_plugin_in_its_tool_vm_as_the_case_user_with_only_the_given_environment(supervisor, tmp_path):
    tool = ToolContainerSpec("rush-tool-a", tmp_path / "plugin", tmp_path / "fixtures", ("api.example.com",))
    handle = case(supervisor, tmp_path, tool)
    handle.tool_proxy, handle.bridge = f"http://{GUEST_HOST}:3999", ExitStack()
    supervisor._tool_cases[tool.name] = handle
    with supervisor.tool_launcher(tool.name).launch(SimpleNamespace(command=["uv", "run", "server"]), {"API_KEY": "k"}) as (argv, env):
        assert argv[:7] == [str(MSB), "exec", "--stream", "-u", CASE_USER, "-w", "/plugin"]
        assert argv[-5:] == ["rush-tool-a", "--", "uv", "run", "server"]
        pairs = dict(argv[i + 1].split("=", 1) for i, arg in enumerate(argv) if arg == "-e")
        assert pairs["API_KEY"] == "k" and pairs["NANOAGENT_FIXTURES"] == "/fixtures" and pairs["HTTPS_PROXY"] == f"http://{GUEST_HOST}:3999"
        assert pairs["UV_OFFLINE"] == "1" and pairs["PATH"].startswith("/opt/rush-tools:")
        assert "API_KEY" not in env or env["API_KEY"] != "k", "the plugin's environment is in the command, not msb's"
    with pytest.raises(SandboxError) as caught:
        with supervisor.tool_launcher("nobody").launch(SimpleNamespace(command=["x"]), {}):
            pass
    assert caught.value.code == "tool_unavailable"


def test_an_intel_mac_runs_nanoagent_without_microsandbox_and_its_supervisor_refuses_clearly(tmp_path):
    """microsandbox has no wheel for Intel Macs: pyproject leaves it out there, NanoAgent still imports, and a worker's supervisor
    refuses to start with why, so the worker advertises no sandbox."""
    project = Path(__file__).resolve().parents[2] / "pyproject.toml"
    [requirement] = [Requirement(r) for r in tomllib.loads(project.read_text())["project"]["dependencies"] if r.startswith("microsandbox")]
    assert not requirement.marker.evaluate({"sys_platform": "darwin", "platform_machine": "x86_64"})
    assert all(requirement.marker.evaluate(env) for env in (
        {"sys_platform": "darwin", "platform_machine": "arm64"}, {"sys_platform": "linux", "platform_machine": "x86_64"},
        {"sys_platform": "win32", "platform_machine": "AMD64"},
    ))  # fmt: skip
    script = f"""
import platform, sys
sys.modules["microsandbox"] = None  # not installed
platform.system, platform.machine = lambda: "Darwin", lambda: "x86_64"
import nanoagent.uploaded.worker, nanoagent.uploaded.runner, nanoagent.web.app
from nanoagent.uploaded.sandbox import MicrosandboxSupervisor, SandboxError, UNSUPPORTED
try:
    MicrosandboxSupervisor(tools={str(tmp_path)!r})
except SandboxError as error:
    assert error.code == "unsupported_platform" and UNSUPPORTED in str(error), error
else:
    raise AssertionError("the supervisor started on an Intel Mac")
"""
    done = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
