"""The mocked npm and PyPI registries the CLIs' installs read, generated from the shell harness's own locks.

`shell_registry(root)` lays out `root/npm/` (the registry's paths, one tarball per lock entry) and `root/pypi/` (a PEP 503 index of
the wheels the locks pin for this machine's Linux target). Every artifact is fetched once from the real upstream, checked against
the lock's own hash, and cached under `build/uploaded_acceptance/`; the worker then installs from this machine only.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import urllib.request
from pathlib import Path

from packaging.utils import canonicalize_name, parse_wheel_filename
from support import SCRATCH

from nanoagent.uploaded.reference import LOCKS
from nanoagent.uploaded.resolvers import ECOSYSTEMS, fetch
from nanoagent.uploaded.toolchains import PythonTarget, parse_requirements

CACHE = SCRATCH / "upstream-cache"
NPM_UPSTREAM = "https://registry.npmjs.org"


def upstream(base: str, path: str, label: str, check) -> bytes:
    cached = CACHE / hashlib.sha256(f"{base}/{path}".encode()).hexdigest()
    if cached.exists():
        data = cached.read_bytes()
        try:
            check(data)
            return data
        except Exception:  # noqa: BLE001 - a bad cache entry is refetched
            cached.unlink()
    data = fetch(base, path, label)
    check(data)
    CACHE.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(data)
    return data


def npm_registry(root: Path) -> None:
    for folder in sorted(LOCKS.glob("*/package-lock.json")):
        for artifact in ECOSYSTEMS["npm-lock"].plan(folder.parent, ("package-lock.json",)):
            target = root / artifact.path
            if target.is_file():
                continue  # kept between runs: the lock names the bytes, and the worker checks them
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(upstream(NPM_UPSTREAM, artifact.path, artifact.label, artifact.check))


def pypi_registry(root: Path) -> None:
    compatible = PythonTarget().compatible_tags()
    (root / "files").mkdir(parents=True, exist_ok=True)
    for requirements in sorted(LOCKS.glob("*/requirements.txt")):
        for requirement, hashes in parse_requirements(requirements.read_text(), str(requirements)):
            name, version = requirement.name, next(iter(requirement.specifier)).version
            cached = CACHE / f"pypi-{canonicalize_name(name)}-{version}.json"
            if not cached.exists():
                CACHE.mkdir(parents=True, exist_ok=True)
                with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=60) as response:
                    cached.write_bytes(response.read())
            files = json.loads(cached.read_text())["urls"]
            for wheel in files:
                if wheel["digests"]["sha256"] not in hashes or not wheel["filename"].endswith(".whl"):
                    continue
                if not parse_wheel_filename(wheel["filename"])[3] & compatible:
                    continue
                digest = wheel["digests"]["sha256"]
                if (root / "files" / wheel["filename"]).is_file():
                    continue  # already laid out by an earlier run
                kept = CACHE / wheel["filename"]
                if not kept.exists() or hashlib.sha256(kept.read_bytes()).hexdigest() != digest:
                    with urllib.request.urlopen(wheel["url"], timeout=300) as response:
                        kept.write_bytes(response.read())
                assert hashlib.sha256(kept.read_bytes()).hexdigest() == digest, wheel["filename"]
                shutil.copyfile(kept, root / "files" / kept.name)
                page = root / "simple" / canonicalize_name(name)
                page.mkdir(parents=True, exist_ok=True)
                with (page / "index.html").open("a") as index:
                    index.write(f'<a href="../../files/{kept.name}#sha256={digest}">{kept.name}</a>\n')


def shell_registry(root: Path) -> Path:
    """``root/npm`` and ``root/pypi`` for the CLIs' locks: serve ``root`` and point the worker's `javascript-22` index at ``/npm`` and
    `python-3` at ``/pypi/simple``."""
    npm_registry(root / "npm")
    pypi_registry(root / "pypi")
    return root
