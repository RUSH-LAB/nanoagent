"""Linux integration tests: the real supervisor, `runsc-rush` and the collector, inside the gVisor VM.

    limactl shell gvisor-dev -- bash deploy/gvisor/vm-test.sh test/uploaded/test_sandbox_gvisor.py

Needs Docker with the `runsc-rush` runtime (`sudo python3 deploy/gvisor/setup.py`) and the
collector socket path it was set up with (RUSH_SECCHECK_SOCKET).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import pytest
from test_toolchains import make_wheel

from nanoagent.plugin.install import INSTALL_HOSTS
from nanoagent.uploaded.collector import CollectorError, ProcessEventKind, SeccheckCollector, launched_processes
from nanoagent.uploaded.contract import HarnessManifest
from nanoagent.uploaded.dockercli import CliDockerRunner
from nanoagent.uploaded.sandbox import (
    BuildSpec,
    CaseSpec,
    DockerSandboxSupervisor,
    Egress,
    Limits,
    SandboxError,
    TerminationKind,
)
from nanoagent.uploaded.toolchains import resolve_dependencies, toolchain

pytestmark = pytest.mark.gvisor

SOCKET = os.environ.get("RUSH_SECCHECK_SOCKET", "/run/rush-gvisor/seccheck.sock")
PROFILE = toolchain("python-3")
SCRATCH = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker")) / "scratch"

HARNESS = r'''
import errno, json, os, signal, socket, subprocess, sys, time, urllib.request

request = json.load(open(os.environ["RUSH_REQUEST"]))
mode = request["mode"]


def errname(action):
    try:
        action()
        return "ok"
    except OSError as error:
        return errno.errorcode.get(error.errno, str(error.errno))


def write_result(payload):
    tmp = os.environ["RUSH_RESULT"] + ".tmp"
    with open(tmp, "w") as handle:
        json.dump(payload, handle)
    os.rename(tmp, os.environ["RUSH_RESULT"])


if mode == "full":
    open(os.path.join(os.environ["RUSH_WORKSPACE"], "created.txt"), "w").write("made by harness")
    with open(os.path.join(os.environ["RUSH_WORKSPACE"], "seed.txt"), "a") as seed:
        seed.write(" edited")
    child = subprocess.run(["/bin/sh", "-c", "exit 23"]).returncode

    def egress():
        sock = socket.socket()
        sock.settimeout(3)
        sock.connect(("1.1.1.1", 443))

    def service():
        for _ in range(100):
            try:
                return urllib.request.urlopen(request["stub_url"], timeout=2).status
            except OSError:
                time.sleep(0.1)
        return "unreachable"

    def too_big():
        with open(os.path.join(os.environ["RUSH_WORKSPACE"], "big.bin"), "wb") as big:
            big.write(b"x" * (2 << 20))

    write_result({
        "protocol": "rush.harness.v1", "status": "answered",
        "answer": {
            "uid": os.getuid(),
            "root_write": errname(lambda: open("/rootfile", "w")),
            "harness_write": errname(lambda: open("/harness/x", "w")),
            "request_write": errname(lambda: open(os.environ["RUSH_REQUEST"], "w")),
            "egress": errname(egress),
            "service": service(),
            "workspace_full": errname(too_big),
            "child": child,
            "cwd": os.getcwd(),
            "env": sorted(k for k in os.environ if k.startswith("RUSH_")),
            "argv": sys.argv,
        },
    })
elif mode == "deps":
    sys.path.insert(0, "/harness/lib")
    import demo_pkg
    write_result({"protocol": "rush.harness.v1", "status": "answered", "answer": {"x": demo_pkg.X}})
elif mode == "net":
    from concurrent.futures import ThreadPoolExecutor

    def reach(target):
        host, port = target
        try:
            sock = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET)
            sock.settimeout(4)
            sock.connect((host, port))
            sock.close()
            return "ok"
        except OSError as error:
            return errno.errorcode.get(error.errno) or type(error).__name__

    def https():
        try:
            return urllib.request.urlopen("https://example.com/", timeout=20).status
        except Exception as error:
            return type(error).__name__ + ": " + str(error)

    targets = [tuple(target) for target in request["targets"]]
    with ThreadPoolExecutor(16) as pool:
        results = list(pool.map(reach, targets))
    write_result({
        "protocol": "rush.harness.v1", "status": "answered",
        "answer": {"reach": {f"{host}:{port}": result for (host, port), result in zip(targets, results)}, "https": https() if request["https"] else None,
                   "resolv": open("/etc/resolv.conf").read()},
    })
elif mode == "exit3":
    sys.exit(3)
elif mode == "exit137":
    sys.exit(137)
elif mode == "kill9":
    os.kill(os.getpid(), signal.SIGKILL)
elif mode == "segv":
    os.kill(os.getpid(), signal.SIGSEGV)
elif mode == "noresult":
    pass
elif mode == "sleep":
    time.sleep(120)
elif mode == "writer":
    with open(os.path.join(os.environ["RUSH_WORKSPACE"], "log"), "a", buffering=1) as log:
        while True:
            log.write("tick\n")
            time.sleep(0.02)
'''


@pytest.fixture(scope="module")
def artifact_dir(tmp_path_factory):
    """Builds the probe harness once, with its own collector, and keeps the artifact on disk."""
    root = SCRATCH / f"it-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True)
    collector = SeccheckCollector(SOCKET)
    collector.start()
    try:
        supervisor = DockerSandboxSupervisor(collector=collector)
        supervisor.startup(PROFILE)
        source = root / "source"
        source.mkdir()
        (source / "main.py").write_text(HARNESS)
        wheel_index = root / "index"
        wheel_index.mkdir()
        _, digest = make_wheel(wheel_index)
        (source / "requirements.txt").write_text(f"demo-pkg==1.0 --hash=sha256:{digest}\n")
        closure = resolve_dependencies(PROFILE, source, ("requirements.txt",), root / "deps", index_url=str(wheel_index))
        manifest = HarnessManifest(
            "h", "1", ("chat_completions",), "python-3", ("requirements.txt",),
            ("sh", "-c", "cp main.py /build-out/main.py && python -m pip install --quiet --no-index --find-links /deps --target /build-out/lib demo-pkg==1.0"),
            ("main.py", "lib"), ("python", "/harness/main.py"),
        )
        artifact = supervisor.build(BuildSpec("build1", PROFILE, manifest, source, closure, root / "build-work", Limits(wall_s=180)))
        assert (artifact.directory / "lib" / "demo_pkg" / "__init__.py").read_text() == "X = 1\n"
    except BaseException:
        shutil.rmtree(root, ignore_errors=True)
        raise
    finally:
        collector.stop()  # the socket is single-owner: each test starts its own collector
    yield artifact
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def env(artifact_dir):
    collector = SeccheckCollector(SOCKET)
    collector.start()
    supervisor = DockerSandboxSupervisor(collector=collector, egress=Egress())
    supervisor.startup(PROFILE)
    created: list = []
    work = SCRATCH / f"case-{uuid.uuid4().hex[:8]}"
    work.mkdir(parents=True)

    class Env:
        pass

    e = Env()
    e.collector, e.supervisor, e.artifact, e.work, e.created = collector, supervisor, artifact_dir, work, created
    e.networks = []

    def start(mode, *, limits=Limits(wall_s=60, workspace_bytes=1 << 20), fixtures=None, network=None, argv=None, internet=False, **request):
        attempt = uuid.uuid4().hex[:10]
        net = network or supervisor.create_network(attempt, internet=internet)
        e.networks.append(net)
        spec = CaseSpec(
            attempt_id=attempt, profile=PROFILE, run_argv=argv or ("python", "/harness/main.py"), artifact=artifact_dir,
            request_json=json.dumps({"mode": mode, **request}).encode(), attempt_token="tok-" + attempt, network=net,
            workdir=work / attempt, fixtures=fixtures, limits=limits,
        )
        handle = supervisor.start_case(spec)
        created.append(handle)
        return handle

    e.start = start
    yield e
    for handle in created:
        handle.close()
    for net in e.networks:
        subprocess.run(["docker", "network", "rm", net.name], capture_output=True)
    collector.stop()
    shutil.rmtree(work, ignore_errors=True)


def stub_service(network_name: str) -> str:
    name = f"rush-stub-{uuid.uuid4().hex[:8]}"
    subprocess.run(
        ["docker", "run", "-d", "--runtime=runc", "--name", name, "--network", network_name, "--network-alias", "stub",
         PROFILE.runtime_image, "python", "-m", "http.server", "8080", "--directory", "/tmp"],
        check=True, capture_output=True,
    )
    return name


def test_startup_self_test_observes_a_trivial_containers_exec_and_exit(env):
    # the fixture already ran it; run it again explicitly for its evidence
    evidence = env.supervisor.startup(PROFILE)
    assert evidence.complete


def test_case_runs_fully_isolated_and_the_collector_joins_exec_child_and_exits(env):
    fixtures = env.work / "fixtures"
    fixtures.mkdir()
    (fixtures / "seed.txt").write_text("seed")
    attempt_net = env.supervisor.create_network("net-" + uuid.uuid4().hex[:6])
    stub = stub_service(attempt_net.name)
    try:
        handle = env.start("full", fixtures=fixtures, network=attempt_net, stub_url=f"http://{attempt_net.address_of(stub)}:8080/")
        outcome = handle.wait()
        assert outcome.termination.kind is TerminationKind.EXITED, outcome.stderr
        assert outcome.launched_at <= outcome.exited_at

        answer = json.loads(handle.read_result())["answer"]
        assert answer["uid"] == 10001
        assert answer["root_write"] in ("EROFS", "EACCES"), "read-only root denied"
        assert answer["harness_write"] in ("EROFS", "EACCES") and answer["request_write"] in ("EROFS", "EACCES")
        assert answer["egress"] == "ENETUNREACH", "direct egress fails"
        assert answer["service"] == 200, "the attached service is reachable"
        assert answer["workspace_full"] == "ENOSPC", "the workspace is size bound"
        assert answer["child"] == 23 and answer["cwd"] == "/rush/workspace" and answer["argv"] == ["/harness/main.py"]
        assert answer["env"] == ["RUSH_ATTEMPT_TOKEN", "RUSH_REQUEST", "RUSH_RESULT", "RUSH_WORKSPACE"]

        snapshot = handle.stop_and_drain()
        assert "created.txt" in snapshot.added and snapshot.modified == ("seed.txt",)
        assert (snapshot.directory / "created.txt").read_text() == "made by harness"
        assert (snapshot.directory / "seed.txt").read_text() == "seed edited"

        evidence = handle.evidence()
        assert evidence.complete, evidence.loss_reasons
        by_argv = {p.argv: p for p in evidence.lifetimes()}
        harness = by_argv[("python", "/harness/main.py")]
        child = by_argv[("/bin/sh", "-c", "exit 23")]
        assert child.parent == harness.identity, "lineage joined by group id and start time"
        assert child.exit.exit_code == 23 and harness.exit.exit_code == 0
        assert child.identity[2] != harness.identity[2]
        assert evidence.malformed == 0 and evidence.dropped == 0
    finally:
        subprocess.run(["docker", "rm", "-f", stub], capture_output=True)


def test_dependency_closure_is_installed_offline_and_importable_at_run(env):
    handle = env.start("deps")
    assert handle.wait().termination.kind is TerminationKind.EXITED
    assert json.loads(handle.read_result())["answer"] == {"x": 1}


def test_nonzero_exit_and_signals_are_distinguished(env):
    nonzero = env.start("exit3").wait().termination
    assert (nonzero.kind, nonzero.exit_code) == (TerminationKind.NONZERO_EXIT, 3)
    deliberate = env.start("exit137").wait().termination
    assert (deliberate.kind, deliberate.exit_code, deliberate.signal) == (TerminationKind.NONZERO_EXIT, 137, None), "exit 137 is not SIGKILL"
    killed = env.start("kill9").wait().termination
    assert (killed.kind, killed.signal) == (TerminationKind.SIGNALED, 9)
    segv = env.start("segv").wait().termination
    assert (segv.kind, segv.signal) == (TerminationKind.SIGNALED, 11)


def test_missing_result_is_reported_specifically(env):
    handle = env.start("noresult")
    assert handle.wait().termination.kind is TerminationKind.EXITED
    with pytest.raises(Exception) as caught:
        handle.read_result()
    assert getattr(caught.value, "code", "") == "missing_result"


def test_wall_budget_kills_the_whole_sandbox(env):
    started = time.monotonic()
    handle = env.start("sleep", limits=Limits(wall_s=3))
    outcome = handle.wait()
    assert outcome.termination.kind is TerminationKind.TIMED_OUT
    assert time.monotonic() - started < 30
    running = subprocess.run(["docker", "inspect", "--format", "{{.State.Running}}", handle.container_id], capture_output=True, text=True)
    assert running.stdout.strip() == "false"


def test_managed_exec_captures_bounded_streams_and_joins_process_evidence(env):
    handle = env.start("sleep")
    outcome = handle.exec_in_case(["/bin/sh", "-c", "echo out; echo err >&2; exit 5"], ".", 20_000, Limits())
    assert (outcome.stdout, outcome.stderr) == (b"out\n", b"err\n")
    assert (outcome.termination.kind, outcome.termination.exit_code) == (TerminationKind.NONZERO_EXIT, 5)
    truncated = handle.exec_in_case(["/bin/sh", "-c", "echo 0123456789"], ".", 20_000, Limits(output_bytes=4))
    assert truncated.stdout == b"0123" and truncated.stdout_truncated
    started = time.monotonic()
    slow = handle.exec_in_case(["/bin/sleep", "30"], ".", 500, Limits())
    assert slow.termination.kind is TerminationKind.TIMED_OUT and time.monotonic() - started < 15
    scan = "import os;print(sum(1 for p in os.listdir('/proc') if p.isdigit() and open(f'/proc/{p}/cmdline','rb').read().startswith(b'/bin/sleep')))"
    gone = handle.exec_in_case(["python", "-c", scan], ".", 20_000, Limits())
    assert gone.stdout.strip() == b"0", "the timed-out command is gone from the sandbox before the next exec"
    handle.stop_and_drain()
    handle.close()
    evidence = handle.evidence()
    by_launch = {launch_id: identity for identity, launch_id in launched_processes(evidence).items()}
    lifetimes = {p.identity: p for p in evidence.lifetimes()}
    member = lifetimes[by_launch[outcome.launch_id]]
    assert member.argv == ("/bin/sh", "-c", "echo out; echo err >&2; exit 5") and member.exit is not None and member.exit.exit_code == 5
    assert member.is_exec_session and member.parent is not None and lifetimes[member.parent].is_exec_session, "a child of the exec-session root"
    timed = lifetimes[by_launch[slow.launch_id]]
    assert timed.argv == ("/bin/sleep", "30") and timed.exit is not None and timed.exit.exit_signal == 15


def test_managed_exec_reports_a_signal_only_when_the_member_died_by_one(env):
    handle = env.start("sleep")
    killed = handle.exec_in_case(["/bin/sh", "-c", "kill -9 $$"], ".", 20_000, Limits())
    assert (killed.termination.kind, killed.termination.exit_code, killed.termination.signal) == (TerminationKind.SIGNALED, None, 9)
    plain = handle.exec_in_case(["/bin/sh", "-c", "exit 137"], ".", 20_000, Limits())
    assert (plain.termination.kind, plain.termination.exit_code, plain.termination.signal) == (TerminationKind.NONZERO_EXIT, 137, None)


def test_managed_exec_captures_output_past_the_bound_at_the_bound(env):
    handle = env.start("sleep")
    outcome = handle.exec_in_case(
        ["python", "-c", "import sys; sys.stdout.write('x' * 3000000); sys.stderr.write('e' * 3000000)"], ".", 60_000, Limits(),
    )
    assert (outcome.termination.kind, outcome.termination.exit_code) == (TerminationKind.EXITED, 0)
    assert (len(outcome.stdout), len(outcome.stderr)) == (1 << 20, 1 << 20)
    assert outcome.stdout_truncated and outcome.stderr_truncated


def test_managed_exec_rejects_cwd_through_a_link_and_runs_in_a_workspace_subdir(env):
    handle = env.start("sleep")
    handle.exec_in_case(["/bin/sh", "-c", "mkdir sub && ln -s /etc evil"], ".", 20_000, Limits())
    ok = handle.exec_in_case(["/bin/pwd"], "sub", 20_000, Limits())
    assert ok.stdout == b"/rush/workspace/sub\n"
    with pytest.raises(Exception) as caught:
        handle.exec_in_case(["/bin/pwd"], "evil", 20_000, Limits())
    assert getattr(caught.value, "code", "") == "invalid_cwd"
    with pytest.raises(Exception) as through:
        handle.exec_in_case(["/bin/pwd"], "evil/sub", 20_000, Limits())
    assert getattr(through.value, "code", "") == "invalid_cwd"


PROBE_URLS = r'''
import json, sys, urllib.request
out = {}
for url in sys.argv[1:]:
    try:
        out[url] = urllib.request.urlopen(url, timeout=20).status
    except Exception as error:
        out[url] = type(error).__name__ + ": " + str(error)
print(json.dumps(out))
'''


def test_plugin_prep_network_reaches_only_the_install_hosts(env):
    def probe(network: str, *args: str, proxy: str | None = None) -> dict:
        proxied = ["-e", f"HTTPS_PROXY={proxy}"] if proxy else []
        run = subprocess.run(
            ["docker", "run", "--rm", "--runtime=runc", f"--network={network}", *proxied, "--entrypoint", "python", PROFILE.runtime_image, "-c", PROBE_URLS, *args],
            capture_output=True, text=True, timeout=120, check=True,
        )
        return json.loads(run.stdout)

    with env.supervisor._egress_bridge(INSTALL_HOSTS, "prep") as (network, proxy):
        through = probe(network, "https://pypi.org/simple/", "https://example.com/", "http://pypi.org/", proxy=proxy)
        assert through["https://pypi.org/simple/"] == 200, "an install host is tunnelled"
        assert "403" in through["https://example.com/"], "another host is refused by the allowlist"
        assert not isinstance(through["http://pypi.org/"], int), "plain HTTP is not proxied"
        direct = probe(network, "https://pypi.org/simple/", "https://example.com/")
        assert not any(isinstance(status, int) for status in direct.values()), "no route out except through the proxy"
    assert subprocess.run(["docker", "network", "inspect", network], capture_output=True).returncode != 0, "the prep network is removed"


def test_stop_and_drain_freezes_every_writer_before_the_snapshot(env):
    handle = env.start("writer")
    time.sleep(1.5)
    first = handle.stop_and_drain()
    time.sleep(1.0)
    second = handle.stop_and_drain()
    assert first.files["log"] == second.files["log"], "nothing wrote between the two snapshots"
    assert (first.directory / "log").stat().st_size > 0


def test_stopping_the_collector_mid_case_marks_evidence_incomplete(env):
    handle = env.start("sleep")
    env.collector.stop()
    handle.close()
    evidence = handle.evidence()
    assert not evidence.complete and "collector_stopped" in evidence.loss_reasons
    assert any(e.kind is ProcessEventKind.CONTAINER_START for e in evidence.events), "what was observed stays available"


def test_runtime_refuses_to_start_a_container_when_the_sink_socket_is_absent():
    docker = CliDockerRunner()
    created = docker.run(["create", "--runtime=runsc-rush", "--network=none", PROFILE.runtime_image, "/bin/true"])
    assert created.returncode == 0
    container = created.text()
    try:
        started = docker.run(["start", container])
        assert started.returncode != 0
        assert "seccheck.sock" in started.error_text()
        state = json.loads(docker.run(["inspect", "--format", "{{json .State}}", container]).stdout)
        assert state["StartedAt"].startswith("0001"), "the container never ran"
    finally:
        docker.run(["rm", "-f", container])


def test_supervisor_refuses_member_source_without_a_listening_collector(tmp_path):
    collector = SeccheckCollector(tmp_path / "unused.sock")
    supervisor = DockerSandboxSupervisor(collector=collector)
    with pytest.raises(SandboxError) as caught:
        supervisor.startup(PROFILE)
    assert caught.value.code == "collector_unhealthy"
    with pytest.raises(CollectorError):
        collector.session("x")


# -- internet access for the harness container (limits.internet_access) ----------------------------------------------------
#
# These need the host filter: `sudo bash deploy/gvisor/egress.sh` (vm-test.sh installs it when it can sudo).

PUBLIC = ("1.1.1.1", 443)
# One address in each blocked class; none is a host that exists, so the proof that the filter, not an absent host, is what
# stops them is the rule counters (below).
BLOCKED = {
    "10.0.0.0/8": ("10.255.255.254", 80),
    "172.16.0.0/12": ("172.31.255.254", 80),
    "192.168.0.0/16": ("192.168.255.254", 80),
    "100.64.0.0/10": ("100.64.0.1", 80),
    "169.254.0.0/16": ("169.254.169.254", 80),
    "224.0.0.0/4": ("224.0.0.251", 80),
}
LOOPBACK_AND_IPV6 = [("127.0.0.1", 8), ("0.0.0.1", 80), ("::1", 80), ("fd00::1", 80), ("fe80::1", 80)]


def host_addresses() -> list[str]:
    out = subprocess.run(["ip", "-4", "-o", "addr", "show"], capture_output=True, text=True, check=True).stdout
    return [line.split()[3].split("/")[0] for line in out.splitlines()]


def rule_counters() -> dict[str, int] | None:
    """Packets dropped per destination range by the RUSH-EGRESS chain and by the INPUT rule, or None without sudo."""
    run = lambda *args: subprocess.run(["sudo", "-n", "iptables", "-L", *args, "-v", "-n", "-x"], capture_output=True, text=True)  # noqa: E731
    chain, inbound = run("RUSH-EGRESS"), run("INPUT")
    if chain.returncode or inbound.returncode:
        return None
    counters: dict[str, int] = {}
    for line in chain.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 9 and fields[2] == "DROP":
            counters[fields[8]] = int(fields[0])
    for line in inbound.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 9 and fields[2] == "DROP" and fields[7] == Egress().subnet:
            counters["host"] = int(fields[0])
    return counters


def test_the_host_filter_is_proven_at_startup(env):
    env.supervisor.verify_egress()


def test_an_internet_harness_reaches_public_addresses_and_names_and_the_relay_but_no_private_class(env):
    import socket

    listener = socket.socket()
    listener.bind(("0.0.0.0", 0))
    listener.listen(8)
    listener.settimeout(0.2)
    port = listener.getsockname()[1]
    hosts = [(address, port) for address in host_addresses()]
    network = env.supervisor.create_network("egress-" + uuid.uuid4().hex[:6], internet=True)
    stub = stub_service(network.name)
    gateway = subprocess.run(
        ["docker", "network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network.name], capture_output=True, text=True, check=True
    ).stdout.strip()
    before = rule_counters()
    try:
        targets = [PUBLIC, *BLOCKED.values(), *LOOPBACK_AND_IPV6, *hosts, (gateway, port), (network.address_of(stub), 8080)]
        handle = env.start("net", network=network, targets=targets, https=True)
        assert handle.wait().termination.kind is TerminationKind.EXITED
        answer = json.loads(handle.read_result())["answer"]
        reach = answer["reach"]
        assert reach["1.1.1.1:443"] == "ok", "a public address is reachable"
        assert answer["https"] == 200, "a public name resolves (public resolvers) and serves TLS"
        assert reach[f"{network.address_of(stub)}:8080"] == "ok", "a service on the attempt network stays reachable"
        for klass, (host, target_port) in BLOCKED.items():
            assert reach[f"{host}:{target_port}"] != "ok", klass
        for host, target_port in LOOPBACK_AND_IPV6:
            assert reach[f"{host}:{target_port}"] != "ok", host
        for host, host_port in [*hosts, (gateway, port)]:
            assert reach[f"{host}:{host_port}"] != "ok", f"worker host address {host}"
        assert "nameserver 1.1.1.1" in answer["resolv"]
        with pytest.raises(OSError):
            listener.accept()
        after = rule_counters()
        if before is not None and after is not None:
            for klass in BLOCKED:
                if klass != "224.0.0.0/4":  # a TCP connect to a multicast address never leaves the sandbox's own stack
                    assert after[klass] > before[klass], f"the filter dropped traffic to {klass}"
            assert after["host"] > before["host"], "the filter dropped traffic to the worker host"
    finally:
        listener.close()
        subprocess.run(["docker", "rm", "-f", stub], capture_output=True)


def test_without_internet_access_the_harness_stays_isolated(env):
    handle = env.start("net", targets=[PUBLIC, BLOCKED["10.0.0.0/8"]], https=False, internet=False)
    assert handle.wait().termination.kind is TerminationKind.EXITED
    answer = json.loads(handle.read_result())["answer"]
    assert all(result != "ok" for result in answer["reach"].values()), answer["reach"]
    assert "nameserver 1.1.1.1" not in answer["resolv"]


def test_an_internet_network_is_carved_from_the_reserved_subnet_and_removed_with_the_case(env):
    import ipaddress

    network = env.supervisor.create_network("slice-" + uuid.uuid4().hex[:6], internet=True)
    inspect = subprocess.run(["docker", "network", "inspect", "--format", "{{(index .IPAM.Config 0).Subnet}} {{.Internal}}", network.name], capture_output=True, text=True, check=True).stdout.split()
    assert ipaddress.ip_network(inspect[0]).subnet_of(ipaddress.ip_network(Egress().subnet)) and inspect[1] == "false"
    network.remove()
    assert subprocess.run(["docker", "network", "inspect", network.name], capture_output=True).returncode != 0


def test_internet_access_without_a_configured_egress_subnet_is_refused(env):
    bare = DockerSandboxSupervisor(collector=env.collector)
    with pytest.raises(SandboxError, match="egress subnet"):
        bare.create_network("none-" + uuid.uuid4().hex[:6], internet=True)
