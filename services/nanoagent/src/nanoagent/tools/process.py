"""Shared subprocess cleanup for the shell and Python execution tools."""

from __future__ import annotations

import os
import signal
import subprocess


def communicate_or_kill(proc: subprocess.Popen[str], timeout: float) -> tuple[str, str]:
    """Drain a process within ``timeout`` and kill its process group on expiry."""
    try:
        return proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        proc.communicate()
        raise
