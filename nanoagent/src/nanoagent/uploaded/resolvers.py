"""Dependency resolvers for the compiled and JavaScript toolchains: Go, Rust, JavaScript/TypeScript and Java.

Each ecosystem has two small functions. `plan_*` reads the declared lockfiles and returns one `Artifact` per file the lock
pins: where it lives on the registry (relative to the configured base URL) and a check of its bytes against the lock's hash.
`install_*` lays the verified bytes out under the closure directory the network-less build mounts at /deps. A dependency that
is not on the registry fails with `dependency_unavailable`, one whose bytes differ from the lock with `hash_mismatch`; nothing
unlocked is ever fetched.

| Ecosystem | Lockfiles | Registry path (under the base URL) | Staged under /deps |
| --- | --- | --- | --- |
| Go | `go.mod`, `go.sum` | GOPROXY protocol: `<module>/@v/<version>.{mod,zip}` checked against go.sum `h1:` hashes | `proxy/` (a file GOPROXY) |
| Rust | `Cargo.lock` | crates.io: `crates/<name>/<name>-<version>.crate` checked against the lock's `checksum` | `vendor/` + `cargo-config.toml` |
| JavaScript, TypeScript | `package-lock.json` | the lock's `resolved` path, checked against its `integrity` | `node_modules/` as npm would lay it out |
| Java | `maven.lock` | Maven repository: `<group>/<artifact>/<version>/<artifact>-<version>.jar` checked against `sha256:` | `lib/*.jar` |

`maven.lock` has one dependency per line, `group:artifact:version sha256:<64 hex digits>`, `#` comments and blank lines allowed.
It lists the complete closure: the resolver does not follow POMs, so a transitive jar the author did not list is simply absent
from the classpath and `javac` or the JVM fails.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import platform
import re
import shutil
import tarfile
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from nanoagent.uploaded.toolchains import (
    DEPENDENCY_MOUNT,
    MAX_WHEEL_BYTES,
    DependencyClosure,
    ToolchainError,
    ToolchainProfile,
    _read_lockfile,
    read_url,
)

MAX_EXTRACTED_BYTES = 512 << 20
MAX_EXTRACTED_FILES = 50_000


@dataclass(frozen=True)
class Artifact:
    label: str  # for messages: `github.com/x/y@v1.2.3 zip`
    path: str  # relative to the registry base URL, `/` separated
    check: Callable[[bytes], None]  # raises ToolchainError("hash_mismatch") when the bytes differ from the lock
    key: str = ""  # npm: the lock's `node_modules/...` path the tarball is unpacked at


@dataclass(frozen=True)
class Ecosystem:
    lockfiles: frozenset[str]
    plan: Callable[[Path, tuple[str, ...]], list[Artifact]]
    install: Callable[[list[tuple[Artifact, bytes]], Path], None]


def _mismatch(label: str, found: str, expected: str) -> ToolchainError:
    return ToolchainError("hash_mismatch", f"{label}: the registry served {found}, the lockfile pins {expected}")


def fetch(base_url: str, path: str, label: str, *, limit: int = MAX_WHEEL_BYTES) -> bytes:
    """One file of the registry: `http(s)://` base or a local directory (`file://` or a plain path)."""
    parts = urllib.parse.urlsplit(base_url)
    if parts.scheme in ("http", "https"):
        url = f"{base_url.rstrip('/')}/{urllib.parse.quote(path, safe='/@!')}"
        try:
            data = read_url(url, 60, limit)
        except urllib.error.HTTPError as error:
            if error.code in (404, 410):
                raise ToolchainError("dependency_unavailable", f"{label} is not on the registry ({url})") from error
            raise ToolchainError("index_unavailable", f"cannot fetch {url}: {error}") from error
        except (urllib.error.URLError, OSError) as error:
            raise ToolchainError("index_unavailable", f"cannot fetch {url}: {error}") from error
    elif parts.scheme in ("", "file"):
        root = Path(urllib.parse.unquote(parts.path))
        target = root / path
        if not target.is_file():
            raise ToolchainError("dependency_unavailable", f"{label} is not on the registry ({target})")
        with target.open("rb") as handle:
            data = handle.read(limit + 1)
    else:
        raise ToolchainError("index_unavailable", f"unsupported registry URL scheme {parts.scheme!r}")
    if len(data) > limit:
        raise ToolchainError("dependency_too_large", f"{label} exceeds {limit} bytes")
    return data


def _lock_text(source_root: Path, relative: str) -> str:
    try:
        return _read_lockfile(source_root, relative).decode("utf-8")
    except UnicodeDecodeError as error:
        raise ToolchainError("invalid_lockfile", f"{relative} is not UTF-8") from error


def _contained(destination: Path, relative: str) -> Path:
    target = destination / relative
    if not target.resolve().is_relative_to(destination.resolve()):
        raise ToolchainError("invalid_dependency", f"{relative!r} escapes the closure directory")
    return target


def _write(destination: Path, relative: str, data: bytes) -> None:
    target = _contained(destination, relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    target.chmod(0o644)


def _safe_members(archive: tarfile.TarFile, label: str, strip: bool) -> list[tuple[tarfile.TarInfo, PurePosixPath]]:
    """The regular files and directories of a tarball, as paths relative to its single top directory."""
    found: list[tuple[tarfile.TarInfo, PurePosixPath]] = []
    total = 0
    for member in archive:
        if not (member.isreg() or member.isdir()):
            raise ToolchainError("invalid_dependency", f"{label}: {member.name!r} is a link or special file")
        path = PurePosixPath(member.name)
        parts = path.parts
        if path.is_absolute() or ".." in parts or "" in parts:
            raise ToolchainError("invalid_dependency", f"{label}: {member.name!r} escapes the package")
        if strip:
            parts = parts[1:]
        if not parts:
            continue
        total += member.size
        if total > MAX_EXTRACTED_BYTES or len(found) >= MAX_EXTRACTED_FILES:
            raise ToolchainError("dependency_too_large", f"{label} expands beyond the extraction limits")
        found.append((member, PurePosixPath(*parts)))
    return found


def _extract_tarball(data: bytes, destination: Path, label: str) -> dict[str, str]:
    """Extracts a `.tgz` below `destination`, dropping the top directory; returns each file's sha256."""
    hashes: dict[str, str] = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            members = _safe_members(archive, label, strip=True)
            for member, path in members:
                target = destination / path
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                source = archive.extractfile(member)
                assert source is not None
                content = source.read()
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                target.chmod(0o755 if member.mode & 0o100 else 0o644)
                hashes[path.as_posix()] = hashlib.sha256(content).hexdigest()
    except (tarfile.TarError, OSError, EOFError) as error:
        raise ToolchainError("invalid_dependency", f"{label}: not a readable tarball: {error}") from error
    return hashes


# -- Go ------------------------------------------------------------------------------------------------------------------

_GO_VERSION = re.compile(r"^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$")
_GO_MODULE = re.compile(r"^[A-Za-z0-9_~-][A-Za-z0-9._~-]*(?:/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*$")  # no empty, `.`, `..` or dot-led elements


def _go_escape(module: str) -> str:
    return re.sub(r"[A-Z]", lambda match: "!" + match.group(0).lower(), module)


def _go_hash1(files: list[tuple[str, bytes]]) -> str:
    """golang.org/x/mod/sumdb/dirhash Hash1: sha256 over `<sha256 hex>  <name>\\n` lines in name order."""
    summary = "".join(f"{hashlib.sha256(content).hexdigest()}  {name}\n" for name, content in sorted(files))
    return "h1:" + base64.b64encode(hashlib.sha256(summary.encode()).digest()).decode()


def _go_sum(text: str, where: str) -> dict[tuple[str, str], dict[str, str]]:
    pins: dict[tuple[str, str], dict[str, str]] = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 3 or not fields[2].startswith("h1:"):
            raise ToolchainError("invalid_lockfile", f"{where}:{number}: expected `module version h1:<hash>`")
        module, version, digest = fields
        if not _GO_MODULE.match(module):
            raise ToolchainError("invalid_lockfile", f"{where}:{number}: {module!r} is not a module path")
        kind = "mod" if version.endswith("/go.mod") else "zip"
        version = version.removesuffix("/go.mod")
        if not _GO_VERSION.match(version):
            raise ToolchainError("invalid_lockfile", f"{where}:{number}: {version!r} is not a module version")
        pins.setdefault((module, version), {})[kind] = digest
    return pins


def _go_requires(text: str, where: str) -> list[tuple[str, str]]:
    requires: list[tuple[str, str]] = []
    block = False
    for raw in text.splitlines():
        line = raw.split("//", 1)[0].strip()
        if not line:
            continue
        if block:
            if line == ")":
                block = False
                continue
            fields = line.split()
        elif line.startswith("require ("):
            block = True
            continue
        elif line.startswith("require "):
            fields = line.removeprefix("require ").split()
        elif line.startswith(("replace", "exclude")):
            raise ToolchainError("unsupported_lockfile_directive", f"{where}: `{line.split()[0]}` directives are not allowed")
        else:
            continue
        if len(fields) != 2:
            raise ToolchainError("invalid_lockfile", f"{where}: cannot parse requirement {raw.strip()!r}")
        requires.append((fields[0], fields[1]))
    return requires


def plan_go(source_root: Path, lockfiles: tuple[str, ...]) -> list[Artifact]:
    pins = _go_sum(_lock_text(source_root, "go.sum"), "go.sum")
    for module, version in _go_requires(_lock_text(source_root, "go.mod"), "go.mod"):
        if "zip" not in pins.get((module, version), {}):
            raise ToolchainError("unhashed_requirement", f"go.sum has no h1 hash for {module}@{version}")
    artifacts: list[Artifact] = []
    for (module, version), hashes in sorted(pins.items()):
        base = f"{_go_escape(module)}/@v/{version}"
        if "mod" in hashes:
            artifacts.append(Artifact(f"{module}@{version} go.mod", f"{base}.mod", _go_checker(f"{module}@{version} go.mod", hashes["mod"], None)))
        if "zip" in hashes:
            prefix = f"{module}@{version}/"
            artifacts.append(Artifact(f"{module}@{version} zip", f"{base}.zip", _go_checker(f"{module}@{version} zip", hashes["zip"], prefix)))
    return artifacts


def _go_checker(label: str, expected: str, prefix: str | None) -> Callable[[bytes], None]:
    def check(data: bytes) -> None:
        if prefix is None:
            found = _go_hash1([("go.mod", data)])
        else:
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    files = [(info.filename, archive.read(info)) for info in archive.infolist() if not info.is_dir()]
            except (zipfile.BadZipFile, OSError) as error:
                raise ToolchainError("invalid_dependency", f"{label}: not a readable zip: {error}") from error
            if any(not name.startswith(prefix) for name, _ in files):
                raise ToolchainError("invalid_dependency", f"{label}: a file is outside {prefix}")
            found = _go_hash1(files)
        if found != expected:
            raise _mismatch(label, found, expected)

    return check


def install_go(downloaded: list[tuple[Artifact, bytes]], destination: Path) -> None:
    for artifact, data in downloaded:
        _write(destination, f"proxy/{artifact.path}", data)


# -- Rust ----------------------------------------------------------------------------------------------------------------

_CRATES_IO = ("registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/")


def _sha256_checker(label: str, expected: str) -> Callable[[bytes], None]:
    def check(data: bytes) -> None:
        found = hashlib.sha256(data).hexdigest()
        if found != expected:
            raise _mismatch(label, found, expected)

    return check


def plan_cargo(source_root: Path, lockfiles: tuple[str, ...]) -> list[Artifact]:
    try:
        document = tomllib.loads(_lock_text(source_root, "Cargo.lock"))
    except tomllib.TOMLDecodeError as error:
        raise ToolchainError("invalid_lockfile", f"Cargo.lock: {error}") from error
    artifacts: list[Artifact] = []
    for package in document.get("package", []):
        name, version, source = package.get("name"), package.get("version"), package.get("source")
        if source is None:
            continue  # the project itself
        if source not in _CRATES_IO:
            raise ToolchainError("unsupported_lockfile_directive", f"Cargo.lock: {name} comes from {source}, not crates.io")
        checksum = package.get("checksum")
        if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ToolchainError("unhashed_requirement", f"Cargo.lock: {name} {version} has no sha256 checksum")
        if not (re.fullmatch(r"[A-Za-z0-9_-]+", str(name)) and re.fullmatch(r"[0-9A-Za-z.+-]+", str(version))):
            raise ToolchainError("invalid_lockfile", f"Cargo.lock: bad package {name!r} {version!r}")
        label = f"{name} {version}"
        artifacts.append(Artifact(label, f"crates/{name}/{name}-{version}.crate", _sha256_checker(label, checksum)))
    return artifacts


def install_cargo(downloaded: list[tuple[Artifact, bytes]], destination: Path) -> None:
    """A `cargo vendor` layout: each crate unpacked with a `.cargo-checksum.json`, and the source replacement config."""
    for artifact, data in downloaded:
        directory = PurePosixPath(artifact.path).name.removesuffix(".crate")
        files = _extract_tarball(data, destination / "vendor" / directory, artifact.label)
        package = hashlib.sha256(data).hexdigest()
        _write(destination, f"vendor/{directory}/.cargo-checksum.json", json.dumps({"files": files, "package": package}).encode())
    config = f'[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "{DEPENDENCY_MOUNT}/vendor"\n'
    _write(destination, "cargo-config.toml", config.encode())


# -- JavaScript and TypeScript -------------------------------------------------------------------------------------------

_NPM_NAME = r"(?:@[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9._-]*"
_NPM_KEY = re.compile(rf"^node_modules/{_NPM_NAME}(?:/node_modules/{_NPM_NAME})*$")
_SRI = re.compile(r"^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$")


def _integrity_checker(label: str, integrity: str) -> Callable[[bytes], None]:
    algorithms = {"sha256": 1, "sha384": 2, "sha512": 3}
    candidates = [match.groups() for token in integrity.split() if (match := _SRI.match(token))]
    if not candidates:
        raise ToolchainError("unhashed_requirement", f"package-lock.json: {label} has no sha256, sha384 or sha512 integrity")
    algorithm, expected = max(candidates, key=lambda candidate: algorithms[candidate[0]])

    def check(data: bytes) -> None:
        found = base64.b64encode(hashlib.new(algorithm, data).digest()).decode()
        if found != expected:
            raise _mismatch(label, f"{algorithm}-{found}", f"{algorithm}-{expected}")

    return check


def _npm_allows(values: object, current: str) -> bool:
    """npm's `os`/`cpu` rule: a `!x` entry excludes x; when there are plain entries, current must be one of them."""
    if not values:
        return True
    allowed = [value for value in values if not value.startswith("!")]
    return f"!{current}" not in values and (not allowed or current in allowed)


def plan_npm(source_root: Path, lockfiles: tuple[str, ...]) -> list[Artifact]:
    try:
        document = json.loads(_lock_text(source_root, "package-lock.json"))
    except json.JSONDecodeError as error:
        raise ToolchainError("invalid_lockfile", f"package-lock.json: {error}") from error
    packages = document.get("packages") if isinstance(document, dict) else None
    if not isinstance(packages, dict) or document.get("lockfileVersion") not in (2, 3):
        raise ToolchainError("invalid_lockfile", "package-lock.json must be lockfileVersion 2 or 3 with a `packages` map")
    machine = platform.machine().lower()
    cpu = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(machine, machine)
    artifacts: list[Artifact] = []
    for key, entry in sorted(packages.items()):
        if key == "" or entry.get("inBundle"):
            continue
        if not _NPM_KEY.match(key):
            raise ToolchainError(
                "invalid_lockfile", f"package-lock.json: {key!r} is not a node_modules path (workspaces and links are not supported)"
            )
        if not (_npm_allows(entry.get("os"), "linux") and _npm_allows(entry.get("cpu"), cpu)):
            continue  # an optional platform build npm would not install here
        label = f"{key.rsplit('node_modules/', 1)[1]}@{entry.get('version')}"
        resolved, integrity = entry.get("resolved"), entry.get("integrity")
        if entry.get("link") or not isinstance(resolved, str) or urllib.parse.urlsplit(resolved).scheme not in ("http", "https"):
            raise ToolchainError("unsupported_lockfile_directive", f"package-lock.json: {label} is not a registry tarball")
        if not isinstance(integrity, str):
            raise ToolchainError("unhashed_requirement", f"package-lock.json: {label} has no integrity")
        path = urllib.parse.unquote(urllib.parse.urlsplit(resolved).path).lstrip("/")
        artifacts.append(Artifact(label, path, _integrity_checker(label, integrity), key))
    return artifacts


def install_npm(downloaded: list[tuple[Artifact, bytes]], destination: Path) -> None:
    for artifact, data in downloaded:
        _extract_tarball(data, _contained(destination, artifact.key), artifact.label)


# -- Java ----------------------------------------------------------------------------------------------------------------

_MAVEN_LINE = re.compile(r"^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([A-Za-z0-9_.+-]+)\s+sha256:([0-9a-f]{64})$")


def plan_maven(source_root: Path, lockfiles: tuple[str, ...]) -> list[Artifact]:
    artifacts: list[Artifact] = []
    seen: set[tuple[str, str]] = set()
    for number, raw in enumerate(_lock_text(source_root, "maven.lock").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        match = _MAVEN_LINE.match(line)
        if match is None:
            raise ToolchainError("invalid_lockfile", f"maven.lock:{number}: expected `group:artifact:version sha256:<hex>`")
        group, artifact, version, digest = match.groups()
        if (group, artifact) in seen:
            raise ToolchainError("invalid_lockfile", f"maven.lock:{number}: {group}:{artifact} is listed twice")
        seen.add((group, artifact))
        label = f"{group}:{artifact}:{version}"
        path = f"{group.replace('.', '/')}/{artifact}/{version}/{artifact}-{version}.jar"
        artifacts.append(Artifact(label, path, _sha256_checker(label, digest)))
    return artifacts


def install_maven(downloaded: list[tuple[Artifact, bytes]], destination: Path) -> None:
    for artifact, data in downloaded:
        _write(destination, f"lib/{PurePosixPath(artifact.path).name}", data)


ECOSYSTEMS: dict[str, Ecosystem] = {
    "go-sum": Ecosystem(frozenset({"go.mod", "go.sum"}), plan_go, install_go),
    "cargo-lock": Ecosystem(frozenset({"Cargo.lock"}), plan_cargo, install_cargo),
    "npm-lock": Ecosystem(frozenset({"package-lock.json"}), plan_npm, install_npm),
    "maven-lock": Ecosystem(frozenset({"maven.lock"}), plan_maven, install_maven),
}


def stage_ecosystem(
    profile: ToolchainProfile, source_root: Path, lockfiles: tuple[str, ...], destination: Path, registry_url: str
) -> DependencyClosure:
    """Fetches and verifies every artifact the lock pins, then lays the closure out under `destination`."""
    ecosystem = ECOSYSTEMS[profile.resolver]
    if set(lockfiles) != ecosystem.lockfiles:
        raise ToolchainError("unsupported_lockfile", f"{profile.id} reads exactly: {', '.join(sorted(ecosystem.lockfiles))}")
    artifacts = ecosystem.plan(source_root, lockfiles)
    destination.mkdir(parents=True, exist_ok=True)
    downloaded: list[tuple[Artifact, bytes]] = []
    for artifact in artifacts:
        data = fetch(registry_url, artifact.path, artifact.label)
        artifact.check(data)
        downloaded.append((artifact, data))
    try:
        ecosystem.install(downloaded, destination)
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    return DependencyClosure(destination, {artifact.path: hashlib.sha256(data).hexdigest() for artifact, data in downloaded})
