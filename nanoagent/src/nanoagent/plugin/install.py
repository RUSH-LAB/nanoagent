"""Plugins installed from their packages, each by its package's sha256, to run in the sandbox.

A host runs only what it installed here. :meth:`Installs.install` takes a package (see
:mod:`nanoagent.plugin.package`) and the sha256 it is known by, and:

1. checks the package against every plugin rule in an isolated process (:func:`inspect_package`);
2. opens it into ``<root>/<sha256>/<id>/`` and loads it, refusing a manifest that reads anything
   from this host's environment (it would load differently here than in isolation), and, in a
   sandbox, one that asks for environment variables, which a sandbox never passes on;
3. runs ``uv sync`` in the sandbox (``nanoagent.plugin.sandbox``), reaching only the package
   indexes and GitHub, so the plugin's environment is built before any run, which is offline.

A sha256 names one package's exact bytes, so an install never changes. Installs live as long as
the process: one that starts again has none, and its caller installs again.
"""

from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
import threading
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from nanoagent.plugin import sandbox
from nanoagent.plugin.manifest import TOOL_ARTIFACTS, PluginManifest, load_manifest
from nanoagent.plugin.package import PackageError, catalog_entry, inspect_package, unpack

SHA256 = re.compile(r"[0-9a-f]{64}")
# Where `uv sync` fetches a plugin's dependencies: the package index and git sources on GitHub.
INSTALL_HOSTS = ("pypi.org", "files.pythonhosted.org", "github.com", "codeload.github.com")
SYNC = ("uv", "sync", "--frozen", "--no-dev")
SYNC_TIMEOUT = 600.0


class InstallError(RuntimeError):
    """A package that follows the rules but could not be installed here."""


def ui_version(manifest: PluginManifest) -> str:
    """A digest of the plugin's ``ui/``: its files' URLs carry it, so a browser may keep them forever."""
    ui = manifest.root / "ui"
    digest = hashlib.sha256()
    for path in sorted(ui.rglob("*")):
        if path.is_file() and not TOOL_ARTIFACTS & set(path.relative_to(ui).parts):
            digest.update(path.relative_to(ui).as_posix().encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()[:16]


@dataclass(frozen=True)
class Installed:
    manifest: PluginManifest
    # The catalog entry, with the package's sha256 and size and the uiVersion its ui/ files carry.
    entry: dict[str, Any]


class Installs:
    """The plugins installed under ``root``, a folder of this process's own."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._installed: dict[str, Installed] = {}
        # One lock per sha256, so a package installs once however many ask at the same time.
        self._locks: defaultdict[str, threading.Lock] = defaultdict(threading.Lock)
        self._guard = threading.Lock()

    def get(self, sha256: str) -> Installed | None:
        return self._installed.get(sha256)

    def install(self, sha256: str, data: bytes) -> Installed:
        """Install the package ``data``, known by ``sha256``; installing it again returns it as it is."""
        if not SHA256.fullmatch(sha256):
            raise PackageError([f"{sha256!r} is not a sha256"])
        if hashlib.sha256(data).hexdigest() != sha256:
            raise PackageError(["the package's sha256 is not the one it was sent as"])
        with self._guard:
            lock = self._locks[sha256]
        with lock:
            if sha256 in self._installed:
                return self._installed[sha256]
            entry = inspect_package(data)
            folder = self.root / sha256
            # Left by an install that did not finish.
            shutil.rmtree(folder, ignore_errors=True)
            folder.mkdir()
            try:
                plugin = folder / unpack(data, folder)
                manifest = load_manifest(plugin)
                if {**catalog_entry(manifest), "sha256": entry["sha256"], "size": entry["size"]} != entry:
                    raise PackageError(["the plugin's manifest reads this host's environment"])
                if manifest.env and sandbox.current() != "none":
                    raise PackageError([f"the plugin needs {', '.join(manifest.env)}; a sandboxed host passes no variables"])
                self._sync(plugin)
            except BaseException:
                shutil.rmtree(folder, ignore_errors=True)
                raise
            installed = Installed(manifest, {**entry, "uiVersion": ui_version(manifest)})
            self._installed[sha256] = installed
            return installed

    def _sync(self, plugin: Path) -> None:
        with sandbox.launch(SYNC, root=plugin, env={}, writable=[plugin], hosts=INSTALL_HOSTS) as (argv, env):
            completed = subprocess.run(
                argv, cwd=plugin, env=env, capture_output=True, text=True, timeout=SYNC_TIMEOUT, check=False
            )
        if completed.returncode:
            reason = (completed.stderr or completed.stdout).strip().splitlines()[-3:]
            raise InstallError(f"uv sync failed: {' '.join(reason) or f'exit {completed.returncode}'}")
