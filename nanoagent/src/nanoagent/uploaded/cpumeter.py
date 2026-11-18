"""CPU accounting for a sandbox container: the cgroup v2 reading and the thread that keeps the last one."""

from __future__ import annotations

import re
import threading
from pathlib import Path

CGROUP_ROOT = Path("/sys/fs/cgroup")
CPU_SAMPLE_INTERVAL_S = 0.02


def cgroup_directory(pid: int, *, proc_root: Path = Path("/proc"), cgroup_root: Path = CGROUP_ROOT) -> Path | None:
    """The cgroup v2 directory of process ``pid``, or None when it cannot be read."""
    try:
        lines = (proc_root / str(pid) / "cgroup").read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        hierarchy, _, rest = line.partition(":")
        _, _, path = rest.partition(":")
        if hierarchy == "0" and path:
            return cgroup_root / path.lstrip("/")
    return None


def read_cpu_stat(directory: Path) -> tuple[int, int] | None:
    """`(user_ns, system_ns)` from the cgroup's `cpu.stat`, or None when it is gone or unreadable."""
    try:
        text = (directory / "cpu.stat").read_text()
    except OSError:
        return None
    fields = dict(re.findall(r"^(user_usec|system_usec) (\d+)$", text, re.MULTILINE))
    if len(fields) != 2:
        return None
    return int(fields["user_usec"]) * 1000, int(fields["system_usec"]) * 1000


class CpuMeter:
    """The last CPU reading of one container's cgroup.

    A container's cgroup is removed the moment its sandbox exits, so a sandbox that ends on its own cannot be read
    afterwards: a thread reads it every `interval_s` until it is gone, and `stop` returns the last reading. That reading
    trails the exit by at most one interval. A live container is read exactly with `sample`, which `stop_and_drain` calls
    right before it stops one.
    """

    def __init__(self, directory: Path, interval_s: float = CPU_SAMPLE_INTERVAL_S) -> None:
        self._directory = directory
        self._interval_s = interval_s
        self._latest: tuple[int, int] | None = None
        self._stopped = threading.Event()
        self._thread = threading.Thread(target=self._watch, name=f"cpu-{directory.name}", daemon=True)

    def start(self) -> None:
        self.sample()
        self._thread.start()

    def sample(self) -> tuple[int, int] | None:
        reading = read_cpu_stat(self._directory)
        if reading is not None:
            self._latest = reading
        return reading

    def _watch(self) -> None:
        while not self._stopped.wait(self._interval_s):
            if self.sample() is None:
                return

    def stop(self) -> tuple[int, int] | None:
        self._stopped.set()
        if self._thread.is_alive():
            self._thread.join()
        return self._latest
