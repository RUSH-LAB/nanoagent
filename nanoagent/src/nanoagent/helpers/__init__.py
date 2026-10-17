"""The programs NanoAgent runs in processes of their own: ``nanoagent helper <name> [args...]``.

:func:`command` starts a helper on this Python, through ``nanoagent.__main__.ENTRY``, so it runs
the same from source and compiled by Nuitka into one module. :func:`readable` is what a sandbox
must let a helper read to start. ``nanoagent/__main__.py`` sends ``helper`` here before the CLI
loads, so a helper loads only NanoAgent's package and what it imports itself.

- ``package``: a plugin folder's catalog entry, or the folder packed (nanoagent.plugin.package);
- ``verifier``: one plugin verifier function, run in the sandbox (nanoagent.helpers.verifier);
- ``egress-bridge``: inside bwrap or an AppContainer, the sandbox's one port passed to its egress proxy
  (nanoagent.helpers.egress_bridge);
- ``appcontainer``: on Windows, a command run in an AppContainer (nanoagent.helpers.appcontainer).

The Python plugins run on is never this one but the host's ``plugin_python`` (nanoagent.plugin.python).
"""

from __future__ import annotations

import sys
from importlib import import_module
from pathlib import Path

import nanoagent
from nanoagent.__main__ import ENTRY

HELPERS = {
    "package": "nanoagent.plugin.package",
    "verifier": "nanoagent.helpers.verifier",
    "egress-bridge": "nanoagent.helpers.egress_bridge",
    "appcontainer": "nanoagent.helpers.appcontainer",
}


def command(name: str, *args: str) -> list[str]:
    """The command that runs the helper ``name`` on ``args`` in a fresh process."""
    if name not in HELPERS:
        raise ValueError(f"no NanoAgent helper {name!r}")
    return [sys.executable, "-I", "-c", ENTRY, "helper", name, *args]


def readable() -> list[Path]:
    """What a helper reads to start: this Python, its environment and NanoAgent's code."""
    return sorted({Path(sys.base_prefix), Path(sys.prefix), Path(nanoagent.__file__).resolve().parents[1]})


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in HELPERS:
        print(f"usage: nanoagent helper {{{'|'.join(HELPERS)}}} [args...]", file=sys.stderr)
        return 2
    return import_module(HELPERS[argv[0]]).main(argv[1:])
