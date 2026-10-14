"""A plugin as one file: the ``.tar.gz`` package a marketplace stores and people download.

:func:`pack` writes a plugin that follows every rule as a package: its files under one
``<id>/`` folder, in sorted order, with fixed times and owners, so a plugin always packs to the
same bytes. Nothing its ``.gitignore`` ignores goes in, nor any :data:`TOOL_ARTIFACTS`.

:func:`inspect_package` checks a package someone uploaded without running any of it. It opens
the package into a temporary folder, refusing anything but plain files and folders under one
``<id>/`` folder named by the plugin's id, and at most :data:`PACKAGE_MAX_BYTES` packed and
:data:`UNPACKED_MAX_BYTES` / :data:`MAX_FILES` unpacked (it is inflated against that limit, so a
small package cannot unpack to a huge one). It then loads the plugin with
:func:`load_manifest` in a separate process (the ``package`` helper, :mod:`nanoagent.helpers`)
with an empty environment, so a manifest
that interpolates ``${oc.env:...}`` cannot read the host's secrets.

:func:`pack_source` makes a package from a plugin's source instead: the folder at a path inside a
source archive (a GitHub tarball, whose files sit under one top folder), held to the same limits,
packed in that same isolated process, then checked by :func:`inspect_package`.
"""

from __future__ import annotations

import fnmatch
import gzip
import hashlib
import io
import json
import subprocess
import tarfile
import zlib
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import Any

from nanoagent import helpers
from nanoagent.plugin.manifest import PLUGIN_ID, TOOL_ARTIFACTS, PluginError, PluginManifest, load_manifest

PACKAGE_MAX_BYTES = 10 * 1024 * 1024
SOURCE_MAX_BYTES = 25 * 1024 * 1024
UNPACKED_MAX_BYTES = 50 * 1024 * 1024
MAX_FILES = 2000
INSPECT_TIMEOUT = 60.0


class PackageError(ValueError):
    """A package that cannot be opened, or holds a plugin that breaks the rules; ``violations`` lists why."""

    def __init__(self, violations: list[str]) -> None:
        self.violations = violations
        super().__init__("; ".join(violations))


def catalog_entry(manifest: PluginManifest) -> dict[str, Any]:
    """The public manifest with its README and tool and task schemas inlined, for remote viewers."""
    entry = manifest.public()
    entry["readme"] = (manifest.root / "README.md").read_text(encoding="utf-8")
    for tool, definition in zip(entry["tools"], manifest.tools, strict=True):
        tool["inputSchema"] = definition.input
        tool["outputSchema"] = definition.output
    for task, definition in zip(entry["tasks"], manifest.tasks, strict=True):
        task["inputSchema"] = definition.input
        task["outputSchema"] = definition.output
    return entry


def _ignored(relative: Path, patterns: list[str]) -> bool:
    return any(
        part in TOOL_ARTIFACTS or any(fnmatch.fnmatch(part, pattern) for pattern in patterns) for part in relative.parts
    )


def pack(root: str | Path) -> bytes:
    """The package of the plugin folder ``root``, which must follow every rule."""
    manifest = load_manifest(root)
    patterns = [
        line.strip().rstrip("/")
        for line in (manifest.root / ".gitignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for path in sorted(manifest.root.rglob("*")):
                relative = path.relative_to(manifest.root)
                if not path.is_file() or _ignored(relative, patterns):
                    continue
                info = tarfile.TarInfo(f"{manifest.id}/{relative.as_posix()}")
                info.size = path.stat().st_size
                info.mode = 0o755 if path.stat().st_mode & 0o100 else 0o644
                with path.open("rb") as file:
                    archive.addfile(info, file)
    return buffer.getvalue()


def _members(archive: tarfile.TarFile) -> tuple[str, list[tarfile.TarInfo]]:
    """The package's one top folder and its members, or :class:`PackageError`."""
    members = archive.getmembers()
    if len(members) > MAX_FILES:
        raise PackageError([f"the package holds more than {MAX_FILES} entries"])
    tops: set[str] = set()
    for member in members:
        path = PurePosixPath(member.name)
        if not (member.isfile() or member.isdir()):
            raise PackageError([f"{member.name} is not a plain file or folder"])
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise PackageError([f"{member.name} is outside the package folder"])
        if member.isfile() and len(path.parts) < 2:
            raise PackageError([f"{member.name} is not inside the package folder"])
        tops.add(path.parts[0])
    if len(tops) != 1:
        raise PackageError(["the package must hold exactly one folder, named by the plugin's id"])
    return tops.pop(), members


def _unzip(data: bytes) -> bytes:
    """The tar inside the gzip ``data``, inflated no further than :data:`UNPACKED_MAX_BYTES`."""
    inflater = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    try:
        tar = inflater.decompress(data, UNPACKED_MAX_BYTES)
    except zlib.error as error:
        raise PackageError([f"the package is not a .tar.gz archive: {error}"]) from None
    if inflater.unconsumed_tail:
        raise PackageError([f"the package unpacks to more than {UNPACKED_MAX_BYTES} bytes"])
    if not inflater.eof or inflater.unused_data:
        raise PackageError(["the package is not one complete gzip stream"])
    return tar


def _isolated(*args: str) -> dict[str, Any]:
    """:func:`main` on ``args`` in a fresh process with an empty environment, its JSON answer."""
    completed = subprocess.run(
        helpers.command("package", *args),
        env={},
        capture_output=True,
        text=True,
        timeout=INSPECT_TIMEOUT,
        check=False,
    )
    if completed.returncode:
        raise RuntimeError(f"inspecting the package failed: {completed.stderr.strip() or completed.returncode}")
    return json.loads(completed.stdout)


def unpack(data: bytes, folder: Path) -> str:
    """Open the package ``data`` into the existing ``folder``; its one top folder's name."""
    if len(data) > PACKAGE_MAX_BYTES:
        raise PackageError([f"the package is over the {PACKAGE_MAX_BYTES}-byte limit"])
    try:
        with tarfile.open(fileobj=io.BytesIO(_unzip(data)), mode="r:") as archive:
            top, members = _members(archive)
            if not PLUGIN_ID.fullmatch(top):
                raise PackageError([f"the package folder {top!r} is not a plugin id"])
            archive.extractall(folder, members=members, filter="data")
    except tarfile.TarError as error:
        raise PackageError([f"the package is not a .tar.gz archive: {error}"]) from None
    return top


def inspect_package(data: bytes) -> dict[str, Any]:
    """The catalog entry of the plugin in the package ``data``, with its ``sha256`` and ``size``."""
    with TemporaryDirectory(prefix="nanoagent-package-") as folder:
        top = unpack(data, Path(folder))
        result = _isolated(str(Path(folder) / top))
    if "violations" in result:
        raise PackageError(result["violations"])
    entry = result["plugin"]
    if entry["id"] != top:
        raise PackageError([f"the package folder {top!r} must be named by the plugin's id {entry['id']!r}"])
    return {**entry, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


def _source_members(archive: tarfile.TarFile, path: str) -> list[tarfile.TarInfo]:
    """The members of the source archive under ``<top>/<path>``, or :class:`PackageError`."""
    folder = PurePosixPath(path)
    if folder.is_absolute() or ".." in folder.parts:
        raise PackageError([f"{path!r} is not a folder inside the repository"])
    members = archive.getmembers()
    tops = {PurePosixPath(member.name).parts[0] for member in members if PurePosixPath(member.name).parts}
    if len(tops) != 1:
        raise PackageError(["the source archive must hold exactly one top folder"])
    prefix = PurePosixPath(tops.pop(), *folder.parts)
    chosen = [
        member for member in members if PurePosixPath(member.name) == prefix or prefix in PurePosixPath(member.name).parents
    ]
    if not any(member.isfile() for member in chosen):
        raise PackageError([f"the repository has no plugin folder at {path or 'its root'!r}"])
    if len(chosen) > MAX_FILES:
        raise PackageError([f"the plugin folder holds more than {MAX_FILES} entries"])
    for member in chosen:
        if not (member.isfile() or member.isdir()):
            raise PackageError([f"{member.name} is not a plain file or folder"])
    return chosen


def pack_source(data: bytes, path: str) -> tuple[dict[str, Any], bytes]:
    """The catalog entry and package of the plugin at ``path`` in the source archive ``data``."""
    if len(data) > SOURCE_MAX_BYTES:
        raise PackageError([f"the source archive is over the {SOURCE_MAX_BYTES}-byte limit"])
    try:
        with tarfile.open(fileobj=io.BytesIO(_unzip(data)), mode="r:") as archive:
            members = _source_members(archive, path)
            with TemporaryDirectory(prefix="nanoagent-source-") as folder:
                archive.extractall(folder, members=members, filter="data")
                package = Path(folder) / "package.tar.gz"
                result = _isolated("pack", str(Path(folder, members[0].name.split("/")[0], path)), str(package))
                if "violations" in result:
                    raise PackageError(result["violations"])
                packed = package.read_bytes()
    except tarfile.TarError as error:
        raise PackageError([f"the source archive is not a .tar.gz archive: {error}"]) from None
    return inspect_package(packed), packed


def main(argv: list[str]) -> int:
    """``nanoagent helper package <folder>``: the folder's catalog entry or violations, as JSON;
    ``... pack <folder> <file>``: the folder packed into ``file``, or its violations."""
    try:
        if argv[0] == "pack":
            Path(argv[2]).write_bytes(pack(argv[1]))
            print(json.dumps({"packed": argv[2]}))
        else:
            print(json.dumps({"plugin": catalog_entry(load_manifest(argv[0]))}))
    except PluginError as error:
        print(json.dumps({"violations": error.violations}))
    return 0
