"""Where a plugin's processes run: plainly, or confined by bubblewrap or macOS's seatbelt.

Every process a plugin brings (its ``run.sh``, its MCP server, its verifier, the ``uv sync``
that installs it) starts through :func:`launch`. Which sandbox that is is the host's choice,
made once with :func:`configure`, with the Python plugins run on (nanoagent.plugin.python):

- ``none``: the process runs as itself, with the environment it is given. For running your own
  plugins on your own machine.
- ``bwrap``: the process runs in new namespaces (``bwrap --unshare-all``) with an empty
  environment but the one it is given. It sees the system's programs, the Python plugins run on
  and NanoAgent's helpers (nanoagent.helpers) read-only, the plugin's own folder read-only, and
  only the folders it is given to write; ``/tmp`` is its own. Its only network is the egress proxy
  (``nanoagent.plugin.egress``), which reaches the hosts the plugin declared, over HTTPS. :func:`check` proves all of that on this
  machine before a host serves anything.
- ``seatbelt``: the same confinement on macOS, through ``sandbox-exec``. With no network namespace
  to give it, the process may reach only the loopback port its own egress proxy listens on, and
  sees no other process, so neither another's environment.
"""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from mcp.client.stdio import get_default_environment

from nanoagent import helpers
from nanoagent.plugin.egress import PROXY_PORT, egress, egress_port
from nanoagent.plugin.python import PluginPython

SANDBOXES = ("bwrap", "seatbelt", "none")
# What every sandbox sees read-only: the system's programs, libraries and certificates.
SYSTEM = ("/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc/ssl", "/etc/ca-certificates", "/etc/alternatives")
# What a seatbelt sandbox reads: the system's programs, libraries, certificates and installed software.
MACOS_SYSTEM = ("/usr", "/bin", "/sbin", "/System", "/Library", "/private/etc", "/private/var/db/timezone", "/dev", "/opt/homebrew")
# The kernel facts a program asks about itself and its machine; not other processes' arguments.
MACOS_SYSCTLS = (
    "kern.version",
    "kern.hostname",
    "kern.argmax",
    "kern.maxfilesperproc",
    "kern.maxproc",
    "kern.ngroups",
    "kern.secure_kernel",
    "kern.usrstack64",
    "kern.boottime",
    "sysctl.proc_cputype",
    "sysctl.proc_translated",
    "vm.loadavg",
)
# The system services TLS and name lookups need.
MACOS_SERVICES = (
    "com.apple.system.opendirectoryd.libinfo",
    "com.apple.trustd",
    "com.apple.trustd.agent",
    "com.apple.SystemConfiguration.configd",
)
CHECK_TIMEOUT = 30.0

_kind = "none"
_python: PluginPython | None = None


def configure(kind: str, python: PluginPython | None = None) -> None:
    """Choose the sandbox every later :func:`launch` uses, and the Python plugins run on, which
    every sandbox but ``none`` needs."""
    global _kind, _python
    if kind not in SANDBOXES:
        raise ValueError(f"sandbox must be one of {', '.join(SANDBOXES)}, got {kind!r}")
    if kind != "none" and python is None:
        raise ValueError(f"the {kind} sandbox needs the Python plugins run on")
    _kind, _python = kind, python


def current() -> str:
    return _kind


def _plugin_python() -> PluginPython:
    if _python is None:
        raise RuntimeError("the sandbox has no Python plugins run on: configure() was not given one")
    return _python


def _runtime() -> list[Path]:
    """What runs inside: the Python plugins run on, and NanoAgent's helpers."""
    paths = {_plugin_python().prefix, *helpers.readable()}
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
    args += ["--bind", str(socket), "/run/nanoagent/egress.sock"]
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
    bridge = helpers.command("egress-bridge", "/run/nanoagent/egress.sock", str(PROXY_PORT), "--")
    return [*args, "--chdir", str(root), "--", *bridge, *argv]


def _quoted(path: Path | str) -> str:
    return '"' + str(path).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _seatbelt(
    argv: Sequence[str],
    root: Path,
    env: dict[str, str],
    readable: Sequence[Path],
    writable: Sequence[Path],
    home: Path,
    port: int,
) -> tuple[list[str], dict[str, str]]:
    # uv and the Python plugins run on, which a plugin's environment is built from.
    tools = [Path(found).resolve().parent for found in [shutil.which("uv")] if found]
    tools.append(_plugin_python().executable.parent)
    reads = [*MACOS_SYSTEM, *_runtime(), *tools, root, *readable, *writable, home]
    profile = "\n".join(
        [
            "(version 1)",
            "(deny default)",
            "(allow process-exec process-fork)",
            "(allow signal (target same-sandbox))",
            # Explicitly: under `deny default` alone, another process's arguments and environment still read.
            "(deny process-info*)",
            "(allow process-info* (target self))",
            "(allow file-read-metadata)",
            '(allow file-read* (literal "/") ' + " ".join(f"(subpath {_quoted(path)})" for path in reads) + ")",
            '(allow file-write* (literal "/dev/null") ' + " ".join(f"(subpath {_quoted(path)})" for path in [*writable, home]) + ")",
            '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.") (sysctl-name-prefix "kern.os") '
            + " ".join(f'(sysctl-name "{name}")' for name in MACOS_SYSCTLS)
            + ")",
            "(allow mach-lookup " + " ".join(f'(global-name "{name}")' for name in MACOS_SERVICES) + ")",
            f'(allow network-outbound (remote tcp "localhost:{port}"))',
        ]
    )
    proxy = f"http://127.0.0.1:{port}"
    inside = {
        "PATH": ":".join([*(str(path) for path in tools), "/usr/bin", "/bin"]),
        "HOME": str(home),
        "TMPDIR": str(home),
        "HTTPS_PROXY": proxy,
        "https_proxy": proxy,
        "HTTP_PROXY": proxy,
        "http_proxy": proxy,
        "UV_CACHE_DIR": str(home / "uv-cache"),
        "UV_LINK_MODE": "copy",
        "UV_PYTHON_DOWNLOADS": "never",
        **({"UV_PYTHON_INSTALL_DIR": os.environ["UV_PYTHON_INSTALL_DIR"]} if os.environ.get("UV_PYTHON_INSTALL_DIR") else {}),
        **env,
    }
    return ["/usr/bin/sandbox-exec", "-p", profile, "/usr/bin/env", "-C", str(root), *argv], inside


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
    resolved = [path.resolve() for path in readable], [path.resolve() for path in writable]
    if _kind == "seatbelt":
        with egress_port(hosts) as port, TemporaryDirectory(prefix="nanoagent-sandbox-") as home:
            yield _seatbelt(argv, root.resolve(), env, *resolved, Path(home).resolve(), port)
        return
    with egress(hosts) as socket:
        yield _bwrap(argv, root.resolve(), env, *resolved, socket), get_default_environment()


# Run inside the sandbox by check(): it must reach nothing directly, nothing undeclared through the
# proxy, and none of the host's environment.
_PROBE = """
import os, socket, sys
canary = sys.argv[1]
proxy_port = int(os.environ["HTTPS_PROXY"].rpartition(":")[2])
problems = []
try:
    socket.create_connection(("1.1.1.1", 443), timeout=3).close()
    problems.append("reached the network directly")
except OSError:
    pass
with socket.create_connection(("127.0.0.1", proxy_port), timeout=10) as proxy:
    proxy.sendall(b"CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n")
    if not proxy.recv(64).startswith(b"HTTP/1.1 403"):
        problems.append("the proxy let an undeclared host through")
if canary in str(dict(os.environ)):
    problems.append("saw the host's environment")
if os.path.isdir("/proc"):
    for pid in os.listdir("/proc"):
        try:
            if canary.encode() in open(f"/proc/{pid}/environ", "rb").read():
                problems.append(f"read the host's environment through /proc/{pid}")
        except OSError:
            pass
else:
    # macOS: another process's starting environment, the way ps reads it (KERN_PROCARGS2).
    import ctypes
    libc = ctypes.CDLL(None)
    mib, size = (ctypes.c_int * 3)(1, 49, os.getppid()), ctypes.c_size_t(1 << 20)
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) == 0 and canary.encode() in buffer.raw[: size.value]:
        problems.append("read the host's environment through sysctl")
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
        python = str(_plugin_python().executable)
        with launch([python, "-I", "-c", _PROBE, canary], root=root, env={}) as (argv, env):
            completed = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=CHECK_TIMEOUT, check=False)
    finally:
        del os.environ["NANOAGENT_SANDBOX_CANARY"]
    answer = completed.stdout.strip() or completed.stderr.strip() or f"exit {completed.returncode}"
    if completed.returncode or answer != "ok":
        raise RuntimeError(f"the {_kind} sandbox does not confine plugins on this machine: {answer}")
