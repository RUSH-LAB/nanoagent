"""Run inside a bwrap sandbox: ``nanoagent helper egress-bridge <socket> <port> -- <command...>``.

Listens on ``127.0.0.1:<port>``, the sandbox's only network, and passes each connection to the
Unix socket the egress proxy serves outside (``nanoagent.plugin.egress``); then runs the command
with this process's standard streams and exits with its status. Standard library only.
"""

import select
import socket
import subprocess
import threading


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


def _serve(listener, path):
    while True:
        client, _ = listener.accept()
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
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port))
    listener.listen()
    threading.Thread(target=_serve, args=(listener, path), daemon=True).start()
    return subprocess.call(command)
