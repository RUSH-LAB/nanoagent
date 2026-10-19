"""Plugins installed from their packages, each by its package's sha256, to run in the sandbox.

A host runs only what it installed here. :meth:`Installs.install` takes a package (see
:mod:`nanoagent.plugin.package`) and the sha256 it is known by, and:

1. checks the package against every plugin rule in an isolated process (:func:`inspect_package`);
2. opens it into ``<root>/<sha256>/<id>/`` and loads it, refusing a manifest that reads anything
   from this host's environment (it would load differently here than in isolation), and, in a
   sandbox, one that asks for environment variables, which a sandbox never passes on;
3. builds the plugin's environment before any run, which is offline, with ``uv sync`` in the
   sandbox (``nanoagent.plugin.sandbox``), reaching only the package indexes and GitHub (its file
   host too, for a build that fetches a large file from a repo), on the Python plugins run on
   (nanoagent.plugin.python).
   It syncs twice: first every package of the plugin's ``uv.lock`` with a wheel for this Python,
   from the uv cache every install shares, with ``--no-build`` so nothing of the plugin's runs
   while that cache is writable; then the rest (the plugin itself, its path and git sources, and
   packages with no such wheel), built with a cache of its own. The first sync copies, so the
   environment the build writes into holds no link into the shared cache.

:meth:`Installs.view` opens a package for its page alone, loading and running none of it, so a
package this host refuses (one made for a spec it does not run) still shows the sessions people had
with it. Views are kept while the process runs.

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
import threading
import time
import tomllib
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from packaging.tags import Tag
from packaging.utils import InvalidWheelFilename, parse_wheel_filename

from nanoagent.plugin import sandbox
from nanoagent.plugin.manifest import SPEC, PluginError, PluginManifest, load_manifest, page_files, plugin_spec, spec_module, ui_files
from nanoagent.plugin.package import PackageError, catalog_entry, inspect_package, unpack
from nanoagent.plugin.python import PluginPython

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
# Followed by `--python <the Python plugins run on>`.
SYNC = ("uv", "sync", "--frozen", "--no-dev")
SYNC_TIMEOUT = 600.0
# Written into an install's folder once it finishes, holding its Python's marker and the folder: a
# plugin's .venv holds absolute paths, so a kept install built on another Python, or in another
# folder (moved since), is redone.
INSTALLED = "installed"
# An install's folder is named by the first FOLDER_HEX hex digits of its sha256 (128 bits, which an author
# cannot match with another package): Windows opens no path of 260 characters or more, and the full 64
# put a plugin's editable-install .pth beyond it, so Python never found the plugin's own code.
FOLDER_HEX = 32
# Where views are opened, under the installs' root: removed on starting, as no install is there.
VIEWS = "views"


class InstallError(RuntimeError):
    """A package that follows the rules but could not be installed here."""


def ui_version(root: Path, page: Path) -> str:
    """A digest of the page as served, the ``ui/`` of the plugin folder ``root`` in its spec's page
    folder ``page``: its files' URLs carry it, so a browser may keep them forever."""
    digest = hashlib.sha256()
    for base, files in ((page, page_files(page)), (root / "ui", ui_files(root / "ui"))):
        for path in files:
            digest.update(path.relative_to(base).as_posix().encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()[:16]


@dataclass(frozen=True)
class Installed:
    manifest: PluginManifest
    # The catalog entry, with the package's sha256 and size and the uiVersion its ui/ files carry.
    entry: dict[str, Any]

    @property
    def page(self) -> Path:
        """The page folder of the plugin's spec, which its ui/ is served in."""
        return spec_module(self.manifest.spec).PAGE


@dataclass(frozen=True)
class Viewed:
    """A package opened for its page alone: its plugin folder, of which only ``ui/`` is served, in ``page``."""

    root: Path
    page: Path
    ui_version: str


def view_page(root: Path) -> Path:
    """The page folder a viewed plugin folder ``root`` is shown in: its spec's when this NanoAgent
    runs that spec, and otherwise, as for a package made before plugins declared their spec, the
    newest spec's, :data:`SPEC`'s."""
    try:
        spec = plugin_spec(root)
    except PluginError:
        spec = SPEC
    return spec_module(spec).PAGE


def install_marker(folder: Path, python: PluginPython) -> str:
    """What an install that finished in ``folder``, on ``python``, holds in its INSTALLED file."""
    return f"{python.marker}{folder}\n"


def _finished(folder: Path, python: PluginPython) -> bool:
    """Whether ``folder`` holds an install that finished there, on ``python``."""
    marker = folder / INSTALLED
    return marker.is_file() and marker.read_text(encoding="utf-8") == install_marker(folder, python)


def built_here(lock: Path, tags: frozenset[Tag]) -> list[str]:
    """The packages of the ``uv.lock`` at ``lock`` that have no wheel from a package index for
    ``tags``, a Python's: they are built, so only in the second sync."""

    def installable(package: dict[str, Any]) -> bool:
        files = (unquote(wheel["url"].rsplit("/", 1)[-1]) for wheel in package.get("wheels", []))
        return "registry" in package["source"] and any(tags & parse_wheel_filename(file)[3] for file in files)

    try:
        packages = tomllib.loads(lock.read_text(encoding="utf-8")).get("package", [])
        return [package["name"] for package in packages if not installable(package)]
    except InvalidWheelFilename as error:
        raise InstallError(f"uv.lock: {error}") from None


class Installs:
    """The plugins installed under ``root`` on ``python``, sharing the uv cache ``cache``: folders
    of this process's own. An install no caller installed for ``unused_days`` is removed on starting."""

    def __init__(self, root: str | Path, cache: str | Path, unused_days: int, python: PluginPython) -> None:
        self.python = python
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.cache = Path(cache).resolve()
        self.cache.mkdir(parents=True, exist_ok=True)
        # Each install's marker is touched whenever it is installed, so its age is how long it went unused.
        cutoff = time.time() - unused_days * 86_400
        for folder in self.root.iterdir():
            if not (_finished(folder, python) and (folder / INSTALLED).stat().st_mtime >= cutoff):
                shutil.rmtree(folder)
        subprocess.run(["uv", "cache", "prune", "--quiet"], env={**os.environ, "UV_CACHE_DIR": str(self.cache)}, check=True)
        self._installed: dict[str, Installed] = {}
        self._viewed: dict[str, Viewed] = {}
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
        folder = self.root / sha256[:FOLDER_HEX]
        with lock:
            if sha256 in self._installed:
                (folder / INSTALLED).touch()
                return self._installed[sha256]
            entry = inspect_package(data)
            kept = _finished(folder, self.python)
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
                    (folder / INSTALLED).write_text(install_marker(folder, self.python), encoding="utf-8")
            except BaseException:
                shutil.rmtree(folder, ignore_errors=True)
                raise
            (folder / INSTALLED).touch()
            installed = Installed(manifest, {**entry, "uiVersion": ui_version(manifest.root, spec_module(manifest.spec).PAGE)})
            self._installed[sha256] = installed
            return installed

    def viewed(self, sha256: str) -> Viewed | None:
        return self._viewed.get(sha256)

    def view(self, sha256: str, data: bytes) -> Viewed:
        """Open the package ``data``, known by ``sha256``, for its page alone; opening it again returns it as it is."""
        if not SHA256.fullmatch(sha256):
            raise PackageError([f"{sha256!r} is not a sha256"])
        if hashlib.sha256(data).hexdigest() != sha256:
            raise PackageError(["the package's sha256 is not the one it was sent as"])
        with self._guard:
            lock = self._locks[sha256]
        folder = self.root / VIEWS / sha256[:FOLDER_HEX]
        with lock:
            if sha256 in self._viewed:
                return self._viewed[sha256]
            shutil.rmtree(folder, ignore_errors=True)
            folder.mkdir(parents=True)
            try:
                plugin = folder / unpack(data, folder)
            except BaseException:
                shutil.rmtree(folder, ignore_errors=True)
                raise
            page = view_page(plugin)
            viewed = Viewed(plugin, page, ui_version(plugin, page))
            self._viewed[sha256] = viewed
            return viewed

    def _sync(self, plugin: Path) -> None:
        shared = {"UV_CACHE_DIR": str(self.cache), "UV_LINK_MODE": "copy"}
        sync = [*SYNC, "--python", str(self.python.executable)]
        skipped = [arg for name in built_here(plugin / "uv.lock", self.python.tags) for arg in ("--no-install-package", name)]
        self._run([*sync, "--no-build", *skipped], plugin, shared, [plugin, self.cache])
        self._run(sync, plugin, {}, [plugin])

    def _run(self, sync: Sequence[str], plugin: Path, env: dict[str, str], writable: list[Path]) -> None:
        with sandbox.launch(sync, root=plugin, env=env, writable=writable, hosts=INSTALL_HOSTS) as (argv, launch_env):
            completed = subprocess.run(
                argv, cwd=plugin, env=launch_env, capture_output=True, text=True, timeout=SYNC_TIMEOUT, check=False
            )
        if completed.returncode:
            reason = (completed.stderr or completed.stdout).strip().splitlines()[-3:]
            raise InstallError(f"uv sync failed: {' '.join(reason) or f'exit {completed.returncode}'}")
