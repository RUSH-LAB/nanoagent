"""The sandbox supervisor: builds a pinned artifact and runs each case in a fresh gVisor container.

It drives the `docker` CLI with the `runsc-rush` runtime (deploy/gvisor). That runtime refuses to
start a container unless the worker's collector is listening, so every container here is observed.

* Build: a disposable container from the toolchain's pinned build image with no network, the source
  and the verified dependency closure mounted read-only, and a clean bounded `/build-out`. Only the
  manifest's declared `build.outputs` are accepted, with no links, and they become the worker-owned
  `/harness` of every run.
* Case: a fresh container from the pinned runtime image, an unprivileged uid, a read-only root, a
  read-only `/rush/request.json` and `/harness`, a bounded writable `/rush/out` and
  `/rush/workspace`, exactly the documented environment, and one per-attempt network: `--internal`, whose
  only members are the services attached to it, or, when the run grants internet access, a NATed bridge
  that the host filter (deploy/gvisor/egress.sh) limits to public addresses. Only the harness container
  gets it: the build never has a network, and the tool container only the egress proxy of the hosts its
  plugin declares.
* Tools: when the suite permits plugin tools, a second per-attempt container from the same pinned
  runtime image runs the plugin's MCP server (`docker exec -i` from the broker). It has no network but the egress proxy of its declared hosts,
  an unprivileged uid, a read-only root, the prepared plugin and approved fixtures read-only, and
  the case's workspace volume at the same path the harness sees. It never mounts the request, the
  result directory, private references or verifier files.
* Freeze: `stop_and_drain` reads each container's CPU counters, kills the tool container and pauses
  the whole harness sandbox so no process can write, then copies the bounded workspace out without
  following links.

Every failure is a [SandboxError] with a stable `code`; nothing falls back to a weaker mode.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import shutil
import socket
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from nanoagent.plugin.egress import egress
from nanoagent.plugin.install import INSTALL_HOSTS
from nanoagent.uploaded.archive import ArchiveError, Extracted, extract_tar, tar_of_tree
from nanoagent.uploaded.collector import CollectorError, CollectorHealth, ProcessEvent, ProcessEvidence, launch_argv, launched_processes
from nanoagent.uploaded.contract import ContractError, HarnessManifest, is_canonical_relative_path, path_problem, read_result_file, validate_argv
from nanoagent.uploaded.dockercli import CliDockerRunner, DockerResult, DockerRunner
from nanoagent.uploaded.toolchains import HOLDER_IMAGE, DependencyClosure, ToolchainProfile

RUNTIME = "runsc-rush"
UID = 10001
GID = 10001
WORKSPACE = "/rush/workspace"
OUT_DIR = "/rush/out"
REQUEST_PATH = "/rush/request.json"
HARNESS_DIR = "/harness"
PLUGIN_DIR = "/plugin"
PLUGIN_SOURCE_DIR = "/plugin-source"  # the prep container's read-only view of the plugin, copied into PLUGIN_DIR to build
FIXTURES_DIR = "/fixtures"
UV_BIN = "/usr/local/bin/uv"
FIXTURES_ENV = "NANOAGENT_FIXTURES"
RESULT_NAME = "result.json"
EXEC_KILL_GRACE_S = 2
CWD_MISSING, CWD_LINK, CWD_CHECK_TIMEOUT_S = 3, 4, 10
# Run in the volume holder: exit CWD_MISSING for a component that does not exist, CWD_LINK for one that is a symlink.
CWD_CHECK = (
    "import os, stat, sys\n"
    "path = sys.argv[1]\n"
    "for part in sys.argv[2].split('/'):\n"
    "    path += '/' + part\n"
    "    try:\n"
    "        mode = os.lstat(path).st_mode\n"
    "    except OSError:\n"
    f"        sys.exit({CWD_MISSING})\n"
    "    if stat.S_ISLNK(mode):\n"
    f"        sys.exit({CWD_LINK})\n"
)
# How long a command that exited nonzero is given for its task exit to reach the collector, which streams it behind `docker exec`.
EXEC_EVIDENCE_WAIT_S = 5.0
MAX_RESULT_BYTES = 1 << 20
# A tar stream carries a 512-byte header and up to 511 bytes of padding per entry on top of the file bytes it is bounded by.
TAR_ENTRY_OVERHEAD = 1024
# python:3.12-trixie: the runtime image's Debian release and Python, plus git, which uv needs for git-sourced
# dependencies. Plugins are synced here so their virtual environment matches the tool container's runtime.
EGRESS_PORT = 3128
EGRESS_FORWARDER = Path(__file__).with_name("relay_forward.py").read_text(encoding="utf-8")
PLUGIN_PREP_IMAGE = "python@sha256:cad37dd20c7cac861af9003af8796d03ea7a998ec1e3a664429740fc9d7d2691"
CGROUP_ROOT = Path("/sys/fs/cgroup")
CPU_SAMPLE_INTERVAL_S = 0.02
_NETWORK_OPTIONS = (
    # No gateway address: the host (and everything listening on it) is not reachable from the network.
    "com.docker.network.bridge.gateway_mode_ipv4=isolated",
    "com.docker.network.bridge.gateway_mode_ipv6=isolated",
)


class SandboxError(ContractError):
    """A supervisor failure; `code` is stable (`start_failed`, `build_failed`, `output_invalid`, ...)."""


class TerminationKind(StrEnum):
    EXITED = "exited"  # exit status 0, or the raw code when no root-exit evidence could classify it
    NONZERO_EXIT = "nonzero_exit"
    SIGNALED = "signaled"
    TIMED_OUT = "timed_out"


@dataclass(frozen=True, slots=True)
class Limits:
    """Enforced budgets for one sandbox."""

    cpus: float = 1.0
    memory_bytes: int = 1 << 30
    pids: int = 256
    workspace_bytes: int = 256 << 20
    out_bytes: int = 4 << 20
    tmp_bytes: int = 64 << 20
    output_bytes: int = 1 << 20  # captured stdout and stderr, each
    wall_s: float = 300.0
    workspace_files: int = 20_000


@dataclass(frozen=True, slots=True)
class Termination:
    kind: TerminationKind
    exit_code: int | None
    signal: int | None
    oom_killed: bool = False


def map_termination(exit_code: int, *, oom_killed: bool, timed_out: bool) -> Termination:
    """Docker's exit status to a termination. A signal is never inferred from the code (128 + n is also
    a plain exit status); signals come from the collector's task-exit evidence."""
    if timed_out:
        return Termination(TerminationKind.TIMED_OUT, None, 9)
    if oom_killed:
        return Termination(TerminationKind.SIGNALED, None, 9, oom_killed=True)
    if exit_code == 0:
        return Termination(TerminationKind.EXITED, 0, None)
    return Termination(TerminationKind.NONZERO_EXIT, exit_code, None)


def termination_from_root_exit(root_exit: ProcessEvent | None, exit_code: int, *, oom_killed: bool, timed_out: bool) -> Termination:
    """The harness's termination from the root process's task-exit evidence.

    Without that evidence the raw code is reported as `exited`, and the caller marks the process
    evidence incomplete: the signal-versus-exit question is left unanswered, not guessed.
    """
    if timed_out or oom_killed:
        return map_termination(exit_code, oom_killed=oom_killed, timed_out=timed_out)
    if root_exit is None:
        return Termination(TerminationKind.EXITED, exit_code, None)
    if root_exit.exit_signal is not None:
        return Termination(TerminationKind.SIGNALED, None, root_exit.exit_signal)
    return map_termination(root_exit.exit_code or 0, oom_killed=False, timed_out=False)


@dataclass(frozen=True, slots=True)
class CaseOutcome:
    termination: Termination
    launched_at: float  # injected monotonic clock, taken immediately before `docker start`
    exited_at: float
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool


@dataclass(frozen=True, slots=True)
class ExecOutcome:
    launch_id: str  # the marker in the member process's observed `execve`: see collector.launched_processes
    argv: tuple[str, ...]
    cwd: str  # as requested, relative to the workspace
    absolute_cwd: str  # what the process evidence reports
    termination: Termination
    launched_at: float
    returned_at: float
    launched_wall_ns: int
    returned_wall_ns: int
    stdout: bytes  # base64 these for the ExecResult wire shape
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool


@dataclass(frozen=True, slots=True)
class WorkspaceSnapshot:
    directory: Path
    files: Mapping[str, str]  # path to sha256
    added: tuple[str, ...]
    modified: tuple[str, ...]
    deleted: tuple[str, ...]
    skipped: Mapping[str, str]  # links and special files, listed but never materialized
    total_bytes: int


@dataclass(frozen=True, slots=True)
class BuildArtifact:
    directory: Path  # mounted read-only at /harness
    outputs: tuple[str, ...]
    digest: str  # sha256 over the sorted (path, sha256) of every file
    stdout: bytes
    stderr: bytes
    duration_s: float


@dataclass(frozen=True, slots=True)
class BuildSpec:
    attempt_id: str
    profile: ToolchainProfile
    manifest: HarnessManifest
    source_root: Path
    closure: DependencyClosure
    workdir: Path  # worker-owned scratch; the artifact lands in workdir/harness
    limits: Limits = Limits()


@dataclass(frozen=True, slots=True)
class ToolContainerSpec:
    """The per-attempt container the plugin's MCP server runs in."""

    name: str  # the container's name: the broker's `docker exec` addresses it before the case exists
    plugin_root: Path  # the plugin, prepared with `prepare_plugin`; mounted read-only at /plugin
    fixtures: Path | None = None  # approved fixtures; mounted read-only at /fixtures
    egress_hosts: tuple[str, ...] = ()  # the only hosts (HTTPS, port 443) the plugin's processes may reach, through the egress proxy


@dataclass(frozen=True, slots=True)
class CaseSpec:
    attempt_id: str
    profile: ToolchainProfile
    run_argv: tuple[str, ...]
    artifact: BuildArtifact
    request_json: bytes
    attempt_token: str
    network: AttemptNetwork
    workdir: Path
    fixtures: Path | None = None
    limits: Limits = Limits()
    tool: ToolContainerSpec | None = None


class CaseHandle(Protocol):
    @property
    def container_id(self) -> str: ...

    def launch(self) -> None:
        """Starts the harness. Returns once the sandbox runs; raises a SandboxError when it cannot start."""
        ...

    def wait(self) -> CaseOutcome:
        """Blocks until the harness exits or its wall budget ends (then the sandbox is killed)."""
        ...

    def exec_in_case(self, argv: Sequence[str], cwd: str, timeout_ms: int, limits: Limits) -> ExecOutcome: ...

    def stop_and_drain(self) -> WorkspaceSnapshot:
        """Reads the CPU counters, kills the tool container, freezes every writer in the harness sandbox, then
        snapshots the workspace and diffs it with the initial one."""
        ...

    def cpu_counters(self) -> list[dict[str, Any]]:
        """`{identity, user_ns, system_ns}` per container, read by `stop_and_drain`; empty when any is unreadable."""
        ...

    def read_result(self) -> bytes:
        """The bytes of `/rush/out/result.json`; raises a ResultError-coded SandboxError when absent or unusable."""
        ...

    def evidence(self) -> ProcessEvidence:
        """Protected process evidence, once the sandbox has been stopped."""
        ...

    def close(self) -> None: ...


class EvidenceSource(Protocol):
    """The part of the collector the supervisor uses."""

    def health(self) -> CollectorHealth: ...

    def session(self, container_id: str) -> None: ...

    def snapshot(self, container_id: str) -> ProcessEvidence: ...

    def finish(self, container_id: str, *, timeout_s: float = ...) -> ProcessEvidence: ...

    def discard(self, container_id: str) -> None: ...


@dataclass(frozen=True, slots=True)
class Egress:
    """What the worker needs for harnesses with internet access: the reserved IPv4 subnet its attempt networks are carved
    from (the filter `deploy/gvisor/egress.sh` was installed for) and the public resolvers they use."""

    subnet: str = "10.213.0.0/16"
    dns: tuple[str, ...] = ("1.1.1.1", "8.8.8.8")
    prefix: int = 28  # each attempt network's size


class AttemptNetwork:
    """A per-attempt network. `--internal` (the default): the services attached to it are the only reachable endpoints.
    With ``internet``: a NATed bridge in the reserved egress subnet whose public traffic the host filter allows; the
    services attached to it stay reachable, and private, link-local, metadata and host addresses do not."""

    def __init__(self, docker: DockerRunner, name: str, *, internet: bool = False, dns: Sequence[str] = ()) -> None:
        self._docker = docker
        self.name = name
        self.internet = internet
        self.dns = tuple(dns)

    def connect(self, container: str, aliases: Sequence[str] = ()) -> None:
        args = ["network", "connect", *[a for alias in aliases for a in ("--alias", alias)], self.name, container]
        _checked(self._docker.run(args), "network_failed", f"attach {container} to {self.name}")

    def address_of(self, container: str) -> str:
        """The container's IPv4 address on this network. Guests address services by IP: Docker's embedded
        DNS is not reachable from inside a gVisor netstack sandbox."""
        template = f'{{{{(index .NetworkSettings.Networks "{self.name}").IPAddress}}}}'
        address = _checked(self._docker.run(["inspect", "--format", template, container]), "network_failed", f"address of {container}").text()
        if not address:
            raise SandboxError("network_failed", f"{container} has no address on {self.name}")
        return address

    def remove(self) -> None:
        # Fails while a container is still attached; the caller removes its containers first.
        _checked(self._docker.run(["network", "rm", self.name]), "network_failed", f"remove network {self.name}")


def _checked(result: DockerResult, code: str, what: str) -> DockerResult:
    if result.returncode != 0 or result.timed_out:
        raise SandboxError(code, f"{what} failed: {result.error_text() or 'docker timed out'}")
    return result


def _mount_volume(name: str, destination: str) -> list[str]:
    # volume-nocopy: Docker must not copy image content into the volume or adopt the mount point's owner;
    # the volume's own uid/gid options are the owner.
    return ["--mount", f"type=volume,src={name},dst={destination},volume-nocopy"]


def _mount_bind(source: Path, destination: str, *, readonly: bool = True) -> list[str]:
    return ["--mount", f"type=bind,src={source},dst={destination}{',readonly' if readonly else ''}"]


def _entrypoint(argv: Sequence[str]) -> tuple[list[str], list[str]]:
    # The argv is run exactly, never through a shell and never with the image's own ENTRYPOINT or CMD.
    return ["--entrypoint", argv[0]], list(argv[1:])


def cgroup_directory(pid: int, *, proc_root: Path = Path("/proc"), cgroup_root: Path = CGROUP_ROOT) -> Path | None:
    """The cgroup v2 directory of process ``pid``, or None when it cannot be read."""
    try:
        lines = (proc_root / str(pid) / "cgroup").read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        hierarchy, _, rest = line.partition(":")
        _, _, path = rest.partition(":")
        if hierarchy == "0" and path:
            return cgroup_root / path.lstrip("/")
    return None


def read_cpu_stat(directory: Path) -> tuple[int, int] | None:
    """`(user_ns, system_ns)` from the cgroup's `cpu.stat`, or None when it is gone or unreadable."""
    try:
        text = (directory / "cpu.stat").read_text()
    except OSError:
        return None
    fields = dict(re.findall(r"^(user_usec|system_usec) (\d+)$", text, re.MULTILINE))
    if len(fields) != 2:
        return None
    return int(fields["user_usec"]) * 1000, int(fields["system_usec"]) * 1000


class CpuMeter:
    """The last CPU reading of one container's cgroup.

    A container's cgroup is removed the moment its sandbox exits, so a sandbox that ends on its own cannot be read
    afterwards: a thread reads it every `interval_s` until it is gone, and `stop` returns the last reading. That reading
    trails the exit by at most one interval. A live container is read exactly with `sample`, which `stop_and_drain` calls
    right before it stops one.
    """

    def __init__(self, directory: Path, interval_s: float = CPU_SAMPLE_INTERVAL_S) -> None:
        self._directory = directory
        self._interval_s = interval_s
        self._latest: tuple[int, int] | None = None
        self._stopped = threading.Event()
        self._thread = threading.Thread(target=self._watch, name=f"cpu-{directory.name}", daemon=True)

    def start(self) -> None:
        self.sample()
        self._thread.start()

    def sample(self) -> tuple[int, int] | None:
        reading = read_cpu_stat(self._directory)
        if reading is not None:
            self._latest = reading
        return reading

    def _watch(self) -> None:
        while not self._stopped.wait(self._interval_s):
            if self.sample() is None:
                return

    def stop(self) -> tuple[int, int] | None:
        self._stopped.set()
        if self._thread.is_alive():
            self._thread.join()
        return self._latest


class ToolLauncher:
    """Runs a plugin's MCP server in the case's tool container, for a `PluginSession`."""

    def __init__(self, supervisor: DockerSandboxSupervisor, name: str) -> None:
        self._supervisor = supervisor
        self._name = name

    def _case(self) -> _DockerCase:
        case = self._supervisor._tool_cases.get(self._name)
        if case is None:
            raise SandboxError("tool_unavailable", f"no case has the tool container {self._name}")
        return case

    @contextmanager
    def launch(self, manifest: Any, env: Mapping[str, str]) -> Iterator[tuple[list[str], dict[str, str]]]:
        """The `docker exec` that starts the plugin: only ``env`` and the sandbox's own variables reach it."""
        case = self._case()
        inside = {**env, "HOME": "/tmp", "UV_CACHE_DIR": "/tmp/uv-cache", "UV_NO_SYNC": "1", "UV_OFFLINE": "1"}
        if case.spec.tool is not None and case.spec.tool.fixtures is not None:
            inside[FIXTURES_ENV] = FIXTURES_DIR
        if case.tool_proxy is not None:
            inside |= {key: case.tool_proxy for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")}
        argv = [self._supervisor._docker_bin, "exec", "-i", f"--user={UID}:{GID}", "--workdir", PLUGIN_DIR]
        for key, value in inside.items():
            argv += ["-e", f"{key}={value}"]
        yield [*argv, self._name, *manifest.command], dict(os.environ)  # the environment is the docker client's, not the plugin's

    @contextmanager
    def workspace_view(self) -> Iterator[Path]:
        """A copy of the case workspace as it is now, for the host-side tool verifier to read.

        One at a time per case: concurrent tool calls of an attempt queue, so at most one copy is ever held."""
        case = self._case()
        with case.view_lock:
            _, directory = self._supervisor._copy_out(case.holder, "/hold/workspace", case.spec.limits, case.spec.workdir)
            try:
                yield directory
            finally:
                shutil.rmtree(directory, ignore_errors=True)


# Every container, network and volume the supervisor creates is named `rush-…` (rush-net-, rush-ws-, rush-out-, rush-buildout-,
# rush-case-, rush-hold-, rush-prep-, rush-*-relay-, rush-egress-probe-), so that prefix is exactly what a dead run leaves behind.
RESOURCE_PREFIX = "rush-"


def reap_leftovers(docker: DockerRunner) -> list[tuple[str, str]]:
    """Remove the `rush-*` containers, networks and volumes a previous run left; returns (kind, name) of each.

    Docker's name filter matches anywhere in the name, so the listing is filtered again to names that start with the prefix.
    Run it before any attempt exists, and never against a daemon another worker is using."""
    reaped: list[tuple[str, str]] = []
    for kind, list_args, remove_args in (
        ("container", ["ps", "-a", "--format", "{{.Names}}"], ["rm", "-f", "-v"]),
        ("network", ["network", "ls", "--format", "{{.Name}}"], ["network", "rm"]),
        ("volume", ["volume", "ls", "--format", "{{.Name}}"], ["volume", "rm", "-f"]),
    ):
        listed = _checked(docker.run([*list_args[:-2], "--filter", f"name={RESOURCE_PREFIX}", *list_args[-2:]], timeout_s=60), "reap_failed", f"list {kind}s")
        for name in listed.text().splitlines():
            if name.startswith(RESOURCE_PREFIX):
                _checked(docker.run([*remove_args, name], timeout_s=120), "reap_failed", f"remove {kind} {name}")
                reaped.append((kind, name))
    return reaped


class DockerSandboxSupervisor:
    def __init__(
        self,
        docker: DockerRunner | None = None,
        *,
        collector: EvidenceSource,
        clock: Callable[[], float] = time.monotonic,
        wall_clock_ns: Callable[[], int] = time.time_ns,
        runtime: str = RUNTIME,
        uv: Path | None = None,
        egress: Egress | None = None,
        docker_bin: str = "docker",
        cpu_interval_s: float = CPU_SAMPLE_INTERVAL_S,
        cgroup_root: Path = CGROUP_ROOT,
        proc_root: Path = Path("/proc"),
    ) -> None:
        self._docker = docker or CliDockerRunner()
        self._uv = uv
        self._egress = egress
        self._docker_bin = docker_bin
        self._cpu_interval_s = cpu_interval_s
        self._cgroup_root = cgroup_root
        self._proc_root = proc_root
        self._tool_cases: dict[str, _DockerCase] = {}
        self._collector = collector
        self._clock = clock
        self._wall_clock_ns = wall_clock_ns
        self._runtime = runtime
        self._ready = False

    # -- startup ---------------------------------------------------------------------------------

    def startup(self, profile: ToolchainProfile) -> ProcessEvidence:
        """Proves the collector end to end: a trivial container's exec and exit must be observed.

        Until this passes `build` and `start_case` refuse to run member source.
        """
        health = self._collector.health()
        if not health.listening:
            raise SandboxError("collector_unhealthy", "the process collector is not listening")
        self._pull(profile.runtime_image)
        self._pull(HOLDER_IMAGE)
        probe = ("/bin/true",)
        container = self._create_probe(profile.runtime_image, probe)
        try:
            self._collector.session(container)
            result = self._docker.run(["start", "-a", container], timeout_s=60)
            if result.returncode != 0:
                raise SandboxError("collector_self_test_failed", f"probe container failed: {result.error_text()}")
            evidence = self._collector.finish(container)
        except CollectorError as error:
            raise SandboxError("collector_self_test_failed", str(error)) from error
        finally:
            self._remove_container(container)
            self._collector.discard(container)
        if not evidence.complete:
            raise SandboxError("collector_self_test_failed", f"probe evidence incomplete: {', '.join(evidence.loss_reasons)}")
        proc = evidence.find_exec(probe)
        if not proc or proc[0].exit is None or proc[0].exit.exit_code != 0:
            raise SandboxError("collector_self_test_failed", "the probe's exec and exit were not both observed")
        self._ready = True
        return evidence

    def _pull(self, image: str) -> None:
        if self._docker.run(["image", "inspect", image]).returncode != 0:
            _checked(self._docker.run(["pull", "--quiet", image], timeout_s=600), "image_unavailable", f"pull {image}")

    def _create_probe(self, image: str, argv: tuple[str, ...]) -> str:
        entry, rest = _entrypoint(argv)
        args = ["create", f"--runtime={self._runtime}", "--network=none", "--read-only", "--cap-drop=ALL", *entry, image, *rest]
        return _checked(self._docker.run(args), "start_failed", "create probe container").text()

    def _require_ready(self) -> None:
        if not self._ready:
            raise SandboxError("collector_unverified", "startup() has not proven the process collector; member source is not accepted")

    # -- networks --------------------------------------------------------------------------------

    def verify_egress(self) -> None:
        """Proves the host filter is in place: a container on an internet-access network must not reach a listener on this
        worker host. Raises a SandboxError otherwise, so a worker without the filter never advertises internet access."""
        name = f"rush-egress-probe-{uuid.uuid4().hex[:12]}"
        network = self._create_egress_network(name)
        try:
            gateway = _checked(
                self._docker.run(["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", name]), "egress_unverified", "inspect the probe network"
            ).text()
            with socket.socket() as listener:
                listener.bind(("0.0.0.0", 0))
                listener.listen(1)
                listener.settimeout(0.1)
                port = listener.getsockname()[1]
                code = f"import socket; socket.create_connection(({gateway!r}, {port}), timeout=3); print('reached')"
                result = self._docker.run(
                    ["run", "--rm", "--runtime=runc", f"--network={name}", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534",
                     "--entrypoint", "python", HOLDER_IMAGE, "-c", code],
                    timeout_s=30,
                )
                try:
                    listener.accept()
                    reached = True
                except OSError:
                    reached = False
            if reached or b"reached" in result.stdout:
                raise SandboxError("egress_unverified", f"a container on the egress network reached this host at {gateway}: install deploy/gvisor/egress.sh")
        finally:
            self._docker.run(["network", "rm", network.name])

    def create_network(self, attempt_id: str, *, internet: bool = False) -> AttemptNetwork:
        name = f"rush-net-{attempt_id}"
        if internet:
            return self._create_egress_network(name)
        args = ["network", "create", "--internal", "--driver", "bridge", *[a for o in _NETWORK_OPTIONS for a in ("--opt", o)], name]
        _checked(self._docker.run(args), "network_failed", f"create network {name}")
        return AttemptNetwork(self._docker, name)

    def _create_egress_network(self, name: str) -> AttemptNetwork:
        """A NATed bridge on a free slice of the reserved egress subnet, so the host filter (`deploy/gvisor/egress.sh`) applies to it.

        Docker refuses an overlapping subnet, so a slice taken by another attempt is skipped.
        """
        egress = self._egress
        if egress is None:
            raise SandboxError("network_failed", "internet access needs the supervisor to be given the egress subnet it is filtered for")
        pool = ipaddress.ip_network(egress.subnet)
        slices = 1 << (egress.prefix - pool.prefixlen)
        first = int(uuid.uuid4().int % slices)
        last = ""
        for offset in range(slices):
            subnet = ipaddress.ip_network((int(pool.network_address) + ((first + offset) % slices << (32 - egress.prefix)), egress.prefix))
            result = self._docker.run(["network", "create", "--driver", "bridge", "--subnet", str(subnet), name])
            if result.returncode == 0 and not result.timed_out:
                return AttemptNetwork(self._docker, name, internet=True, dns=egress.dns)
            last = result.error_text() or "docker timed out"
            if "overlap" not in last and "Pool" not in last:
                break
        raise SandboxError("network_failed", f"create network {name} failed: {last}")

    # -- build -----------------------------------------------------------------------------------

    def build(self, spec: BuildSpec) -> BuildArtifact:
        self._require_ready()
        for output in spec.manifest.build_outputs:
            if path_problem(output) is not None or not is_canonical_relative_path(output):
                raise SandboxError("output_invalid", f"declared build output {output!r} is not a canonical relative path")
        source = self._stage_source(spec)
        suffix = f"{spec.attempt_id}-build-{uuid.uuid4().hex[:8]}"
        out_volume = self._create_volume(f"rush-buildout-{suffix}", spec.limits.workspace_bytes)
        env_file = self._write_env(spec.workdir, {**spec.profile.offline.env, "HOME": "/tmp", "TMPDIR": "/tmp"})
        entry, rest = _entrypoint(spec.manifest.build_argv)
        container = holder = ""
        try:
            holder = self._start_holder(suffix, {out_volume: "/hold/build-out"})
            args = [
                "create", *self._isolation(spec.limits, network="none"), "--workdir", "/src", "--env-file", str(env_file),
                *_mount_bind(source, "/src"), *_mount_bind(spec.closure.directory, spec.profile.offline.dependency_mount),
                *_mount_volume(out_volume, "/build-out"), *entry, spec.profile.build_image, *rest,
            ]
            container = _checked(self._docker.run(args), "build_failed", "create build container").text()
            self._collector.session(container)
            started = self._clock()
            result = self._docker.run(
                ["start", "-a", container], timeout_s=spec.limits.wall_s, capture_bytes=spec.limits.output_bytes
            )
            if result.timed_out:
                self._docker.run(["kill", container])
                raise SandboxError("build_timeout", f"build exceeded {spec.limits.wall_s}s")
            duration = self._clock() - started
            state = self._state(container)
            if state.get("StartedAt", "").startswith("0001"):
                raise SandboxError("start_failed", f"build container did not start: {state.get('Error') or result.error_text()}")
            if state.get("ExitCode") != 0:
                tail = result.stderr[-2000:].decode("utf-8", "replace")
                raise SandboxError("build_failed", f"build exited {state.get('ExitCode')}: {tail}")
            extracted = self._copy_out(holder, "/hold/build-out", spec.limits, spec.workdir)
            try:
                return self._accept_outputs(spec, extracted, result, duration)
            finally:
                shutil.rmtree(extracted[1], ignore_errors=True)
        finally:
            if container:
                self._remove_container(container)
                self._collector.discard(container)
            if holder:
                self._remove_container(holder)
            self._remove_volume(out_volume)
            env_file.unlink(missing_ok=True)

    def _stage_source(self, spec: BuildSpec) -> Path:
        """A private copy with modes the unprivileged build user can read; links are refused."""
        staged = spec.workdir / "src"
        if staged.exists():
            shutil.rmtree(staged)
        for path in spec.source_root.rglob("*"):
            if path.is_symlink():
                raise SandboxError("output_invalid", f"source contains a link: {path.relative_to(spec.source_root)}")
        shutil.copytree(spec.source_root, staged, symlinks=False)
        for path in [staged, *staged.rglob("*")]:
            executable = path.is_dir() or os.access(path, os.X_OK)
            path.chmod(0o755 if executable else 0o644)
        return staged

    def _accept_outputs(self, spec: BuildSpec, extracted: tuple[Extracted, Path], result: DockerResult, duration: float) -> BuildArtifact:
        tree, root = extracted
        artifact = spec.workdir / "harness"
        if artifact.exists():
            shutil.rmtree(artifact)
        artifact.mkdir(parents=True)
        accepted: dict[str, str] = {}
        for output in spec.manifest.build_outputs:
            prefix = output + "/"
            covered = {p: h for p, h in tree.files.items() if p == output or p.startswith(prefix)}
            if any(p == output or p.startswith(prefix) for p in tree.skipped):
                raise SandboxError("output_invalid", f"build output {output} contains a link or special file")
            if not covered and output not in tree.directories:
                raise SandboxError("output_invalid", f"declared build output {output} was not produced")
            accepted.update(covered)
            source = root / output
            target = artifact / output
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target, dirs_exist_ok=True)
            else:
                shutil.copy2(source, target)
        for path in [artifact, *artifact.rglob("*")]:
            executable = path.is_dir() or os.access(path, os.X_OK)
            path.chmod(0o755 if executable else 0o644)
        digest = hashlib.sha256("".join(f"{p}\0{h}\n" for p, h in sorted(accepted.items())).encode()).hexdigest()
        return BuildArtifact(artifact, spec.manifest.build_outputs, digest, result.stdout, result.stderr, duration)

    # -- case ------------------------------------------------------------------------------------

    def start_case(self, spec: CaseSpec) -> _DockerCase:
        handle = self.create_case(spec)
        try:
            handle.launch()
        except BaseException:
            handle.abort()
            raise
        return handle

    def tool_launcher(self, name: str) -> ToolLauncher:
        """The launcher for the tool container ``name``; the case that names it in `CaseSpec.tool` is created later."""
        return ToolLauncher(self, name)

    def prepare_plugin(self, root: Path, timeout_s: float) -> None:
        """`uv sync --frozen` the unpacked plugin at ``root`` inside the pinned prep image, in a gVisor sandbox.

        The environment lands in ``root/.venv``, valid at /plugin in the tool container. Publisher code runs here (the project's
        build, git sources, sdists), so the container has the case limits' cpu, memory and pids bounds and ``root`` is mounted
        read-only: the build runs in a copy of it in the sandbox's memory (a build writes into its source, as setuptools' egg-info
        does), only ``.venv`` is writable on the host, and nothing else there can be planted or swapped. The sandbox is on an
        `--internal` network whose only way out is the host install's egress proxy, which tunnels `INSTALL_HOSTS`
        (the package index and GitHub) and nothing else.
        """
        uv = self._require_uv()
        name = f"rush-prep-{uuid.uuid4().hex[:12]}"
        limits = Limits()
        venv = root / ".venv"
        venv.mkdir(exist_ok=True)
        with self._egress_bridge(INSTALL_HOSTS, "prep") as (network, proxy):
            args = [
                "run", f"--name={name}", "--rm", f"--runtime={self._runtime}", f"--network={network}", f"--user={os.getuid()}:{os.getgid()}",
                "--cap-drop=ALL", "--security-opt=no-new-privileges", "--log-driver=none", "--tmpfs", "/tmp:rw,nosuid,size=1g",
                f"--cpus={limits.cpus}", f"--memory={limits.memory_bytes}", f"--memory-swap={limits.memory_bytes}", f"--pids-limit={limits.pids}",
                "--workdir", PLUGIN_DIR, "--tmpfs", f"{PLUGIN_DIR}:rw,nosuid,size=1g,mode=1777", *_mount_bind(root, PLUGIN_SOURCE_DIR),
                *_mount_bind(venv, f"{PLUGIN_DIR}/.venv", readonly=False), *_mount_bind(uv, UV_BIN),
                "-e", "HOME=/tmp", "-e", "UV_CACHE_DIR=/tmp/uv-cache", "-e", "UV_LINK_MODE=copy", "-e", "UV_PYTHON_DOWNLOADS=never",
                *[a for key in ("HTTPS_PROXY", "https_proxy") for a in ("-e", f"{key}={proxy}")],
                "--entrypoint", "sh", PLUGIN_PREP_IMAGE, "-c",
                f'tar -C {PLUGIN_SOURCE_DIR} --exclude=./.venv -cf - . | tar -C {PLUGIN_DIR} --strip-components=1 -xf - && exec "$@"', "prep",
                UV_BIN, "sync", "--frozen", "--no-dev", "--python", "/usr/local/bin/python", "--quiet",
            ]
            result = self._docker.run(args, timeout_s=timeout_s)
            if result.timed_out:
                self._remove_container(name)
                raise SandboxError("plugin_prepare_failed", f"preparing {root.name} exceeded {timeout_s}s")
            _checked(result, "plugin_prepare_failed", f"prepare plugin {root.name}")

    @contextmanager
    def _egress_bridge(self, hosts: Sequence[str], role: str) -> Iterator[tuple[str, str]]:
        """A private `--internal` network and the HTTPS proxy URL on it: a relay container forwards to the host's egress proxy
        socket (as an attempt's services are), which tunnels `CONNECT host:443` for ``hosts`` whose addresses are all public
        (`nanoagent.plugin.egress`), and nothing else of the host or the internet is reachable from it."""
        suffix = uuid.uuid4().hex[:12]
        with egress(hosts) as proxy_socket:
            network = self.create_network(f"{role}-{suffix}")
            relay = ""
            try:
                args = [
                    "create", f"--name=rush-{role}-relay-{suffix}", "--runtime=runc", f"--network={network.name}", "--read-only", "--cap-drop=ALL",
                    "--security-opt=no-new-privileges", f"--user={os.getuid()}:{os.getgid()}", "--memory=64m", "--pids-limit=64",
                    "--log-opt=max-size=1m", *_mount_bind(proxy_socket.parent, "/sock"),
                    "--entrypoint", "python", HOLDER_IMAGE, "-c", EGRESS_FORWARDER, f"/sock/{proxy_socket.name}", str(EGRESS_PORT),
                ]
                relay = _checked(self._docker.run(args), "plugin_prepare_failed", "create the egress relay").text()
                _checked(self._docker.run(["start", relay]), "plugin_prepare_failed", "start the egress relay")
                deadline = time.monotonic() + 20
                while b"ready" not in self._docker.run(["logs", relay]).stdout:
                    if time.monotonic() > deadline:
                        raise SandboxError("plugin_prepare_failed", "the egress relay did not report ready")
                    time.sleep(0.1)
                yield network.name, f"http://{network.address_of(relay)}:{EGRESS_PORT}"
            finally:
                if relay:
                    self._remove_container(relay)
                self._docker.run(["network", "rm", network.name])

    def _require_uv(self) -> Path:
        if self._uv is None:
            raise SandboxError("tool_unavailable", "plugin tools need the supervisor to be given the uv binary")
        return self._uv

    def create_case(self, spec: CaseSpec) -> _DockerCase:
        """Creates the case's volumes, harness container and, when `spec.tool` is set, a running tool container.

        The harness starts at `launch`, so a caller can open the plugin session first. `start_case` does both.
        """
        self._require_ready()
        validate_argv(list(spec.run_argv))
        spec.workdir.mkdir(parents=True, exist_ok=True)
        suffix = f"{spec.attempt_id}-{uuid.uuid4().hex[:8]}"
        ws_volume = self._create_volume(f"rush-ws-{suffix}", spec.limits.workspace_bytes)
        out_volume = self._create_volume(f"rush-out-{suffix}", spec.limits.out_bytes)
        request = spec.workdir / "request.json"
        request.write_bytes(spec.request_json)
        request.chmod(0o644)
        env = {
            "RUSH_REQUEST": REQUEST_PATH,
            "RUSH_RESULT": f"{OUT_DIR}/{RESULT_NAME}",
            "RUSH_WORKSPACE": WORKSPACE,
            "RUSH_ATTEMPT_TOKEN": spec.attempt_token,
            "HOME": "/tmp",
            "TMPDIR": "/tmp",
            **spec.profile.runtime_env,
        }
        env_file = self._write_env(spec.workdir, env)  # not argv: the token must not show in `ps`
        entry, rest = _entrypoint(spec.run_argv)
        container = holder = tool_container = ""
        bridge = ExitStack()
        proxy: str | None = None
        try:
            holder = self._start_holder(suffix, {ws_volume: "/hold/workspace", out_volume: "/hold/out"})
            args = [
                "create", f"--name=rush-case-{suffix}", *self._isolation(spec.limits, network=spec.network.name),
                "--workdir", WORKSPACE, "--env-file", str(env_file), "--label", f"rush.attempt={spec.attempt_id}",
                *_mount_bind(request, REQUEST_PATH), *_mount_bind(spec.artifact.directory, HARNESS_DIR),
                *_mount_volume(out_volume, OUT_DIR), *_mount_volume(ws_volume, WORKSPACE),
                *self._resolver(spec), *entry, spec.profile.runtime_image, *rest,
            ]
            container = _checked(self._docker.run(args), "start_failed", "create case container").text()
            initial: dict[str, str] = {}
            if spec.fixtures is not None:
                initial = self._preload(holder, spec.fixtures)
            self._collector.session(container)
            tool_network = "none"
            if spec.tool is not None and spec.tool.egress_hosts:
                tool_network, proxy = bridge.enter_context(self._egress_bridge(spec.tool.egress_hosts, "tool"))
            if spec.tool is not None:
                tool_container = self._start_tool(spec, ws_volume, tool_network)
            handle = _DockerCase(self, spec, container, holder, (ws_volume, out_volume), initial, tool_container)
            handle.tool_proxy, handle.bridge = proxy, bridge
            if spec.tool is not None:
                self._tool_cases[spec.tool.name] = handle
            return handle
        except BaseException:
            if container:
                self._remove_container(container)
                self._collector.discard(container)
            if tool_container:
                self._remove_container(tool_container)
                self._collector.discard(tool_container)
            bridge.close()
            if holder:
                self._remove_container(holder)
            self._remove_volume(ws_volume)
            self._remove_volume(out_volume)
            raise
        finally:
            env_file.unlink(missing_ok=True)

    def _resolver(self, spec: CaseSpec) -> list[str]:
        """The public resolvers of an internet-access case: Docker's embedded DNS is not reachable from a gVisor sandbox."""
        if not spec.network.internet:
            return []
        resolv = spec.workdir / "resolv.conf"
        resolv.write_text("".join(f"nameserver {server}\n" for server in spec.network.dns))
        resolv.chmod(0o644)
        return _mount_bind(resolv, "/etc/resolv.conf")

    def _start_tool(self, spec: CaseSpec, ws_volume: str, network: str) -> str:
        """The idle tool container: no network but, when the plugin declares hosts, the egress proxy's; the case workspace at the harness's path, plugin and fixtures read-only."""
        tool = spec.tool
        assert tool is not None
        mounts = [*_mount_bind(tool.plugin_root, PLUGIN_DIR), *_mount_bind(self._require_uv(), UV_BIN)]
        if tool.fixtures is not None:
            mounts += _mount_bind(tool.fixtures, FIXTURES_DIR)
        args = [
            "create", f"--name={tool.name}", *self._isolation(spec.limits, network=network), "--workdir", PLUGIN_DIR,
            "--label", f"rush.attempt={spec.attempt_id}", "--label", "rush.role=tool", *mounts, *_mount_volume(ws_volume, WORKSPACE),
            "--entrypoint", "sleep", PLUGIN_PREP_IMAGE, "86400",  # the plugin's venv is only valid in its prep image, whatever the harness's toolchain
        ]
        container = _checked(self._docker.run(args), "start_failed", "create tool container").text()
        try:
            self._collector.session(container)
            _checked(self._docker.run(["start", container]), "start_failed", "start tool container")
        except BaseException:
            self._remove_container(container)
            self._collector.discard(container)
            raise
        return container

    def _meter(self, container: str) -> CpuMeter | None:
        """A started CPU meter on the container's cgroup, or None when the cgroup cannot be located or read."""
        pid = int(self._state(container).get("Pid") or 0)
        directory = cgroup_directory(pid, proc_root=self._proc_root, cgroup_root=self._cgroup_root) if pid else None
        if directory is None or read_cpu_stat(directory) is None:
            return None
        meter = CpuMeter(directory, self._cpu_interval_s)
        meter.start()
        return meter

    def _start_holder(self, suffix: str, volumes: Mapping[str, str]) -> str:
        """An idle, networkless container that keeps the sandbox's tmpfs volumes mounted.

        A tmpfs volume is unmounted, and its contents lost, when the last container using it stops; the
        holder outlives the sandbox so results and the workspace can still be copied out. Its memory fits the
        `/exec` cwd check (CWD_CHECK) running beside it, up to EXEC_THREADS Pythons at once.
        """
        mounts = [a for volume, path in volumes.items() for a in _mount_volume(volume, path)]
        args = [
            "create", f"--name=rush-hold-{suffix}", "--runtime=runc", "--network=none", "--read-only", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--user=65534:65534", "--memory=96m", "--pids-limit=8", "--log-driver=none",
            *mounts, "--entrypoint", "python", HOLDER_IMAGE, "-c", "import time; time.sleep(86400)",
        ]
        holder = _checked(self._docker.run(args), "start_failed", "create volume holder").text()
        try:
            _checked(self._docker.run(["start", holder]), "start_failed", "start volume holder")
        except SandboxError:
            self._remove_container(holder)
            raise
        return holder

    def _preload(self, container: str, fixtures: Path) -> dict[str, str]:
        try:
            data = tar_of_tree(fixtures)
            _checked(self._docker.run(["cp", "-", f"{container}:/hold/workspace"], stdin=data), "fixture_failed", "preload fixtures")
            return {
                p.relative_to(fixtures).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(fixtures.rglob("*"))
                if p.is_file()
            }
        except ArchiveError as error:
            raise SandboxError("fixture_failed", error.message) from error

    # -- shared plumbing -------------------------------------------------------------------------

    def _isolation(self, limits: Limits, *, network: str) -> list[str]:
        return [
            f"--runtime={self._runtime}", f"--network={network}", f"--user={UID}:{GID}", "--read-only", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", f"--cpus={limits.cpus}", f"--memory={limits.memory_bytes}",
            f"--memory-swap={limits.memory_bytes}", f"--pids-limit={limits.pids}", "--log-driver=none",
            "--tmpfs", f"/tmp:rw,noexec,nosuid,size={limits.tmp_bytes}",
        ]

    def _create_volume(self, name: str, size: int) -> str:
        args = [
            "volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs",
            "--opt", f"o=size={size},uid={UID},gid={GID},mode=0755", name,
        ]
        _checked(self._docker.run(args), "start_failed", f"create volume {name}")
        return name

    def _remove_volume(self, name: str) -> None:
        self._docker.run(["volume", "rm", "-f", name])

    def _remove_container(self, container: str) -> None:
        self._docker.run(["rm", "-f", "-v", container])

    @staticmethod
    def _write_env(directory: Path, env: Mapping[str, str]) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix="env-", dir=directory)
        with os.fdopen(descriptor, "w") as handle:  # mkstemp creates it 0600
            for key, value in env.items():
                if "\n" in value or "\n" in key:
                    raise SandboxError("start_failed", f"environment value for {key} contains a newline")
                handle.write(f"{key}={value}\n")
        return Path(name)

    def _state(self, container: str) -> dict:
        result = _checked(self._docker.run(["inspect", "--format", "{{json .State}}", container]), "inspect_failed", "inspect container")
        return json.loads(result.stdout)

    def _copy_out(self, container: str, path: str, limits: Limits, workdir: Path) -> tuple[Extracted, Path]:
        result = _checked(
            self._docker.run(["cp", f"{container}:{path}", "-"], capture_bytes=limits.workspace_bytes + limits.workspace_files * TAR_ENTRY_OVERHEAD + (8 << 20)),
            "snapshot_failed", f"copy {path} out",
        )
        if result.stdout_truncated:
            raise SandboxError("snapshot_too_large", f"{path} exceeds the {limits.workspace_bytes} byte bound")
        destination = workdir / f"copy-{uuid.uuid4().hex[:8]}"
        try:
            extracted = extract_tar(
                result.stdout, destination, root_name=Path(path).name, max_files=limits.workspace_files, max_bytes=limits.workspace_bytes
            )
        except ArchiveError as error:
            shutil.rmtree(destination, ignore_errors=True)
            raise SandboxError(error.code, error.message) from error
        return extracted, destination


class _DockerCase:
    """One running case container."""

    def __init__(
        self, supervisor: DockerSandboxSupervisor, spec: CaseSpec, container: str, holder: str, volumes: tuple[str, str], initial: dict[str, str],
        tool_container: str,
    ) -> None:
        self._s = supervisor
        self.holder = holder
        self.spec = spec
        self._tool = tool_container  # empty when the case has no tools
        self._meters: dict[str, CpuMeter | None] = {}
        self._counters: list[dict[str, Any]] = []
        self._container = container
        self._volumes = volumes
        self._initial = initial
        self._thread: threading.Thread | None = None
        self._run_result: DockerResult | None = None
        self._timed_out = False
        self._launched_at = 0.0
        self._exited_at = 0.0
        self._outcome: CaseOutcome | None = None
        self._deadline = 0.0
        self._paused = False
        self._final: ProcessEvidence | None = None
        self._evidence_lock = threading.Lock()
        self.view_lock = threading.Lock()  # one workspace copy at a time (`ToolLauncher.workspace_view`)
        self._closing = threading.Event()
        self.tool_proxy: str | None = None  # the tool container's egress proxy URL, when it has declared hosts
        self.bridge = ExitStack()  # the proxy and its relay and network; closed with the case

    @property
    def container_id(self) -> str:
        return self._container

    def launch(self) -> None:
        limits = self.spec.limits
        self._launched_at = self._s._clock()
        self._deadline = self._launched_at + limits.wall_s
        self._thread = threading.Thread(target=self._run, name=f"case-{self._container[:12]}", daemon=True)
        self._thread.start()
        # Fail fast, and closed, when the runtime cannot start the sandbox (e.g. the collector is gone).
        while True:
            state = self._s._state(self._container)
            if state.get("Running") or not self._thread.is_alive():
                break
            time.sleep(0.02)
        if not self._thread.is_alive() and state.get("StartedAt", "").startswith("0001"):
            raise SandboxError("start_failed", f"case sandbox did not start: {state.get('Error') or self._run_result.error_text()}")  # type: ignore[union-attr]
        self._meters[self._container] = self._s._meter(self._container)
        if self._tool:
            self._meters[self._tool] = self._s._meter(self._tool)

    def _run(self) -> None:
        limits = self.spec.limits
        self._run_result = self._s._docker.run(
            ["start", "-a", self._container], timeout_s=limits.wall_s, capture_bytes=limits.output_bytes
        )
        self._exited_at = self._s._clock()
        if self._run_result.timed_out:
            self._timed_out = True
            self._s._docker.run(["kill", self._container])  # the whole sandbox, descendants included

    def wait(self) -> CaseOutcome:
        if self._outcome is not None:
            return self._outcome
        assert self._thread is not None
        self._thread.join()
        result = self._run_result
        assert result is not None
        try:
            state = self._s._state(self._container)
        except SandboxError as error:
            if self._closing.is_set():  # close() removed the sandbox while this woke on its kill
                raise SandboxError("closed", "the case was closed while it was awaited") from error
            raise
        exit_code = state.get("ExitCode", result.returncode)
        evidence = self.evidence()  # the sandbox has exited, so its connection is closed and the journal is whole
        root = evidence.root()
        root_exit = root.exit if root is not None else None
        termination = termination_from_root_exit(root_exit, exit_code, oom_killed=bool(state.get("OOMKilled")), timed_out=self._timed_out)
        if root_exit is None:
            self._final = replace(evidence, complete=False, loss_reasons=(*evidence.loss_reasons, "root_exit_missing"))
        self._outcome = CaseOutcome(
            termination, self._launched_at, self._exited_at, result.stdout, result.stderr, result.stdout_truncated, result.stderr_truncated
        )
        return self._outcome

    def exec_in_case(self, argv: Sequence[str], cwd: str, timeout_ms: int, limits: Limits) -> ExecOutcome:
        validate_argv(list(argv))
        remaining = self._deadline - self._s._clock()
        if remaining <= 0:
            raise SandboxError("case_over", "the case deadline has passed")
        absolute = self._resolve_cwd(cwd)
        timeout_s = min(timeout_ms / 1000, remaining)
        launch_id = uuid.uuid4().hex
        # `timeout` runs the member's argv in its own process group and signals the group: TERM at the
        # deadline, KILL after the grace. `env -u RUSH_LAUNCH_<id>` puts the supervisor's marker into an observed
        # `execve` and execs the member in that same process, so the process evidence names its command exactly.
        # The recorded command stays the member's argv.
        wrapped = ["timeout", f"--kill-after={EXEC_KILL_GRACE_S}", "--signal=TERM", f"{timeout_s:.3f}", *launch_argv(launch_id, argv)]
        # gVisor can complete a blocking write to the exec's output pipe only in part, and an unbuffered Python
        # (the runtime's PYTHONUNBUFFERED) drops the rest of a large write without error: an empty value turns that off for the command.
        args = ["exec", f"--user={UID}:{GID}", "--workdir", absolute, "-e", "PYTHONUNBUFFERED=", self._container, *wrapped]
        launched, launched_wall = self._s._clock(), self._s._wall_clock_ns()
        result = self._s._docker.run(args, timeout_s=timeout_s + EXEC_KILL_GRACE_S + 10, capture_bytes=limits.output_bytes)
        returned, returned_wall = self._s._clock(), self._s._wall_clock_ns()
        # 124 (TERM) and 137 (KILL) are `timeout`'s codes, but a command can exit with them itself: it
        # timed out only when the deadline actually elapsed on the worker clock.
        deadline_elapsed = returned - launched >= timeout_s
        if result.timed_out or (deadline_elapsed and result.returncode in (124, 137)):
            termination = Termination(TerminationKind.TIMED_OUT, None, None)
        elif result.returncode in (125, 126, 127) and not result.stdout and result.stderr.startswith(b"OCI runtime exec failed"):
            raise SandboxError("exec_failed", result.error_text())
        else:
            termination = map_termination(result.returncode, oom_killed=False, timed_out=False)
            if termination.kind is TerminationKind.NONZERO_EXIT:
                termination = self._signaled_by_evidence(launch_id, termination)
        return ExecOutcome(
            launch_id, tuple(argv), cwd, absolute, termination, launched, returned, launched_wall, returned_wall,
            result.stdout, result.stderr, result.stdout_truncated, result.stderr_truncated,
        )

    def _signaled_by_evidence(self, launch_id: str, raw: Termination) -> Termination:
        """`timeout` reports a command killed by a signal as 128 + n, which a plain exit can also be: only the member
        process's task exit tells them apart. Without it within the wait the raw exit code stands, as for the harness."""
        deadline = time.monotonic() + EXEC_EVIDENCE_WAIT_S
        while True:
            evidence = self._s._collector.snapshot(self._container)
            identity = next((i for i, found in launched_processes(evidence).items() if found == launch_id), None)
            member = next((p for p in evidence.lifetimes() if p.identity == identity), None)
            if member is not None and member.exit is not None:
                if member.exit.exit_signal is not None:
                    return Termination(TerminationKind.SIGNALED, None, member.exit.exit_signal)
                return raw
            if time.monotonic() >= deadline:
                return raw
            time.sleep(0.02)

    def _resolve_cwd(self, cwd: str) -> str:
        if cwd == ".":
            return WORKSPACE
        if (problem := path_problem(cwd)) is not None:
            raise ContractError("invalid_cwd", f"cwd {cwd!r}: {problem}")
        # One bounded call in the holder, which mounts the same volume: every component of the path is checked there.
        check = self._s._docker.run(["exec", self.holder, "python", "-c", CWD_CHECK, "/hold/workspace", cwd], timeout_s=CWD_CHECK_TIMEOUT_S, capture_bytes=4096)
        if check.timed_out or check.returncode not in (0, CWD_MISSING, CWD_LINK):
            raise SandboxError("exec_failed", f"cwd {cwd!r} could not be checked: {check.error_text()}")
        if check.returncode == CWD_MISSING:
            raise ContractError("invalid_cwd", f"cwd {cwd!r} does not exist in the workspace")
        if check.returncode == CWD_LINK:
            raise ContractError("invalid_cwd", f"cwd {cwd!r} passes through a link")
        return f"{WORKSPACE}/{cwd}"

    def stop_and_drain(self) -> WorkspaceSnapshot:
        self._read_counters()
        if self._tool and self._s._state(self._tool).get("Running"):
            _checked(self._s._docker.run(["kill", self._tool]), "freeze_failed", "stop the tool container")
        state = self._s._state(self._container)
        if state.get("Running") and not state.get("Paused"):
            _checked(self._s._docker.run(["pause", self._container]), "freeze_failed", "freeze the sandbox")
            self._paused = True
        extracted, directory = self._s._copy_out(self.holder, "/hold/workspace", self.spec.limits, self.spec.workdir)
        files = extracted.files
        added = tuple(sorted(set(files) - set(self._initial)))
        deleted = tuple(sorted(set(self._initial) - set(files)))
        modified = tuple(sorted(p for p in files if p in self._initial and files[p] != self._initial[p]))
        return WorkspaceSnapshot(directory, files, added, modified, deleted, extracted.skipped, extracted.total_bytes)

    def _read_counters(self) -> None:
        """Reads every container's CPU once more while it is alive, then keeps the last reading of each.

        All or nothing: one unreadable container leaves no counters, so the projection reports CPU as unknown instead
        of a total that leaves a container out.
        """
        containers = {self._container: "harness", **({self._tool: "tool"} if self._tool else {})}
        counters: list[dict[str, Any]] = []
        for container, role in containers.items():
            meter = self._meters.get(container)
            if meter is None:
                counters = []
                break
            meter.sample()  # a live container is read exactly; an exited one's cgroup is gone and the last reading stands
            reading = meter.stop()
            if reading is None:
                counters = []
                break
            counters.append({"identity": {"role": role, "container": container}, "user_ns": reading[0], "system_ns": reading[1]})
        for meter in self._meters.values():
            if meter is not None:
                meter.stop()
        self._counters = counters

    def cpu_counters(self) -> list[dict[str, Any]]:
        return list(self._counters)

    def read_result(self) -> bytes:
        extracted, directory = self._s._copy_out(self.holder, "/hold/out", self.spec.limits, self.spec.workdir)
        try:
            # Only result.json is accepted: anything else in the directory is ignored and never read.
            if RESULT_NAME not in extracted.files:
                raise SandboxError("missing_result", "the harness wrote no regular result.json")
            return read_result_file(directory, RESULT_NAME, MAX_RESULT_BYTES)
        finally:
            shutil.rmtree(directory, ignore_errors=True)

    def evidence(self) -> ProcessEvidence:
        with self._evidence_lock:  # wait() and close() both take it, from different threads
            if self._final is None:
                self._final = self._s._collector.finish(self._container)
                self._s._collector.discard(self._container)
            return self._final

    def abort(self) -> None:
        """Removes everything a case that never started left behind; its process evidence is not read."""
        self._stop_meters()
        self._remove_all()
        self._s._collector.discard(self._container)

    def _stop_meters(self) -> None:
        for meter in self._meters.values():
            if meter is not None:
                meter.stop()

    def _remove_all(self) -> None:
        self._s._remove_container(self._container)
        if self._tool:
            self._s._remove_container(self._tool)
            self._s._collector.discard(self._tool)
        self.bridge.close()
        if self.spec.tool is not None:
            self._s._tool_cases.pop(self.spec.tool.name, None)
        self._s._remove_container(self.holder)
        for volume in self._volumes:
            self._s._remove_volume(volume)

    def close(self) -> None:
        self._closing.set()
        if self._thread is None:  # never launched: there is no sandbox connection or evidence to wait for
            self.abort()
            return
        if self._paused:
            self._s._docker.run(["unpause", self._container])
        self._s._docker.run(["kill", self._container])
        if self._tool:
            self._s._docker.run(["kill", self._tool])
        self._stop_meters()
        if self._thread is not None:
            self._thread.join(timeout=30)
        self._remove_all()
        if self._final is None:
            # The sandbox is gone, so its connection has closed: take the evidence now, while the journal
            # still exists, so a caller can read it after close().
            try:
                self.evidence()
            except CollectorError:
                self._s._collector.discard(self._container)
