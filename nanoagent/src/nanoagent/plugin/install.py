"""Plugins installed from their packages, each by its package's sha256, to run in the sandbox.

A host runs only what it installed here. :meth:`Installs.install` takes a package (see
:mod:`nanoagent.plugin.package`) and the sha256 it is known by, and:

1. checks the package against every plugin rule in an isolated process (:func:`inspect_package`);
2. opens it into ``<root>/<sha256>/<id>/`` and loads it, refusing a manifest that reads anything
   from this host's environment (it would load differently here than in isolation), and, in a
   sandbox, one that asks for environment variables, which a sandbox never passes on;
3. builds the plugin's environment before any run, which is offline, with ``uv sync`` in the
   sandbox (``nanoagent.plugin.sandbox``), reaching only the package indexes and GitHub (its file
   host too, for a build that fetches a large file from a repo), on the Python NanoAgent runs on.
   It syncs twice: first every package of the plugin's ``uv.lock`` with a wheel for this Python,
   from the uv cache every install shares, with ``--no-build`` so nothing of the plugin's runs
   while that cache is writable; then the rest (the plugin itself, its path and git sources, and
   packages with no such wheel), built with a cache of its own. The first sync copies, so the
   environment the build writes into holds no link into the shared cache.

A sha256 names one package's exact bytes, so an install never changes. A finished install is kept
on disk for the Python it was built on: when the process starts again, its caller installs again
and gets the kept one without a sync. Starting removes the installs no caller can get back as they
are, and those no caller installed for a while, which installing again builds again.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import tomllib
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from packaging.tags import sys_tags
from packaging.utils import InvalidWheelFilename, parse_wheel_filename

from nanoagent.plugin import sandbox
from nanoagent.plugin.manifest import PAGE, PluginManifest, load_manifest, page_files, ui_files
from nanoagent.plugin.package import PackageError, catalog_entry, inspect_package, unpack

SHA256 = re.compile(r"[0-9a-f]{64}")
# Where `uv sync` fetches a plugin's dependencies: the package index, git sources on GitHub, and the
# host GitHub serves a repo's large files from, which a dependency's build may fetch.
INSTALL_HOSTS = (
    "pypi.org",
    "files.pythonhosted.org",
    "github.com",
    "codeload.github.com",
    "media.githubusercontent.com",
)
# The Python every plugin's environment is built on: NanoAgent's own, which every sandbox can read.
PYTHON = Path(sys.base_prefix) / "bin" / "python3"
SYNC = ("uv", "sync", "--frozen", "--no-dev", "--python", str(PYTHON))
SYNC_TIMEOUT = 600.0
# Written into an install's folder once it finishes; a kept install whose marker differs is redone.
INSTALLED = "installed"
INTERPRETER = f"{PYTHON}\n{sys.version}\n"


class InstallError(RuntimeError):
    """A package that follows the rules but could not be installed here."""


def ui_version(manifest: PluginManifest) -> str:
    """A digest of the page as served, the plugin's ``ui/`` in :data:`PAGE`: its files' URLs carry
    it, so a browser may keep them forever."""
    digest = hashlib.sha256()
    for base, files in ((PAGE, page_files()), (manifest.root / "ui", ui_files(manifest.root / "ui"))):
        for path in files:
            digest.update(path.relative_to(base).as_posix().encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()[:16]


@dataclass(frozen=True)
class Installed:
    manifest: PluginManifest
    # The catalog entry, with the package's sha256 and size and the uiVersion its ui/ files carry.
    entry: dict[str, Any]


def _finished(folder: Path) -> bool:
    """Whether ``folder`` holds an install that finished, on this Python."""
    marker = folder / INSTALLED
    return marker.is_file() and marker.read_text(encoding="utf-8") == INTERPRETER


def built_here(lock: Path) -> list[str]:
    """The packages of the ``uv.lock`` at ``lock`` that have no wheel from a package index this
    Python can install: they are built, so only in the second sync."""
    tags = set(sys_tags())

    def installable(package: dict[str, Any]) -> bool:
        files = (unquote(wheel["url"].rsplit("/", 1)[-1]) for wheel in package.get("wheels", []))
        return "registry" in package["source"] and any(tags & parse_wheel_filename(file)[3] for file in files)

    try:
        packages = tomllib.loads(lock.read_text(encoding="utf-8")).get("package", [])
        return [package["name"] for package in packages if not installable(package)]
    except InvalidWheelFilename as error:
        raise InstallError(f"uv.lock: {error}") from None


class Installs:
    """The plugins installed under ``root``, sharing the uv cache ``cache``: folders of this
    process's own. An install no caller installed for ``unused_days`` is removed on starting."""

    def __init__(self, root: str | Path, cache: str | Path, unused_days: int) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.cache = Path(cache).resolve()
        self.cache.mkdir(parents=True, exist_ok=True)
        # Each install's marker is touched whenever it is installed, so its age is how long it went unused.
        cutoff = time.time() - unused_days * 86_400
        for folder in self.root.iterdir():
            if not (_finished(folder) and (folder / INSTALLED).stat().st_mtime >= cutoff):
                shutil.rmtree(folder)
        subprocess.run(["uv", "cache", "prune", "--quiet"], env={**os.environ, "UV_CACHE_DIR": str(self.cache)}, check=True)
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
        folder = self.root / sha256
        with lock:
            if sha256 in self._installed:
                (folder / INSTALLED).touch()
                return self._installed[sha256]
            entry = inspect_package(data)
            kept = _finished(folder)
            if not kept:
                # Left by an install that did not finish, or built on another Python.
                shutil.rmtree(folder, ignore_errors=True)
                folder.mkdir()
            try:
                plugin = folder / (entry["id"] if kept else unpack(data, folder))
                manifest = load_manifest(plugin)
                if {**catalog_entry(manifest), "sha256": entry["sha256"], "size": entry["size"]} != entry:
                    raise PackageError(["the plugin's manifest reads this host's environment"])
                if manifest.env and sandbox.current() != "none":
                    raise PackageError([f"the plugin needs {', '.join(manifest.env)}; a sandboxed host passes no variables"])
                if not kept:
                    if os.path.lexists(plugin / ".venv"):
                        raise PackageError(["the package carries a .venv; an install builds its own"])
                    self._sync(plugin)
                    (folder / INSTALLED).write_text(INTERPRETER, encoding="utf-8")
            except BaseException:
                shutil.rmtree(folder, ignore_errors=True)
                raise
            (folder / INSTALLED).touch()
            installed = Installed(manifest, {**entry, "uiVersion": ui_version(manifest)})
            self._installed[sha256] = installed
            return installed

    def _sync(self, plugin: Path) -> None:
        shared = {"UV_CACHE_DIR": str(self.cache), "UV_LINK_MODE": "copy"}
        skipped = [arg for name in built_here(plugin / "uv.lock") for arg in ("--no-install-package", name)]
        self._run([*SYNC, "--no-build", *skipped], plugin, shared, [plugin, self.cache])
        self._run(SYNC, plugin, {}, [plugin])

    def _run(self, sync: Sequence[str], plugin: Path, env: dict[str, str], writable: list[Path]) -> None:
        with sandbox.launch(sync, root=plugin, env=env, writable=writable, hosts=INSTALL_HOSTS) as (argv, launch_env):
            completed = subprocess.run(
                argv, cwd=plugin, env=launch_env, capture_output=True, text=True, timeout=SYNC_TIMEOUT, check=False
            )
        if completed.returncode:
            reason = (completed.stderr or completed.stdout).strip().splitlines()[-3:]
            raise InstallError(f"uv sync failed: {' '.join(reason) or f'exit {completed.returncode}'}")
