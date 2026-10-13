from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from nanoagent.plugin import egress as egress_module
from nanoagent.plugin import sandbox
from nanoagent.plugin.egress import egress, egress_port


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


def test_egress_refuses_all_but_connect_to_a_declared_public_host(short_tmp: None) -> None:
    with egress(["api.example.com", "localhost"]) as path:
        assert _ask(path, _connect("other.example.com")).startswith(b"HTTP/1.1 403")
        assert _ask(path, _connect("api.example.com", 80)).startswith(b"HTTP/1.1 403")
        assert _ask(path, b"GET http://api.example.com/ HTTP/1.1\r\n\r\n").startswith(b"HTTP/1.1 403")
        # Declared, but not public: a plugin cannot reach the private network by naming it.
        assert _ask(path, _connect("localhost")).startswith(b"HTTP/1.1 403")


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
    with pytest.raises(ValueError, match="bwrap, seatbelt, none"):
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
]


@pytest.fixture(params=KINDS)
def confined(request: pytest.FixtureRequest) -> None:
    sandbox.configure(request.param)
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
