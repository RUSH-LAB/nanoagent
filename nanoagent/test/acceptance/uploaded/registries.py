"""The mocked package registries for the non-Python fixtures, generated from the fixtures' own lockfiles.

`registry(root)` lays out one directory with a sub-registry per ecosystem (`go/`, `crates/`, `npm/`, `maven/`), each with the
paths of its production registry, holding exactly the artifacts the fixtures' lockfiles pin. Every artifact is fetched once
from the real upstream, checked against the lock's own hash, and cached under `build/uploaded_acceptance/upstream-cache/`.
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from support import SCRATCH

from nanoagent.uploaded.resolvers import ECOSYSTEMS, fetch

HARNESSES = Path(__file__).resolve().parent / "harnesses"
CACHE = SCRATCH / "upstream-cache"

# toolchain resolver -> (sub-registry directory, production base URL, fixtures whose locks it serves)
UPSTREAMS = {
    "go-sum": ("go", "https://proxy.golang.org", ("go",)),
    "cargo-lock": ("crates", "https://static.crates.io", ("rust",)),
    "npm-lock": ("npm", "https://registry.npmjs.org", ("javascript", "typescript")),
    "maven-lock": ("maven", "https://repo1.maven.org/maven2", ("java",)),
}
LOCKFILES = {"go-sum": ("go.mod", "go.sum"), "cargo-lock": ("Cargo.lock",), "npm-lock": ("package-lock.json",), "maven-lock": ("maven.lock",)}

# nlohmann/json single header, staged beside the C++ fixture (the fixture has no lockfile).
JSON_HPP_URL = "https://github.com/nlohmann/json/releases/download/v3.11.3/json.hpp"
JSON_HPP_SHA256 = "9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6"


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


def registry(root: Path) -> Path:
    for resolver, (directory, base, fixtures) in UPSTREAMS.items():
        for fixture in fixtures:
            for artifact in ECOSYSTEMS[resolver].plan(HARNESSES / fixture, LOCKFILES[resolver]):
                target = root / directory / artifact.path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(upstream(base, artifact.path, artifact.label, artifact.check))
    return root


def json_hpp() -> bytes:
    def check(data: bytes) -> None:
        assert hashlib.sha256(data).hexdigest() == JSON_HPP_SHA256, "json.hpp differs from the pinned hash"

    return upstream("https://github.com", JSON_HPP_URL.removeprefix("https://github.com/"), "json.hpp", check)


def stage_fixture(name: str, destination: Path) -> Path:
    """A copy of a fixture ready to zip (the C++ one gets its pinned json.hpp)."""
    shutil.copytree(HARNESSES / name, destination)
    if name == "cpp":
        (destination / "json.hpp").write_bytes(json_hpp())
    return destination
