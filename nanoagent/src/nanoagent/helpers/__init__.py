"""The programs NanoAgent runs in processes of their own: ``nanoagent helper <name> [args...]``.

NanoAgent runs from source, on a Python, or compiled by Nuitka (``--standalone``) into a binary
with no Python interpreter and no NanoAgent source beside it. :func:`command` is how it starts a
helper either way: from source, ``<this Python> -I -m nanoagent helper <name>``; compiled, the
binary itself, ``<binary> helper <name>``. :func:`readable` is what a sandbox must let a helper
read to start. ``nanoagent/__main__.py`` sends ``helper`` here before the CLI loads, so a helper
loads only NanoAgent's package and what it imports itself.

- ``package``: a plugin folder's catalog entry, or the folder packed (nanoagent.plugin.package);
- ``verifier``: one plugin verifier function, run in the sandbox (nanoagent.helpers.verifier);
- ``egress-bridge``: inside bwrap, the sandbox's one port passed to its egress proxy
  (nanoagent.helpers.egress_bridge).

NanoAgent's own Python, which runs other code than NanoAgent's (the ``python`` tool, SWE-bench's
evaluator, the SGLang router), exists only from source: compiled, :func:`python` refuses. The
Python plugins run on is never this one but the host's ``plugin_python`` (nanoagent.plugin.python).
"""

from __future__ import annotations

import sys
from importlib import import_module
from pathlib import Path

import nanoagent

# Nuitka sets `__compiled__` in every module it compiles.
COMPILED = "__compiled__" in globals()
HELPERS = {
    "package": "nanoagent.plugin.package",
    "verifier": "nanoagent.helpers.verifier",
    "egress-bridge": "nanoagent.helpers.egress_bridge",
}


def command(name: str, *args: str) -> list[str]:
    """The command that runs the helper ``name`` on ``args`` in a fresh process."""
    if name not in HELPERS:
        raise ValueError(f"no NanoAgent helper {name!r}")
    if COMPILED:
        return [sys.executable, "helper", name, *args]
    return [sys.executable, "-I", "-m", "nanoagent", "helper", name, *args]


def readable() -> list[Path]:
    """What a helper reads to start: the binary's folder, or this Python, its environment and NanoAgent's code."""
    if COMPILED:
        return [Path(sys.executable).resolve().parent]
    return sorted({Path(sys.base_prefix), Path(sys.prefix), Path(nanoagent.__file__).resolve().parents[1]})


def python(purpose: str) -> str:
    """NanoAgent's own Python, to run ``purpose``; a compiled NanoAgent has none."""
    if COMPILED:
        raise RuntimeError(f"{purpose} needs NanoAgent's own Python, and this NanoAgent is compiled: run it from source")
    return sys.executable


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in HELPERS:
        print(f"usage: nanoagent helper {{{'|'.join(HELPERS)}}} [args...]", file=sys.stderr)
        return 2
    return import_module(HELPERS[argv[0]]).main(argv[1:])
