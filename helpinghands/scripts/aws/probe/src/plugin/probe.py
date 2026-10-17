"""What the runner's sandbox lets a plugin see, reach and use (helpinghands/scripts/aws/verify-runner.mjs)."""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from contract import ForksInput, ForksOutput, HogInput, HogOutput, ProbeInput, ProbeOutput, SwarmInput, SwarmOutput

PLUGIN = Path(__file__).resolve().parents[2]
MEGABYTE = 1024 * 1024


def reach(host: str) -> str:
    """Fetch https://<host>/ as any HTTPS client here does: through the egress proxy NanoAgent names."""
    try:
        with urllib.request.urlopen(f"https://{host}/", timeout=15) as response:
            return f"reached {response.status}"
    except urllib.error.HTTPError as error:
        return f"reached {error.code}"
    except Exception as error:  # noqa: BLE001 - the report says what refused it
        return f"refused: {error}"[:300]


def direct() -> str:
    """Connect to a public address without the proxy."""
    try:
        socket.create_connection(("1.1.1.1", 443), timeout=5).close()
        return "connected"
    except OSError as error:
        return f"refused: {error}"[:300]


def write(path: Path) -> str:
    try:
        path.write_text("probe")
        return "written"
    except OSError as error:
        return f"refused: {error.strerror}"


def listing(path: Path) -> list[str] | str:
    try:
        return sorted(entry.name for entry in path.iterdir())
    except OSError as error:
        return f"unreadable: {error.strerror}"


def user_namespace() -> str:
    """Make a user namespace of its own, in a process of its own, as a plugin reaching for the
    kernel's namespace and netfilter calls would."""
    made = subprocess.run(
        [sys.executable, "-c", "import os; os.unshare(os.CLONE_NEWUSER)"],
        capture_output=True, text=True, timeout=30, check=False,
    )
    if made.returncode == 0:
        return "made"
    said = made.stderr.strip().splitlines()
    return f"refused: {said[-1] if said else made.returncode}"[:300]


def probe(value: ProbeInput, workspace: Path) -> ProbeOutput:
    try:
        first = Path("/proc/1/environ").read_bytes().decode("utf-8", "replace")
    except OSError as error:
        first = f"unreadable: {error.strerror}"
    # The runner keeps every install and every run's folder side by side (nanoagent.yaml installs,
    # workspaces): this plugin should see its own of each, and none of the others.
    report = {
        "installs": listing(PLUGIN.parent.parent),
        "own_install": PLUGIN.parent.name,
        "workspaces": listing(workspace.parent),
        "own_workspace": workspace.name,
        "environment": sorted(os.environ),
        "direct": direct(),
        "declared": reach(value.declared),
        "undeclared": reach(value.undeclared),
        "private": reach(value.private),
        "metadata": reach("169.254.169.254"),
        "plugin_folder": write(PLUGIN / "probe-was-here"),
        "workspace": write(workspace / "probe.txt"),
        "processes": len([entry for entry in os.listdir("/proc") if entry.isdigit()]),
        "first_process_secrets": any(name in first for name in ("NANOAGENT_API_TOKEN", "OPENROUTER_API_KEY")),
        "user_namespace": user_namespace(),
        "oom_score_adj": Path("/proc/self/oom_score_adj").read_text().strip(),
    }
    return ProbeOutput(report=json.dumps(report, sort_keys=True))


def hog(value: HogInput, workspace: Path) -> HogOutput:
    """Hold `megabytes`, 64 at a time, each one written to so the kernel has to give it."""
    held = []
    try:
        for _ in range(value.megabytes // 64):
            held.append(b"\x01" * (64 * MEGABYTE))
    except MemoryError:
        pass
    return HogOutput(held=len(held) * 64)


def swarm(value: SwarmInput, workspace: Path) -> SwarmOutput:
    """Start `count` processes, each holding `megabytes` it has written to, each smaller than
    NanoAgent, then look how many the kernel stopped once the container ran out of memory."""
    hold = f"import time; held = b'\\x01' * ({value.megabytes} * {MEGABYTE}); time.sleep(120)"
    children = []
    try:
        for _ in range(value.count):
            children.append(subprocess.Popen([sys.executable, "-c", hold]))
    except OSError:
        pass
    time.sleep(10)
    killed = sum(1 for child in children if child.poll() == -signal.SIGKILL)
    for child in children:
        child.kill()
    for child in children:
        child.wait()
    return SwarmOutput(started=len(children), killed=killed)


def forks(value: ForksInput, workspace: Path) -> ForksOutput:
    """Start `count` sleeping processes, as many as the runner allows. With `hold_seconds`, hold
    them that long and return, leaving them to end with the run; else stop them all at once."""
    children = []
    try:
        for _ in range(value.count):
            children.append(subprocess.Popen(["sleep", "600"]))
    except OSError:
        pass
    if value.hold_seconds:
        time.sleep(value.hold_seconds)
        return ForksOutput(started=len(children))
    for child in children:
        child.kill()
    for child in children:
        child.wait()
    return ForksOutput(started=len(children))
