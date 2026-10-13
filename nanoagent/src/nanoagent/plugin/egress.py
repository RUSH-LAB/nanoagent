"""The only way out of a sandboxed plugin: an HTTPS proxy that reaches the hosts it declared.

A sandbox (``nanoagent.plugin.sandbox``) has no network of its own. Its processes reach
``127.0.0.1:<PROXY_PORT>``, where ``_egress_bridge.py`` passes each connection to the Unix socket
:func:`egress` serves out here. That proxy answers ``CONNECT host:443`` for the ``hosts`` it was
given and nothing else: no other port, no plain HTTP, and no host whose addresses are not all
public, so a plugin that declares an internal name still cannot reach the private network.

A sandbox that shares the host's network (seatbelt) has no loopback of its own to bridge from:
:func:`egress_port` serves the same proxy on a loopback port, the only one the sandbox may reach.
"""

from __future__ import annotations

import ipaddress
import select
import socket
import socketserver
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

PROXY_PORT = 3128
HEAD_MAX_BYTES = 8192
CONNECT_TIMEOUT = 10.0
IDLE_TIMEOUT = 300.0


def _public_address(host: str) -> tuple[str, int] | None:
    """The first address of ``host``:443 when every one of its addresses is public, else None."""
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        return None
    addresses = [info[4] for info in infos]
    if not addresses or not all(ipaddress.ip_address(address[0]).is_global for address in addresses):
        return None
    return addresses[0][0], addresses[0][1]


def _pipe(one: socket.socket, other: socket.socket) -> None:
    """Copy bytes both ways until either side closes or both stay idle for IDLE_TIMEOUT."""
    sockets = [one, other]
    while True:
        ready, _, _ = select.select(sockets, [], [], IDLE_TIMEOUT)
        if not ready:
            return
        for source in ready:
            data = source.recv(65536)
            if not data:
                return
            (other if source is one else one).sendall(data)


def _handler(hosts: frozenset[str]) -> type[socketserver.BaseRequestHandler]:
    class Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            client: socket.socket = self.request
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = client.recv(1024)
                if not chunk or len(head) + len(chunk) > HEAD_MAX_BYTES:
                    return
                head += chunk
            method, _, rest = head.split(b"\r\n", 1)[0].decode("latin-1").partition(" ")
            target = rest.partition(" ")[0]
            host, _, port = target.rpartition(":")
            if method != "CONNECT" or port != "443" or host.lower() not in hosts:
                client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return
            address = _public_address(host)
            if address is None:
                client.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return
            try:
                upstream = socket.create_connection(address, timeout=CONNECT_TIMEOUT)
            except OSError:
                client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                return
            with upstream:
                upstream.settimeout(None)
                client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                _pipe(client, upstream)

    return Handler


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class _TcpServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True


@contextmanager
def _serving(server: socketserver.BaseServer) -> Iterator[None]:
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield
    finally:
        server.shutdown()
        server.server_close()


def _allowed(hosts: list[str] | tuple[str, ...]) -> type[socketserver.BaseRequestHandler]:
    return _handler(frozenset(host.lower() for host in hosts))


@contextmanager
def egress(hosts: list[str] | tuple[str, ...]) -> Iterator[Path]:
    """Serve the proxy for ``hosts`` on a new Unix socket while the block runs; its path."""
    with TemporaryDirectory(prefix="nanoagent-egress-") as folder:
        path = Path(folder) / "egress.sock"
        with _serving(_Server(str(path), _allowed(hosts))):
            yield path


@contextmanager
def egress_port(hosts: list[str] | tuple[str, ...]) -> Iterator[int]:
    """Serve the proxy for ``hosts`` on a new loopback port while the block runs; its number."""
    server = _TcpServer(("127.0.0.1", 0), _allowed(hosts))
    with _serving(server):
        yield server.server_address[1]
