#!/usr/bin/env python3
"""Registers the `runsc-rush` Docker runtime on a Linux execution worker. Idempotent; run with sudo.

    sudo RUSH_WORKER_USER=<worker user> python3 deploy/gvisor/setup.py

The runtime runs gVisor with a trace session whose only sink is a `remote` sink at the socket the
NanoAgent worker's collector (nanoagent.uploaded.collector) listens on. `ignore_setup_error` is
false, so runsc refuses to start any container while the collector is not listening: no
unobserved execution. Other runtimes in /etc/docker/daemon.json are left untouched; Docker is
restarted only when the runtime entry changed.

Environment:
    RUSH_WORKER_USER      user that owns the socket directory (default: SUDO_USER)
    RUSH_SECCHECK_SOCKET  collector socket path (default: /run/rush-gvisor/seccheck.sock)
    RUSH_RUNSC_PATH       the runsc binary (default: the one on PATH)
    RUSH_RUNTIME_NAME     Docker runtime name (default: runsc-rush)
"""

import grp
import json
import os
import pwd
import shutil
import subprocess
import sys
from pathlib import Path

RUNTIME = os.environ.get("RUSH_RUNTIME_NAME", "runsc-rush")
SOCKET = os.environ.get("RUSH_SECCHECK_SOCKET", "/run/rush-gvisor/seccheck.sock")
CONFIG_DIR = Path("/etc/rush-gvisor")
POD_INIT = CONFIG_DIR / "pod-init.json"
DAEMON_JSON = Path("/etc/docker/daemon.json")

# Context fields every exec/clone/exit point carries. `thread_group_start_time` is the start
# identity that tells a reused process id from the original; `is_exec_session` marks `docker exec`.
CONTEXT = [
    "time",
    "container_id",
    "thread_id",
    "task_start_time",
    "group_id",
    "thread_group_start_time",
    "parent_thread_group_id",
    "credentials",
    "cwd",
    "process_name",
    "is_exec_session",
]
# exit_notify_parent has no cwd or exec-session context field in gVisor's metadata.
EXIT_NOTIFY_CONTEXT = [c for c in CONTEXT if c not in ("cwd", "is_exec_session")]
POINTS = [
    ("container/start", CONTEXT),
    ("sentry/clone", CONTEXT),
    ("sentry/execve", CONTEXT),
    ("sentry/task_exit", CONTEXT),
    ("sentry/exit_notify_parent", EXIT_NOTIFY_CONTEXT),
    ("syscall/execve/enter", CONTEXT),
    ("syscall/execve/exit", CONTEXT),
    ("syscall/execveat/enter", CONTEXT),
    ("syscall/execveat/exit", CONTEXT),
]


def pod_init() -> dict:
    return {
        "trace_session": {
            "name": "Default",
            "points": [{"name": name, "context_fields": fields} for name, fields in POINTS],
            "sinks": [
                {
                    "name": "remote",
                    "config": {"endpoint": SOCKET, "retries": 8},
                    "ignore_setup_error": False,
                }
            ],
        }
    }


def write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text() == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return True


def main() -> None:
    if os.geteuid() != 0:
        sys.exit("setup.py must run as root (sudo)")
    user = os.environ.get("RUSH_WORKER_USER") or os.environ.get("SUDO_USER")
    if not user:
        sys.exit("set RUSH_WORKER_USER to the user the NanoAgent worker runs as")
    runsc = os.environ.get("RUSH_RUNSC_PATH") or shutil.which("runsc")
    if not runsc:
        sys.exit("runsc not found on PATH; install gVisor or set RUSH_RUNSC_PATH")
    info = pwd.getpwnam(user)

    sock_dir = Path(SOCKET).parent
    sock_dir.mkdir(parents=True, exist_ok=True)
    os.chown(sock_dir, info.pw_uid, info.pw_gid)
    sock_dir.chmod(0o750)
    # /run is a tmpfs: recreate the owned socket directory on boot.
    group = grp.getgrgid(info.pw_gid).gr_name
    write_if_changed(Path("/etc/tmpfiles.d/rush-gvisor.conf"), f"d {sock_dir} 0750 {user} {group} -\n")

    write_if_changed(POD_INIT, json.dumps(pod_init(), indent=2) + "\n")
    POD_INIT.chmod(0o644)

    entry = {
        "path": runsc,
        "runtimeArgs": ["--network=sandbox", "--directfs=false", f"--pod-init-config={POD_INIT}"],
    }
    daemon = json.loads(DAEMON_JSON.read_text()) if DAEMON_JSON.exists() else {}
    runtimes = daemon.setdefault("runtimes", {})
    changed = runtimes.get(RUNTIME) != entry
    runtimes[RUNTIME] = entry
    if changed:
        write_if_changed(DAEMON_JSON, json.dumps(daemon, indent=2) + "\n")
        subprocess.run(["systemctl", "restart", "docker"], check=True)
    print(f"runtime {RUNTIME}: {'registered' if changed else 'already registered'}; socket {SOCKET}")


if __name__ == "__main__":
    main()
