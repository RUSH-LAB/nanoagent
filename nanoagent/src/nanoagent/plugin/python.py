"""The Python plugins run on: every plugin's environment is built on it (nanoagent.plugin.install),
and every sandbox lets plugins read it (nanoagent.plugin.sandbox).

It is the host's choice, ``plugin_python`` in its config, not taken from NanoAgent.
:func:`plugin_python` asks the interpreter it is given what it is, and refuses one that does not
answer or is not CPython.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from packaging.tags import Tag, compatible_tags, cpython_tags, platform_tags

PROBE_TIMEOUT = 30.0
# Run on the interpreter: what it is, through any venv and symlinks to the installation behind it.
_PROBE = """
import json, os, sys
print(json.dumps({
    "implementation": sys.implementation.name,
    "executable": os.path.realpath(sys._base_executable),
    "prefix": os.path.realpath(sys.base_prefix),
    "version": sys.version,
    "version_info": list(sys.version_info[:2]),
    "abiflags": getattr(sys, "abiflags", ""),
}))
"""


@dataclass(frozen=True)
class PluginPython:
    # The interpreter of the installation, which a plugin's environment is built on.
    executable: Path
    # The installation, which a sandbox lets plugins read.
    prefix: Path
    version: str
    # The wheel tags it installs.
    tags: frozenset[Tag]

    @property
    def marker(self) -> str:
        """What an install built on it records, so one built on another Python is built again."""
        return f"{self.executable}\n{self.version}\n"


def plugin_python(interpreter: str) -> PluginPython:
    """The Python ``interpreter`` runs: a path, or a command on ``PATH``."""
    found = shutil.which(interpreter)
    if found is None:
        raise RuntimeError(f"plugin_python {interpreter!r} is not an executable")
    try:
        completed = subprocess.run(
            [found, "-I", "-c", _PROBE], env={}, capture_output=True, text=True, timeout=PROBE_TIMEOUT, check=False
        )
    except OSError as error:
        raise RuntimeError(f"plugin_python {interpreter!r} cannot run: {error}") from None
    if completed.returncode:
        raise RuntimeError(f"plugin_python {interpreter!r} failed: {completed.stderr.strip() or f'exit {completed.returncode}'}")
    answer = json.loads(completed.stdout)
    if answer["implementation"] != "cpython":
        raise RuntimeError(f"plugin_python {interpreter!r} is {answer['implementation']}, not CPython")
    version = tuple(answer["version_info"])
    abi = f"cp{version[0]}{version[1]}{answer['abiflags']}"
    # This machine's platforms: the interpreter runs here too.
    platforms = list(platform_tags())
    tags = [*cpython_tags(version, [abi], platforms), *compatible_tags(version, f"cp{version[0]}{version[1]}", platforms)]
    return PluginPython(Path(answer["executable"]), Path(answer["prefix"]), answer["version"], frozenset(tags))
