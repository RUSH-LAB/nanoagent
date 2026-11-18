"""Unpack a plugin package on the worker: the tar.gz the marketplace stores, checked against its SHA-256, and configure
the host sandbox its verifier runs in. The plugin's tool environment is prepared by the sandbox supervisor, inside the
pinned toolchain image (`DockerSandboxSupervisor.prepare_plugin`)."""

from __future__ import annotations

import hashlib
import io
import os
import subprocess
import sys
import tarfile
from pathlib import Path

from nanoagent.plugin import sandbox
from nanoagent.plugin.python import PluginPython, plugin_python


class PackageError(RuntimeError):
    """A plugin package that does not match its digest or layout."""


def unpack_package(data: bytes, sha256: str, plugin_id: str, folder: Path) -> Path:
    """Extract ``data`` into ``folder`` after checking its digest; returns the plugin's own folder."""
    if hashlib.sha256(data).hexdigest() != sha256:
        raise PackageError(f"the package of {plugin_id} does not match SHA-256 {sha256}")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        tops = {Path(member.name).parts[0] for member in archive.getmembers()}
        if tops != {plugin_id}:
            raise PackageError(f"the package holds {sorted(tops)}, not the one folder {plugin_id}")
        archive.extractall(folder, filter="data")
    return folder / plugin_id


def isolate() -> PluginPython:
    """Configure the sandbox plugin tools and verifiers run in on this platform; returns the Python they run on."""
    kind = {"darwin": "seatbelt", "linux": "bwrap"}.get(sys.platform)
    if kind is None:
        raise PackageError(f"benchmark isolation is unsupported on {sys.platform}")
    python = plugin_python(sys.executable)
    if kind == "bwrap" and Path(sys._base_executable).parent.parent.is_symlink() and "UV_PYTHON_INSTALL_DIR" not in os.environ:
        # uv-managed venvs may use a version alias as well as the resolved runtime prefix.
        managed = Path(subprocess.check_output(["uv", "python", "dir"], text=True).strip())
        if python.prefix.is_relative_to(managed):
            os.environ["UV_PYTHON_INSTALL_DIR"] = str(managed)
    sandbox.configure(kind, python)
    return python

