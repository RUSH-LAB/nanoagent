"""Where a plugin's processes run: plainly, or confined by bubblewrap.

Every process a plugin brings (its ``run.sh``, its MCP server, its verifier, the ``uv sync``
that installs it) starts through :func:`launch`. Which sandbox that is is the host's choice,
made once with :func:`configure`:

- ``none``: the process runs as itself, with the environment it is given. For running your own
  plugins on your own machine.
- ``bwrap``: the process runs in new namespaces (``bwrap --unshare-all``) with an empty
  environment but the one it is given. It sees the system's programs and the Python it runs
  on read-only, the plugin's own folder read-only, and only the folders it is given to write;
  ``/tmp`` is its own. Its only network is the egress proxy (``nanoagent.plugin.egress``), which
  reaches the hosts the plugin declared, over HTTPS. :func:`check` proves all of that on this
  machine before a host serves anything.
"""

from __future__ import annotations

import os
import secrets
import subprocess
import sys
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

from mcp.client.stdio import get_default_environment

import nanoagent
from nanoagent.plugin.egress import PROXY_PORT, egress

SANDBOXES = ("bwrap", "none")
BRIDGE = Path(__file__).with_name("_egress_bridge.py")
# What every sandbox sees read-only: the system's programs, libraries and certificates.
SYSTEM = ("/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc/ssl", "/etc/ca-certificates", "/etc/alternatives")
CHECK_TIMEOUT = 30.0

_kind = "none"


def configure(kind: str) -> None:
    """Choose the sandbox every later :func:`launch` uses."""
    global _kind
    if kind not in SANDBOXES:
        raise ValueError(f"sandbox must be one of {', '.join(SANDBOXES)}, got {kind!r}")
    _kind = kind


def current() -> str:
    return _kind


def _runtime() -> list[Path]:
    """What NanoAgent's own Python needs to run inside: its interpreter, its environment, its code."""
    paths = {Path(sys.base_prefix), Path(sys.prefix), Path(nanoagent.__file__).resolve().parents[1]}
    if os.environ.get("UV_PYTHON_INSTALL_DIR"):
        paths.add(Path(os.environ["UV_PYTHON_INSTALL_DIR"]))
    return sorted(paths)


def _bwrap(
    argv: Sequence[str],
    root: Path,
    env: dict[str, str],
    readable: Sequence[Path],
    writable: Sequence[Path],
    socket: Path,
) -> list[str]:
    args = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--clearenv"]
    args += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    for path in SYSTEM:
        args += ["--ro-bind-try", path, path]
    for path in _runtime():
        args += ["--ro-bind", str(path), str(path)]
    for path in [root, *readable]:
        args += ["--ro-bind", str(path), str(path)]
    for path in writable:
        args += ["--bind", str(path), str(path)]
    args += ["--ro-bind", str(BRIDGE), "/run/nanoagent/bridge.py", "--bind", str(socket), "/run/nanoagent/egress.sock"]
    proxy = f"http://127.0.0.1:{PROXY_PORT}"
    inside = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/tmp",
        "HTTPS_PROXY": proxy,
        "https_proxy": proxy,
        "HTTP_PROXY": proxy,
        "http_proxy": proxy,
        "UV_CACHE_DIR": "/tmp/uv-cache",
        "UV_LINK_MODE": "copy",
        "UV_PYTHON_DOWNLOADS": "never",
        **({"UV_PYTHON_INSTALL_DIR": os.environ["UV_PYTHON_INSTALL_DIR"]} if os.environ.get("UV_PYTHON_INSTALL_DIR") else {}),
        **env,
    }
    for name, value in inside.items():
        args += ["--setenv", name, value]
    python = str(Path(sys.base_prefix) / "bin" / "python3")
    args += ["--chdir", str(root), "--", python, "-I", "/run/nanoagent/bridge.py", "/run/nanoagent/egress.sock"]
    return [*args, str(PROXY_PORT), "--", *argv]


@contextmanager
def launch(
    argv: Sequence[str],
    *,
    root: Path,
    env: dict[str, str],
    readable: Sequence[Path] = (),
    writable: Sequence[Path] = (),
    hosts: Sequence[str] = (),
) -> Iterator[tuple[list[str], dict[str, str]]]:
    """The command and environment that run ``argv`` for the plugin at ``root``, while the block runs.

    ``env`` is what the process may see beyond the basics; ``readable`` and ``writable`` the folders
    it may read and write besides the plugin's own, which it only reads; ``hosts`` the hosts it may
    reach. Under ``none`` it may read, write and reach anything.
    """
    if _kind == "none":
        yield list(argv), {**get_default_environment(), **env}
        return
    with egress(hosts) as socket:
        resolved = [path.resolve() for path in readable], [path.resolve() for path in writable]
        yield _bwrap(argv, root.resolve(), env, *resolved, socket), get_default_environment()


# Run inside the sandbox by check(): it must reach nothing directly, nothing undeclared through the
# proxy, and none of the host's environment.
_PROBE = """
import os, socket, sys
canary = sys.argv[1]
problems = []
try:
    socket.create_connection(("1.1.1.1", 443), timeout=3).close()
    problems.append("reached the network directly")
except OSError:
    pass
with socket.create_connection(("127.0.0.1", int(sys.argv[2])), timeout=10) as proxy:
    proxy.sendall(b"CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n")
    if not proxy.recv(64).startswith(b"HTTP/1.1 403"):
        problems.append("the proxy let an undeclared host through")
if canary in str(dict(os.environ)):
    problems.append("saw the host's environment")
for pid in os.listdir("/proc"):
    try:
        if canary.encode() in open(f"/proc/{pid}/environ", "rb").read():
            problems.append(f"read the host's environment through /proc/{pid}")
    except OSError:
        pass
try:
    open(os.path.join(os.getcwd(), "probe"), "w")
    problems.append("wrote into the plugin's folder")
except OSError:
    pass
print("; ".join(problems) or "ok")
"""


def check(root: Path) -> None:
    """Prove the configured sandbox confines a process here, or raise; ``root`` is an existing folder."""
    if _kind == "none":
        return
    canary = secrets.token_hex(16)
    os.environ["NANOAGENT_SANDBOX_CANARY"] = canary
    try:
        python = str(Path(sys.base_prefix) / "bin" / "python3")
        with launch([python, "-I", "-c", _PROBE, canary, str(PROXY_PORT)], root=root, env={}) as (argv, env):
            completed = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=CHECK_TIMEOUT, check=False)
    finally:
        del os.environ["NANOAGENT_SANDBOX_CANARY"]
    answer = completed.stdout.strip() or completed.stderr.strip() or f"exit {completed.returncode}"
    if completed.returncode or answer != "ok":
        raise RuntimeError(f"the bwrap sandbox does not confine plugins on this machine: {answer}")
