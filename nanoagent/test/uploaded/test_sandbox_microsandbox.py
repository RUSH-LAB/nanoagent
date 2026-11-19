"""Integration tests: the real supervisor, its microVMs and the strace evidence, on this machine.

    .venv/bin/python -m pytest -p no:cacheprovider -m microsandbox test/uploaded/test_sandbox_microsandbox.py

Needs what microsandbox needs (macOS on Apple silicon, or Linux with /dev/kvm) and the network, once, to pull the pinned
images and build the guest tools (cached under RUSH_WORKER_HOME, default ~/rush-worker).
"""

from __future__ import annotations

import http.server
import json
import os
import shutil
import socket
import threading
import time
import uuid
from pathlib import Path

import pytest
from test_toolchains import make_wheel

from nanoagent.plugin.egress import egress_port
from nanoagent.plugin.install import INSTALL_HOSTS
from nanoagent.uploaded.collector import ProcessEventKind, launched_processes
from nanoagent.uploaded.contract import HarnessManifest
from nanoagent.uploaded.sandbox import (
    GUEST_HOST,
    PLUGIN_PREP_IMAGE,
    BuildSpec,
    CaseSpec,
    Limits,
    MicrosandboxSupervisor,
    SandboxError,
    TerminationKind,
    _network,
)
from nanoagent.uploaded.toolchains import resolve_dependencies, toolchain

pytestmark = pytest.mark.microsandbox

PROFILE = toolchain("python-3")
HOME = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker"))
SCRATCH = HOME / "scratch"
TOOLS = HOME / "guest-tools"

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
    os.makedirs("/tmp/elsewhere", exist_ok=True)
    moved = subprocess.run(["/bin/sh", "-c", "cd /tmp/elsewhere && /bin/true"]).returncode

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
            "moved": moved,
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
        "answer": {"reach": {f"{host}:{port}": result for (host, port), result in zip(targets, results)}, "https": https() if request["https"] else None},
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
def supervisor():
    supervisor = MicrosandboxSupervisor(tools=TOOLS, internet=True, model_hosts=("api.openai.com",))
    supervisor.startup(PROFILE)
    return supervisor


@pytest.fixture(scope="module")
def artifact_dir(supervisor):
    """Builds the probe harness once and keeps the artifact on disk."""
    root = SCRATCH / f"it-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True)
    try:
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
    yield artifact
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def env(supervisor, artifact_dir):
    created: list = []
    work = SCRATCH / f"case-{uuid.uuid4().hex[:8]}"
    work.mkdir(parents=True)

    class Env:
        pass

    e = Env()
    e.supervisor, e.artifact, e.work, e.created = supervisor, artifact_dir, work, created

    def start(mode, *, limits=Limits(wall_s=60, workspace_bytes=1 << 20), fixtures=None, network=None, argv=None, internet=False, **request):
        attempt = uuid.uuid4().hex[:10]
        net = network or supervisor.create_network(attempt, internet=internet)
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
    shutil.rmtree(work, ignore_errors=True)


def stub_service() -> tuple[http.server.HTTPServer, int]:
    """A service on this host, as the relay serves an attempt's: loopback, on a free port."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), http.server.SimpleHTTPRequestHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def test_startup_self_test_observes_a_trivial_execs_exec_and_exit(supervisor):
    evidence = supervisor.startup(PROFILE)
    assert evidence.complete


def test_case_runs_fully_isolated_and_the_trace_joins_exec_child_and_exits(env):
    fixtures = env.work / "fixtures"
    fixtures.mkdir()
    (fixtures / "seed.txt").write_text("seed")
    server, port = stub_service()
    try:
        network = env.supervisor.create_network("net-" + uuid.uuid4().hex[:6])
        network.ports.append(port)
        handle = env.start("full", fixtures=fixtures, network=network, stub_url=f"http://{GUEST_HOST}:{port}/")
        outcome = handle.wait()
        assert outcome.termination.kind is TerminationKind.EXITED, outcome.stderr
        assert outcome.launched_at <= outcome.exited_at

        answer = json.loads(handle.read_result())["answer"]
        assert answer["uid"] == 10001
        assert answer["root_write"] in ("EROFS", "EACCES"), "the root is not the case user's"
        assert answer["harness_write"] in ("EROFS", "EACCES") and answer["request_write"] in ("EROFS", "EACCES")
        assert answer["egress"] != "ok", "direct egress fails"
        assert answer["service"] == 200, "the attempt's service is reachable"
        assert answer["workspace_full"] == "ENOSPC", "the workspace is size bound"
        assert answer["child"] == 23 and answer["moved"] == 0 and answer["cwd"] == "/rush/workspace" and answer["argv"] == ["/harness/main.py"]
        assert answer["env"] == ["RUSH_ATTEMPT_TOKEN", "RUSH_REQUEST", "RUSH_RESULT", "RUSH_WORKSPACE"]

        snapshot = handle.stop_and_drain()
        assert "created.txt" in snapshot.added and snapshot.modified == ("seed.txt",)
        assert (snapshot.directory / "created.txt").read_text() == "made by harness"
        assert (snapshot.directory / "seed.txt").read_text() == "seed edited"
        assert [c["identity"]["role"] for c in handle.cpu_counters()] == ["harness"] and handle.cpu_counters()[0]["user_ns"] > 0

        evidence = handle.evidence()
        assert evidence.complete, evidence.loss_reasons
        by_argv = {p.argv: p for p in evidence.lifetimes()}
        harness = by_argv[("python", "/harness/main.py")]
        child = by_argv[("/bin/sh", "-c", "exit 23")]
        assert child.parent == harness.identity, "lineage joined by group id and start time"
        assert child.exit.exit_code == 23 and harness.exit.exit_code == 0
        assert child.identity[2] != harness.identity[2]
        assert harness.cwd == "/rush/workspace" and by_argv[("/bin/true",)].cwd == "/tmp/elsewhere", "chdir is followed"
        assert evidence.malformed == 0 and evidence.dropped == 0
    finally:
        server.shutdown()


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


def test_wall_budget_kills_every_case_process(env):
    started = time.monotonic()
    handle = env.start("sleep", limits=Limits(wall_s=3))
    outcome = handle.wait()
    assert outcome.termination.kind is TerminationKind.TIMED_OUT
    assert time.monotonic() - started < 30
    harness = next(p for p in handle.evidence().lifetimes() if p.argv == ("python", "/harness/main.py"))
    assert harness.exit is not None and harness.exit.exit_signal == 9, "the harness was killed, and the tracer saw it"


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


def test_plugin_prep_network_reaches_only_the_install_hosts(supervisor):
    async def probe(ports, *urls, proxy=None):
        name = f"rush-probe-{uuid.uuid4().hex[:8]}"
        sandbox = await supervisor._create(name, PLUGIN_PREP_IMAGE, Limits(), _network(ports), {})
        try:
            out = await sandbox.exec("python", ["-c", PROBE_URLS, *urls], env={"HTTPS_PROXY": proxy} if proxy else {}, timeout=120)
            return json.loads(out.stdout_text)
        finally:
            await supervisor._destroy(sandbox)

    with egress_port(INSTALL_HOSTS) as port:
        proxy = f"http://{GUEST_HOST}:{port}"
        through = supervisor._loop.run(probe([port], "https://pypi.org/simple/", "https://example.com/", "http://pypi.org/", proxy=proxy))
        assert through["https://pypi.org/simple/"] == 200, "an install host is tunnelled"
        assert "403" in through["https://example.com/"], "another host is refused by the allowlist"
        assert not isinstance(through["http://pypi.org/"], int), "plain HTTP is not proxied"
        direct = supervisor._loop.run(probe([port], "https://pypi.org/simple/", "https://example.com/"))
        assert not any(isinstance(status, int) for status in direct.values()), "no route out except through the proxy"


def test_stop_and_drain_freezes_every_writer_before_the_snapshot(env):
    handle = env.start("writer")
    time.sleep(1.5)
    first = handle.stop_and_drain()
    time.sleep(1.0)
    second = handle.stop_and_drain()
    assert first.files["log"] == second.files["log"], "nothing wrote between the two snapshots"
    assert (first.directory / "log").stat().st_size > 0


def test_closing_a_running_case_keeps_what_the_tracer_saw(env):
    handle = env.start("sleep")
    handle.close()
    evidence = handle.evidence()
    root = evidence.root()
    assert root is not None and root.argv == ("python", "/harness/main.py")
    assert any(e.kind is ProcessEventKind.CONTAINER_START for e in evidence.events)
    assert root.exit is not None and root.exit.exit_signal == 9, "the harness was killed and its exit recorded"


def test_supervisor_refuses_member_source_before_its_self_test(tmp_path):
    bare = MicrosandboxSupervisor(tools=TOOLS)
    with pytest.raises(SandboxError) as caught:
        bare.build(BuildSpec("x", PROFILE, HarnessManifest("h", "1", ("chat_completions",), "python-3", (), ("true",), ("a",), ("true",)), tmp_path, None, tmp_path))  # type: ignore[arg-type]
    assert caught.value.code == "collector_unverified"


# -- internet access for the harness VM (limits.internet_access) -----------------------------------------------------------

PUBLIC = ("1.1.1.1", 443)
BLOCKED = {
    "10.0.0.0/8": ("10.255.255.254", 80),
    "172.16.0.0/12": ("172.31.255.254", 80),
    "192.168.0.0/16": ("192.168.255.254", 80),
    "100.64.0.0/10": ("100.64.0.1", 80),
    "169.254.0.0/16": ("169.254.169.254", 80),
    "224.0.0.0/4": ("224.0.0.251", 80),
}
LOOPBACK_AND_IPV6 = [("127.0.0.1", 8), ("0.0.0.1", 80), ("::1", 80), ("fd00::1", 80), ("fe80::1", 80)]


def test_the_egress_fence_is_proven_at_startup(supervisor):
    supervisor.verify_egress()


def test_an_internet_harness_reaches_public_addresses_and_its_service_but_no_private_class_nor_the_host(env):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)
    listener.settimeout(0.2)
    port = listener.getsockname()[1]
    server, service = stub_service()
    try:
        network = env.supervisor.create_network("egress-" + uuid.uuid4().hex[:6], internet=True)
        network.ports.append(service)
        targets = [PUBLIC, *BLOCKED.values(), *LOOPBACK_AND_IPV6, (GUEST_HOST, port), (GUEST_HOST, service)]
        handle = env.start("net", network=network, targets=targets, https=True)
        assert handle.wait().termination.kind is TerminationKind.EXITED
        answer = json.loads(handle.read_result())["answer"]
        reach = answer["reach"]
        assert reach["1.1.1.1:443"] == "ok", "a public address is reachable"
        assert answer["https"] == 200, "a public name resolves and serves TLS"
        assert reach[f"{GUEST_HOST}:{service}"] == "ok", "the attempt's service stays reachable"
        for klass, (host, target_port) in BLOCKED.items():
            assert reach[f"{host}:{target_port}"] != "ok", klass
        for host, target_port in LOOPBACK_AND_IPV6:
            assert reach[f"{host}:{target_port}"] != "ok", host
        assert reach[f"{GUEST_HOST}:{port}"] != "ok", "another port of the worker host"
        with pytest.raises(OSError):
            listener.accept()
    finally:
        listener.close()
        server.shutdown()


def test_without_internet_access_the_harness_stays_isolated(env):
    handle = env.start("net", targets=[PUBLIC, BLOCKED["10.0.0.0/8"]], https=True, internet=False)
    assert handle.wait().termination.kind is TerminationKind.EXITED
    answer = json.loads(handle.read_result())["answer"]
    assert all(result != "ok" for result in answer["reach"].values()), answer["reach"]
    assert answer["https"] != 200


def test_internet_access_on_a_worker_without_it_is_refused():
    bare = MicrosandboxSupervisor(tools=TOOLS)
    with pytest.raises(SandboxError, match="not enabled"):
        bare.create_network("none-" + uuid.uuid4().hex[:6], internet=True)
