"""Linux integration tests: brokered tools in their own gVisor container, sharing the case workspace with the harness.

    limactl shell gvisor-dev -- bash deploy/gvisor/vm-test.sh test/uploaded/test_tool_sandbox_gvisor.py

The `workspace-tools` fixture plugin is prepared inside the pinned prep image, then its MCP server runs in the tool
container through `docker exec -i`. A small harness polls the shared workspace volume.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

import pytest

from nanoagent.plugin.manifest import load_manifest
from nanoagent.plugin.package import pack
from nanoagent.uploaded.broker import PluginToolRunner
from nanoagent.uploaded.collector import SeccheckCollector
from nanoagent.uploaded.contract import HarnessManifest
from nanoagent.uploaded.plugin_package import isolate, unpack_package
from nanoagent.uploaded.sandbox import WORKSPACE, BuildSpec, CaseSpec, DockerSandboxSupervisor, Limits, ToolContainerSpec
from nanoagent.uploaded.toolchains import resolve_dependencies, toolchain

pytestmark = pytest.mark.gvisor

SOCKET = os.environ.get("RUSH_SECCHECK_SOCKET", "/run/rush-gvisor/seccheck.sock")
PROFILE = toolchain("python-3")
SCRATCH = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker")) / "scratch"
PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "workspace-tools"
TOOLS = ("write_note", "read_fixture")

HARNESS = r'''
import json, os, time

request = json.load(open(os.environ["RUSH_REQUEST"]))
workspace = os.environ["RUSH_WORKSPACE"]


def write_result(payload):
    tmp = os.environ["RUSH_RESULT"] + ".tmp"
    with open(tmp, "w") as handle:
        json.dump(payload, handle)
    os.rename(tmp, os.environ["RUSH_RESULT"])


def wait_for(path, wanted=None, seconds=120):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            text = open(path).read()
            if wanted is None or text == wanted:
                return text
        except OSError:
            pass
        time.sleep(0.02)
    raise SystemExit("timed out waiting for " + path)


if request["mode"] == "coherence":
    # The tool wrote v1, then v2 over it; the harness writes its own file in between for the tool container to read.
    first = wait_for(os.path.join(workspace, "from_tool.txt"))
    open(os.path.join(workspace, "from_harness.txt"), "w").write("harness says " + first)
    second = wait_for(os.path.join(workspace, "from_tool.txt"), "v2")
    write_result({"protocol": "rush.harness.v1", "status": "answered", "answer": {"first": first, "second": second}})
elif request["mode"] == "busy":
    end = time.process_time() + request["cpu_seconds"]
    while time.process_time() < end:
        pass
    write_result({"protocol": "rush.harness.v1", "status": "answered", "answer": {}})
'''


@pytest.fixture(scope="module")
def rig():
    root = SCRATCH / f"tool-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True)
    collector = SeccheckCollector(SOCKET)
    collector.start()
    isolate()
    uv = shutil.which("uv")
    assert uv is not None
    supervisor = DockerSandboxSupervisor(collector=collector, uv=Path(uv))
    try:
        supervisor.startup(PROFILE)
        data = pack(PLUGIN)
        import hashlib

        plugin_root = unpack_package(data, hashlib.sha256(data).hexdigest(), "workspace-tools", root / "plugin")
        supervisor.prepare_plugin(plugin_root, 900)
        source = root / "source"
        source.mkdir()
        (source / "main.py").write_text(HARNESS)
        closure = resolve_dependencies(PROFILE, source, (), root / "deps", index_url=None)
        manifest = HarnessManifest("h", "1", ("chat_completions",), "python-3", (), ("sh", "-c", "cp main.py /build-out/main.py"), ("main.py",), ("python", "/harness/main.py"))
        artifact = supervisor.build(BuildSpec("tb", PROFILE, manifest, source, closure, root / "build-work", Limits(wall_s=180)))
    except BaseException:
        collector.stop()
        shutil.rmtree(root, ignore_errors=True)
        raise

    class Rig:
        pass

    r = Rig()
    r.root, r.supervisor, r.artifact, r.plugin_root, r.manifest = root, supervisor, artifact, plugin_root, load_manifest(plugin_root)
    r.fixtures = root / "fixtures"
    r.fixtures.mkdir()
    (r.fixtures / "fx.txt").write_text("fixture text")
    yield r
    collector.stop()
    shutil.rmtree(root, ignore_errors=True)


def create(rig, *, hosts: tuple[str, ...] = (), **request) -> tuple[Any, str]:
    attempt = uuid.uuid4().hex[:10]
    name = f"rush-tool-{attempt}"
    network = rig.supervisor.create_network(attempt)
    spec = CaseSpec(
        attempt_id=attempt, profile=PROFILE, run_argv=("python", "/harness/main.py"), artifact=rig.artifact,
        request_json=json.dumps(request).encode(), attempt_token="tok-" + attempt, network=network, workdir=rig.root / attempt,
        limits=Limits(wall_s=120, workspace_bytes=1 << 20), tool=ToolContainerSpec(name, rig.plugin_root, rig.fixtures, hosts),
    )
    handle = rig.supervisor.create_case(spec)
    return handle, name, network


def runner_for(rig, name):
    return PluginToolRunner(rig.manifest, Path(WORKSPACE), TOOLS, timeout=120, launcher=rig.supervisor.tool_launcher(name))


def in_tool(name: str, script: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["docker", "exec", "--user=10001:10001", name, "python", "-c", script], capture_output=True, text=True, timeout=60, check=False
    )


def cleanup(handle, network) -> None:
    handle.close()
    subprocess.run(["docker", "network", "rm", network.name], capture_output=True)


async def test_the_harness_and_a_writing_tool_share_the_workspace_in_both_directions(rig):
    handle, name, network = create(rig, mode="coherence")
    try:
        async with runner_for(rig, name) as tools:
            handle.launch()
            # tool -> harness: the harness polls for the file; the verifier of write_note reads a copy of the volume.
            out = await tools.run("write_note", {"name": "from_tool.txt", "text": "v1"}, Path(WORKSPACE))
            assert out == {"path": "from_tool.txt", "bytes": 2}
            # harness -> tool: the tool container sees what the harness wrote.
            deadline = time.monotonic() + 60
            seen = ""
            while time.monotonic() < deadline and not seen.startswith("harness says"):
                seen = in_tool(name, "print(open('/rush/workspace/from_harness.txt').read())").stdout
                time.sleep(0.05)
            assert seen.strip() == "harness says v1"
            # A rewrite by the tool is visible to a harness that already read the first version.
            await tools.run("write_note", {"name": "from_tool.txt", "text": "v2"}, Path(WORKSPACE))
            outcome = handle.wait()
        assert outcome.termination.exit_code == 0
        assert json.loads(handle.read_result())["answer"] == {"first": "v1", "second": "v2"}
        snapshot = handle.stop_and_drain()
        assert set(snapshot.added) == {"from_harness.txt", "from_tool.txt"}
        assert (snapshot.directory / "from_tool.txt").read_text() == "v2"
        assert (snapshot.directory / "from_harness.txt").read_text() == "harness says v1"
        assert subprocess.run(["docker", "inspect", "--format", "{{.State.Running}}", name], capture_output=True, text=True).stdout.strip() == "false"
    finally:
        cleanup(handle, network)


async def test_the_tool_reads_the_fixture_and_is_confined(rig):
    handle, name, network = create(rig, mode="coherence")
    try:
        async with runner_for(rig, name) as tools:
            handle.launch()
            assert await tools.run("read_fixture", {"name": "fx.txt"}, Path(WORKSPACE)) == {"text": "fixture text"}
        probe = in_tool(
            name,
            r"""
import errno, json, os, socket
def code(action):
    try:
        action()
        return "ok"
    except OSError as error:
        return errno.errorcode.get(error.errno, str(error.errno))
def connect():
    sock = socket.socket()
    sock.settimeout(3)
    sock.connect(("1.1.1.1", 443))
print(json.dumps({
    "uid": os.getuid(),
    "request": code(lambda: open("/rush/request.json")),
    "out": code(lambda: os.listdir("/rush/out")),
    "harness": code(lambda: os.listdir("/harness")),
    "fixture_write": code(lambda: open("/fixtures/fx.txt", "w")),
    "fixture_create": code(lambda: open("/fixtures/new.txt", "w")),
    "plugin_write": code(lambda: open("/plugin/x", "w")),
    "root_write": code(lambda: open("/rootfile", "w")),
    "network": code(connect),
    "interfaces": sorted(os.listdir("/sys/class/net")) if os.path.isdir("/sys/class/net") else [],
    "env": sorted(k for k in os.environ if k != "GPG_KEY" and ("TOKEN" in k or "RUSH" in k or "KEY" in k or "SECRET" in k)),  # GPG_KEY is the image's public one
}))
""",
        )
        assert probe.returncode == 0, probe.stderr
        seen = json.loads(probe.stdout)
        assert seen["uid"] == 10001 and seen["env"] == []
        assert seen["request"] == "ENOENT" and seen["out"] == "ENOENT" and seen["harness"] == "ENOENT"
        # Read-only mounts answer EROFS or, when the host folder's owner is another user, EACCES: either way the write is refused.
        for denied in ("fixture_write", "fixture_create", "plugin_write", "root_write"):
            assert seen[denied] in ("EROFS", "EACCES"), (denied, seen[denied])
        assert seen["network"] != "ok" and seen["interfaces"] in ([], ["lo"])
        mounts = subprocess.run(["docker", "inspect", "--format", "{{json .Mounts}}", name], capture_output=True, text=True).stdout
        assert "request.json" not in mounts and "/rush/out" not in mounts and "/harness" not in mounts
    finally:
        cleanup(handle, network)


async def test_cpu_counters_cover_the_harness_and_the_tool_container(rig):
    busy_s = 1.5
    handle, name, network = create(rig, mode="busy", cpu_seconds=busy_s)
    try:
        async with runner_for(rig, name) as tools:
            handle.launch()
            await tools.run("write_note", {"name": "n.txt", "text": "x"}, Path(WORKSPACE))
            handle.wait()
        handle.stop_and_drain()
        harness, tool = handle.cpu_counters()
        assert harness["identity"] == {"role": "harness", "container": handle.container_id}
        assert tool["identity"]["role"] == "tool" and tool["identity"]["container"] != handle.container_id
        harness_s = (harness["user_ns"] + harness["system_ns"]) / 1e9
        tool_s = (tool["user_ns"] + tool["system_ns"]) / 1e9
        assert busy_s * 0.8 <= harness_s <= busy_s * 3, harness
        assert 0 < tool_s < 10, tool
    finally:
        cleanup(handle, network)


CONNECT_PROBE = r'''
import json, socket, ssl, sys
proxy_host, proxy_port = sys.argv[1].split(":")


def connect(target):
    sock = socket.create_connection((proxy_host, int(proxy_port)), timeout=20)
    sock.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
    status = sock.recv(256).split(b"\r\n", 1)[0].decode()
    return sock, status


def attempt(target):
    try:
        sock, status = connect(target)
        sock.close()
        return status
    except OSError as error:
        return type(error).__name__


def tls(host):
    try:
        sock, status = connect(host + ":443")
        with ssl.create_default_context().wrap_socket(sock, server_hostname=host) as secure:
            secure.sendall(f"GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
            return secure.recv(64).split(b"\r\n", 1)[0].decode()
    except OSError as error:
        return type(error).__name__


def direct(address):
    try:
        socket.create_connection(address, timeout=4).close()
        return "ok"
    except OSError as error:
        return type(error).__name__


print(json.dumps({
    "declared": attempt("example.com:443"), "declared_tls": tls("example.com"),
    "undeclared": attempt("pypi.org:443"), "plain_port": attempt("example.com:80"),
    "private": attempt("10.0.0.1:443"), "metadata": attempt("169.254.169.254:443"), "loopback": attempt("127.0.0.1:443"),
    "direct_public": direct(("1.1.1.1", 443)), "direct_name": direct(("example.com", 443)), "direct_private": direct(("10.0.0.1", 443)),
}))
'''


def networks() -> set[str]:
    return set(subprocess.run(["docker", "network", "ls", "--format", "{{.Name}}"], capture_output=True, text=True, check=True).stdout.split())


async def test_the_tool_container_reaches_only_its_declared_hosts_through_the_egress_proxy(rig):
    before = networks()
    handle, name, network = create(rig, hosts=("example.com",), mode="coherence")
    try:
        assert handle.tool_proxy is not None and handle.tool_proxy.startswith("http://")
        probe = in_tool(name, CONNECT_PROBE.replace("sys.argv[1]", repr(handle.tool_proxy.removeprefix("http://"))))
        assert probe.returncode == 0, probe.stderr
        seen = json.loads(probe.stdout)
        assert " 200 " in seen["declared"] and seen["declared_tls"].startswith("HTTP/1.1 200"), "the declared host is tunnelled"
        for refused in ("undeclared", "plain_port", "private", "metadata", "loopback"):
            assert " 403 " in seen[refused], (refused, seen[refused])
        for direct in ("direct_public", "direct_name", "direct_private"):
            assert seen[direct] != "ok", f"{direct}: the tool container has no route but the proxy"
        with rig.supervisor.tool_launcher(name).launch(rig.manifest, {}) as (argv, _):
            assert f"HTTPS_PROXY={handle.tool_proxy}" in argv and f"http_proxy={handle.tool_proxy}" in argv, "the plugin's own environment carries the proxy"
        assert len(networks() - before) == 2, "the attempt network and the tool network"
    finally:
        cleanup(handle, network)
    assert networks() == before, "the tool network goes with the case"


async def test_a_plugin_with_no_declared_hosts_has_no_network_at_all(rig):
    handle, name, network = create(rig, mode="coherence")
    try:
        assert handle.tool_proxy is None
        probe = in_tool(name, "import json, os, socket\ntry:\n    socket.create_connection(('1.1.1.1', 443), timeout=3)\n    r = 'ok'\nexcept OSError as e:\n    r = type(e).__name__\nprint(json.dumps({'net': r, 'ifs': sorted(os.listdir('/sys/class/net')) if os.path.isdir('/sys/class/net') else []}))")
        seen = json.loads(probe.stdout)
        assert seen["net"] != "ok" and seen["ifs"] in ([], ["lo"])
        with rig.supervisor.tool_launcher(name).launch(rig.manifest, {}) as (argv, _):
            assert not any(part.startswith(("HTTPS_PROXY", "https_proxy")) for part in argv)
    finally:
        cleanup(handle, network)
