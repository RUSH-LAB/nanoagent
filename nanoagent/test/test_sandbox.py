from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from nanoagent import helpers
from nanoagent.plugin import egress as egress_module
from nanoagent.plugin import load_manifest, sandbox, verify_input
from nanoagent.plugin.egress import egress, egress_port
from nanoagent.plugin.python import plugin_python
from test_plugin import write_plugin


def _ask(path: Path, request: bytes) -> bytes:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(str(path))
        client.sendall(request)
        return client.recv(1024)


def _connect(host: str, port: int = 443) -> bytes:
    return f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode()


@pytest.fixture
def short_tmp(monkeypatch: pytest.MonkeyPatch) -> None:
    # A Unix socket's path is limited to about a hundred bytes; macOS's own temp folder is long.
    monkeypatch.setenv("TMPDIR", "/tmp")


unix_sockets = pytest.mark.skipif(sys.platform == "win32", reason="the egress proxy's Unix socket is not on Windows")


@unix_sockets
def test_egress_refuses_all_but_connect_to_a_declared_public_host(short_tmp: None) -> None:
    with egress(["api.example.com", "localhost"]) as path:
        assert _ask(path, _connect("other.example.com")).startswith(b"HTTP/1.1 403")
        assert _ask(path, _connect("api.example.com", 80)).startswith(b"HTTP/1.1 403")
        assert _ask(path, b"GET http://api.example.com/ HTTP/1.1\r\n\r\n").startswith(b"HTTP/1.1 403")
        # Declared, but not public: a plugin cannot reach the private network by naming it.
        assert _ask(path, _connect("localhost")).startswith(b"HTTP/1.1 403")


@unix_sockets
def test_egress_tunnels_to_a_declared_host(short_tmp: None, monkeypatch: pytest.MonkeyPatch) -> None:
    upstream = socket.create_server(("127.0.0.1", 0))
    port = upstream.getsockname()[1]

    def echo() -> None:
        connection, _ = upstream.accept()
        with connection:
            connection.sendall(connection.recv(1024))

    threading.Thread(target=echo, daemon=True).start()
    monkeypatch.setattr(egress_module, "_public_address", lambda host: ("127.0.0.1", port))
    with egress(["api.example.com"]) as path, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(str(path))
        client.sendall(_connect("API.example.com"))
        assert client.recv(1024) == b"HTTP/1.1 200 Connection established\r\n\r\n"
        client.sendall(b"hello")
        assert client.recv(1024) == b"hello"
    upstream.close()


def test_refuses_an_unknown_sandbox() -> None:
    with pytest.raises(ValueError, match="bwrap, seatbelt, appcontainer, none"):
        sandbox.configure("docker")


def test_egress_port_refuses_an_undeclared_host() -> None:
    with egress_port(["api.example.com"]) as port, socket.create_connection(("127.0.0.1", port)) as client:
        client.sendall(_connect("other.example.com"))
        assert client.recv(1024).startswith(b"HTTP/1.1 403")


# Each sandbox this machine has: bwrap on Linux, seatbelt on macOS.
KINDS = [
    pytest.param(
        "bwrap",
        marks=pytest.mark.skipif(
            not sys.platform.startswith("linux") or shutil.which("bwrap") is None, reason="bwrap runs on Linux"
        ),
    ),
    pytest.param(
        "seatbelt",
        marks=pytest.mark.skipif(
            sys.platform != "darwin" or not Path("/usr/bin/sandbox-exec").exists(), reason="seatbelt runs on macOS"
        ),
    ),
    pytest.param("appcontainer", marks=pytest.mark.skipif(sys.platform != "win32", reason="appcontainer runs on Windows")),
]


@pytest.fixture(params=KINDS)
def confined(request: pytest.FixtureRequest) -> None:
    sandbox.configure(request.param, plugin_python(sys.executable))
    yield
    sandbox.configure("none")


def test_the_sandbox_confines_a_process(confined: None, tmp_path: Path) -> None:
    sandbox.check(tmp_path)


def test_the_sandbox_writes_only_where_it_is_given(confined: None, tmp_path: Path) -> None:
    plugin, workspace, elsewhere = tmp_path / "plugin", tmp_path / "workspace", tmp_path / "elsewhere"
    for folder in (plugin, workspace, elsewhere):
        folder.mkdir()
    script = (
        "import sys\n"
        "for path in sys.argv[1:]:\n"
        "    try:\n"
        "        open(path, 'w').write('x'); print('wrote', path)\n"
        "    except OSError:\n"
        "        print('refused', path)\n"
    )
    targets = [str(plugin / "a"), str(workspace / "a"), str(elsewhere / "a")]
    with sandbox.launch(
        [sys.executable, "-I", "-c", script, *targets], root=plugin, env={}, writable=[workspace]
    ) as (argv, env):
        output = subprocess.run(argv, env=env, capture_output=True, text=True, check=True).stdout.split("\n")
    assert output[:3] == [f"refused {targets[0]}", f"wrote {targets[1]}", f"refused {targets[2]}"]


def test_the_sandbox_reads_only_what_it_is_given(confined: None, tmp_path: Path) -> None:
    plugin, secret = tmp_path / "plugin", tmp_path / "secret"
    plugin.mkdir()
    secret.write_text("x")
    with sandbox.launch([sys.executable, "-I", "-c", "open(__import__('sys').argv[1])", str(secret)], root=plugin, env={}) as (
        argv,
        env,
    ):
        assert subprocess.run(argv, env=env, capture_output=True, check=False).returncode != 0


def test_the_verifier_runs_in_the_sandbox(confined: None, tmp_path: Path) -> None:
    root = write_plugin(tmp_path / "echo").parent
    assert verify_input(load_manifest(root), "echo", {"value": "yes"}).score == 1


windows_only = pytest.mark.skipif(sys.platform != "win32", reason="appcontainer runs on Windows")


@windows_only
def test_appcontainer_tunnels_to_a_declared_host_through_its_pipe(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    upstream = socket.create_server(("127.0.0.1", 0))
    port = upstream.getsockname()[1]

    def echo() -> None:
        connection, _ = upstream.accept()
        with connection:
            connection.sendall(connection.recv(1024))

    threading.Thread(target=echo, daemon=True).start()
    monkeypatch.setattr(egress_module, "_public_address", lambda host: ("127.0.0.1", port))
    script = (
        "import os, socket\n"
        "port = int(os.environ['HTTPS_PROXY'].rpartition(':')[2])\n"
        "client = socket.create_connection(('127.0.0.1', port), timeout=20)\n"
        "client.sendall(b'CONNECT api.example.com:443 HTTP/1.1\\r\\nHost: api.example.com:443\\r\\n\\r\\n')\n"
        "assert client.recv(1024).startswith(b'HTTP/1.1 200'), 'no tunnel'\n"
        "client.sendall(b'hello')\n"
        "assert client.recv(1024) == b'hello', 'no echo'\n"
        "print('ok')\n"
    )
    sandbox.configure("appcontainer", plugin_python(sys.executable))
    try:
        with sandbox.launch([sys.executable, "-I", "-c", script], root=tmp_path, env={}, hosts=["api.example.com"]) as (argv, env):
            completed = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=60, check=False)
    finally:
        sandbox.configure("none")
        upstream.close()
    assert completed.stdout.strip() == "ok", completed.stderr


@pytest.mark.skipif(sys.platform == "win32", reason="bwrap is not on Windows")
def test_bwrap_runs_the_command_behind_the_egress_bridge_helper(tmp_path: Path) -> None:
    sandbox.configure("bwrap", plugin_python(sys.executable))
    try:
        argv = sandbox._bwrap(["run"], tmp_path, {}, [], [], tmp_path / "egress.sock")
    finally:
        sandbox.configure("none")
    bridge = helpers.command("egress-bridge", "/run/nanoagent/egress.sock", str(egress_module.PROXY_PORT), "--")
    assert argv[argv.index("--chdir") :] == ["--chdir", str(tmp_path), "--", *bridge, "run"]
    binds = {tuple(argv[index : index + 3]) for index, arg in enumerate(argv) if arg == "--ro-bind"}
    assert {("--ro-bind", str(path), str(path)) for path in helpers.readable()} <= binds


@unix_sockets
def test_the_egress_bridge_helper_runs_the_command_and_exits_with_its_status(tmp_path: Path) -> None:
    command = helpers.command("egress-bridge", str(tmp_path / "egress.sock"), "0", "--", sys.executable, "-c", "raise SystemExit(3)")
    assert subprocess.run(command, check=False).returncode == 3
