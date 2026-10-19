"""Run inside a sandbox: ``nanoagent helper egress-bridge <socket> <port> -- <command...>``.

Listens on ``127.0.0.1:<port>``, the sandbox's only network, and passes each connection to the
Unix socket the egress proxy serves outside (``nanoagent.plugin.egress``); then runs the command
with this process's standard streams and exits with its status. Standard library only.

On Windows (an AppContainer) the proxy is a named pipe, ``<socket>`` is its name, and loopback ports
are shared by every process on the machine, so ``<port>`` is ``0``: the bridge takes a free one and sets
the command's ``HTTPS_PROXY`` to it.
"""

import os
import select
import socket
import subprocess
import threading

PROXY_VARIABLES = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")


def _pipe(one, other):
    sockets = [one, other]
    try:
        while True:
            ready, _, _ = select.select(sockets, [], [])
            for source in ready:
                data = source.recv(65536)
                if not data:
                    return
                (other if source is one else one).sendall(data)
    except OSError:
        return
    finally:
        one.close()
        other.close()


def _pump_pipe(client, pipe):
    """Pass bytes between a socket and a Windows named pipe, each direction in a thread of its own."""

    def up():
        try:
            while data := client.recv(65536):
                pipe.write(data)
        except OSError:
            pass
        finally:
            pipe.close()

    threading.Thread(target=up, daemon=True).start()
    try:
        while data := pipe.read():
            client.sendall(data)
    except OSError:
        pass
    finally:
        client.close()
        pipe.close()


def _serve(listener, path):
    while True:
        client, _ = listener.accept()
        if os.name == "nt":
            from nanoagent.helpers import winpipe

            try:
                upstream = winpipe.connect(path)
            except OSError:
                client.close()
                continue
            threading.Thread(target=_pump_pipe, args=(client, upstream), daemon=True).start()
            continue
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect(path)
        except OSError:
            client.close()
            upstream.close()
            continue
        threading.Thread(target=_pipe, args=(client, upstream), daemon=True).start()


def main(argv):
    path, port, separator, command = argv[0], int(argv[1]), argv[2], argv[3:]
    if separator != "--" or not command:
        raise SystemExit("usage: nanoagent helper egress-bridge <socket> <port> -- <command...>")
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name != "nt":
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port))
    listener.listen()
    threading.Thread(target=_serve, args=(listener, path), daemon=True).start()
    if os.name != "nt":
        return subprocess.call(command)
    proxy = f"http://127.0.0.1:{listener.getsockname()[1]}"
    return subprocess.call(command, env={**os.environ, **dict.fromkeys(PROXY_VARIABLES, proxy)})
