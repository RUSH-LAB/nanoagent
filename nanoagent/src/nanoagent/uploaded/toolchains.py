"""Pinned toolchain profiles and their dependency resolvers.

A manifest's `toolchain` ID selects a profile: the build and runtime images (pinned by digest, never
by tag), the resolver that stages a verified dependency closure from the declared lockfiles, and the
offline policy of the build sandbox. Profiles live in [TOOLCHAINS], so adding a language is a new
row plus, when its dependency staging differs, a new resolver.

The Python resolver stages every wheel on the worker side: it reads the pinned, hashed requirements
(`requirements.txt` with `--hash` pins, or `uv.lock`), downloads each from the configured index, and
verifies every sha256. A dependency that is missing, unhashed, only available as a source
distribution, or whose bytes differ from the pinned hash fails the build. The closure is mounted
read-only into the build sandbox, which has no network, as the only package source.
"""

from __future__ import annotations

import hashlib
import platform
import re
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Protocol

from packaging import tags
from packaging.markers import InvalidMarker
from packaging.requirements import InvalidRequirement, Requirement
from packaging.utils import InvalidWheelFilename, canonicalize_name, parse_wheel_filename

from nanoagent.uploaded.contract import ContractError

MAX_WHEEL_BYTES = 512 << 20
MAX_LOCKFILE_BYTES = 8 << 20
DEPENDENCY_MOUNT = "/deps"


class ToolchainError(ContractError):
    """A toolchain or dependency problem; `code` is stable (`unknown_toolchain`, `dependency_unavailable`, ...)."""


@dataclass(frozen=True)
class OfflinePolicy:
    """What the build sandbox may do: no network at all, dependencies only from the read-only closure."""

    network: str  # always "none": the closure is staged by the worker beforehand
    dependency_mount: str
    env: Mapping[str, str]


@dataclass(frozen=True)
class ToolchainProfile:
    id: str
    build_image: str  # name@sha256:<digest>
    runtime_image: str
    resolver: str  # key into RESOLVER_KINDS
    offline: OfflinePolicy
    runtime_env: Mapping[str, str] = field(default_factory=dict)  # platform-owned runtime environment


_DIGEST_REF = re.compile(r"^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$")

# python:3.12-slim, the multi-architecture index digest (linux/amd64 and linux/arm64).
_PYTHON_3_12_SLIM = "python@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b"

# Idle container that keeps a sandbox's tmpfs volumes mounted after the sandbox itself stops, so the
# worker can still copy results out. Pinned like every other image.
HOLDER_IMAGE = _PYTHON_3_12_SLIM

_DEBIAN = "debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc"  # bookworm-slim
_GCC_14 = "gcc@sha256:5e927c284bf55a7dc796262e311a0703344f62f41f5621eb56843111b1d37e15"  # 14-bookworm
_RUST_1_90 = "rust@sha256:64232e656c058f4468e8d024e990acff04f0fd5a5c0a88a574dc37773d7325c9"  # 1.90-slim-bookworm
_GO_1_24 = "golang@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac"  # 1.24-bookworm
_NODE_22 = "node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee"  # 22-bookworm-slim
_JDK_21 = "eclipse-temurin@sha256:432e54724c3e57d1846aeb886f4d339f3b0522931c4e64119c2797013b7cfc3c"  # 21-jdk-jammy
_JRE_21 = "eclipse-temurin@sha256:dff6eb46527bd293a3c06bbbe9e64e8c9f91f01905b5abbdad31761c03059d2c"  # 21-jre-jammy


def _offline(**env: str) -> OfflinePolicy:
    return OfflinePolicy(network="none", dependency_mount=DEPENDENCY_MOUNT, env=env)


TOOLCHAINS: Mapping[str, ToolchainProfile] = {
    # C++: no dependencies; link statically so the plain Debian runtime image needs no shared libraries.
    "cpp-20": ToolchainProfile("cpp-20", _GCC_14, _DEBIAN, "none", _offline()),
    # Rust: crates vendored from Cargo.lock; the build runs from /build-out (executable) because build scripts cannot run from /tmp.
    "rust-1": ToolchainProfile("rust-1", _RUST_1_90, _DEBIAN, "cargo-lock", _offline(CARGO_HOME="/tmp/cargo", CARGO_NET_OFFLINE="true")),
    # Go: a file GOPROXY over the staged module zips; go.sum is verified by the worker and again by the go command.
    "go-1": ToolchainProfile(
        "go-1", _GO_1_24, _DEBIAN, "go-sum",
        _offline(
            GOPROXY=f"file://{DEPENDENCY_MOUNT}/proxy", GOSUMDB="off", GOFLAGS="-mod=readonly", GOMODCACHE="/tmp/gomod",
            GOCACHE="/tmp/gocache", GOPATH="/tmp/go", GOTOOLCHAIN="local", CGO_ENABLED="0",
        ),
    ),
    # JavaScript and TypeScript: the lock's tarballs are verified and unpacked at /deps/node_modules (no npm run, no install scripts).
    "typescript-5": ToolchainProfile("typescript-5", _NODE_22, _NODE_22, "npm-lock", _offline(npm_config_offline="true")),
    "javascript-22": ToolchainProfile("javascript-22", _NODE_22, _NODE_22, "npm-lock", _offline(npm_config_offline="true")),
    # Java: the jars of maven.lock at /deps/lib.
    "java-21": ToolchainProfile("java-21", _JDK_21, _JRE_21, "maven-lock", _offline()),

    "python-3": ToolchainProfile(
        id="python-3",
        build_image=_PYTHON_3_12_SLIM,
        runtime_image=_PYTHON_3_12_SLIM,
        resolver="python-hashed-wheels",
        offline=OfflinePolicy(
            network="none",
            dependency_mount=DEPENDENCY_MOUNT,
            env={
                "PIP_NO_INDEX": "1",
                "PIP_FIND_LINKS": DEPENDENCY_MOUNT,
                "PIP_DISABLE_PIP_VERSION_CHECK": "1",
                "PIP_NO_CACHE_DIR": "1",
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        ),
        runtime_env={"PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"},
    ),
}


def toolchain(toolchain_id: str) -> ToolchainProfile:
    profile = TOOLCHAINS.get(toolchain_id)
    if profile is None:
        raise ToolchainError("unknown_toolchain", f"toolchain {toolchain_id!r} is not published; known: {', '.join(sorted(TOOLCHAINS))}")
    return profile


for _profile in TOOLCHAINS.values():
    for _image in (_profile.build_image, _profile.runtime_image):
        if not _DIGEST_REF.match(_image):
            raise ToolchainError("unpinned_image", f"toolchain {_profile.id} image {_image!r} is not pinned by digest")


@dataclass(frozen=True)
class DependencyClosure:
    """The verified dependency files on the worker, ready to mount read-only."""

    directory: Path
    files: Mapping[str, str]  # file name to sha256

    @property
    def empty(self) -> bool:
        return not self.files


@dataclass(frozen=True)
class PinnedRequirement:
    name: str  # canonical
    version: str
    hashes: frozenset[str]  # hex sha256, any of which a file may match
    filenames: frozenset[str] = frozenset()  # known file names (uv.lock); empty when only hashes pin the files


def _read_lockfile(source_root: Path, relative: str) -> bytes:
    path = source_root / relative
    if path.is_symlink() or not path.is_file():
        raise ToolchainError("lockfile_missing", f"declared lockfile {relative} is not a regular file in the source")
    size = path.stat().st_size
    if size > MAX_LOCKFILE_BYTES:
        raise ToolchainError("lockfile_too_large", f"{relative} is {size} bytes, over {MAX_LOCKFILE_BYTES}")
    return path.read_bytes()


def _logical_lines(text: str) -> list[str]:
    lines: list[str] = []
    pending = ""
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#") and not pending:
            continue
        if " #" in line:
            line = line[: line.index(" #")].rstrip()
        if line.endswith("\\"):
            pending += line[:-1] + " "
            continue
        lines.append((pending + line).strip())
        pending = ""
    if pending:
        lines.append(pending.strip())
    return [line for line in lines if line]


_HASH = re.compile(r"--hash=sha256:([0-9a-f]{64})")


def parse_requirements(text: str, where: str) -> list[tuple[Requirement, frozenset[str]]]:
    """Parses a hash-pinned requirements file. Anything that could change what is installed is rejected."""
    parsed: list[tuple[Requirement, frozenset[str]]] = []
    for line in _logical_lines(text):
        if line.startswith("-"):
            raise ToolchainError("unsupported_lockfile_directive", f"{where}: {line.split()[0]} is not allowed in a lockfile")
        hashes = frozenset(_HASH.findall(line))
        spec = _HASH.sub("", line).strip()
        if "--" in spec:
            raise ToolchainError("unsupported_lockfile_directive", f"{where}: unsupported option in {line!r}")
        try:
            requirement = Requirement(spec)
        except InvalidRequirement as error:
            raise ToolchainError("invalid_lockfile", f"{where}: cannot parse {spec!r}: {error}") from error
        if requirement.url:
            raise ToolchainError("unsupported_lockfile_directive", f"{where}: {requirement.name} is a direct URL, not an index pin")
        pins = [s for s in requirement.specifier if s.operator == "=="]
        if len(pins) != 1 or len(list(requirement.specifier)) != 1 or pins[0].version.endswith(".*"):
            raise ToolchainError("unpinned_requirement", f"{where}: {requirement.name} must be pinned with a single ==")
        if not hashes:
            raise ToolchainError("unhashed_requirement", f"{where}: {requirement.name} has no --hash=sha256 pin")
        parsed.append((requirement, hashes))
    return parsed


def parse_uv_lock(data: bytes, where: str) -> list[PinnedRequirement]:
    try:
        document = tomllib.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ToolchainError("invalid_lockfile", f"{where}: not a valid uv.lock: {error}") from error
    pins: list[PinnedRequirement] = []
    for package in document.get("package", []):
        name, version, source = package.get("name"), package.get("version"), package.get("source", {})
        if set(source) & {"virtual", "editable", "directory"}:
            continue  # the project itself
        if "registry" not in source:
            raise ToolchainError("unsupported_lockfile_directive", f"{where}: {name} is not from a registry ({', '.join(source)})")
        wheels = package.get("wheels", [])
        if not wheels:
            raise ToolchainError("dependency_unavailable", f"{where}: {name} {version} has no wheels, only a source distribution")
        hashes = frozenset(w["hash"].removeprefix("sha256:") for w in wheels if str(w.get("hash", "")).startswith("sha256:"))
        names = frozenset(urllib.parse.unquote(w["url"].rsplit("/", 1)[-1]) for w in wheels if "url" in w)
        if len(hashes) != len(wheels):
            raise ToolchainError("unhashed_requirement", f"{where}: {name} has a wheel without a sha256")
        pins.append(PinnedRequirement(canonicalize_name(name), str(version), hashes, names))
    return pins


@dataclass(frozen=True)
class PythonTarget:
    """What the runtime image can install: CPython 3.12 on glibc Linux."""

    python: tuple[int, int] = (3, 12)
    machine: str = field(default_factory=lambda: platform.machine().lower())

    @property
    def arch(self) -> str:
        return {"arm64": "aarch64", "amd64": "x86_64"}.get(self.machine, self.machine)

    def compatible_tags(self) -> frozenset[tags.Tag]:
        arch = self.arch
        platforms = [f"manylinux_2_{minor}_{arch}" for minor in range(36, 4, -1)]
        platforms += [f"manylinux2014_{arch}", f"manylinux2010_{arch}", f"manylinux1_{arch}", f"linux_{arch}"]
        interpreter = f"cp{self.python[0]}{self.python[1]}"
        found = list(tags.cpython_tags(self.python, abis=[interpreter, "abi3"], platforms=platforms))
        found += list(tags.compatible_tags(self.python, interpreter=interpreter, platforms=platforms))
        return frozenset(found)

    def marker_environment(self) -> dict[str, str]:
        return {
            "python_version": f"{self.python[0]}.{self.python[1]}",
            "python_full_version": f"{self.python[0]}.{self.python[1]}.0",
            "implementation_name": "cpython",
            "platform_python_implementation": "CPython",
            "sys_platform": "linux",
            "platform_system": "Linux",
            "os_name": "posix",
            "platform_machine": self.arch,
            "extra": "",
        }


class WheelIndex(Protocol):
    def candidates(self, name: str, version: str) -> list[tuple[str, str | None, Callable[[], bytes]]]:
        """(file name, sha256 the index advertises or None, fetch) for each file of the release."""
        ...


@dataclass(frozen=True)
class DirectoryIndex:
    """A flat directory of wheel files: the local mock index used by acceptance."""

    root: Path

    def candidates(self, name: str, version: str) -> list[tuple[str, str | None, Callable[[], bytes]]]:
        found = []
        for path in sorted(self.root.glob("*.whl")):
            try:
                wheel_name, wheel_version, _, _ = parse_wheel_filename(path.name)
            except InvalidWheelFilename:
                continue
            if wheel_name == name and str(wheel_version) == version:
                found.append((path.name, None, path.read_bytes))
        return found


class _SimpleLinks(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(href)


@dataclass(frozen=True)
class SimpleIndex:
    """A PEP 503 simple index over HTTP(S): PyPI in production or a local server in acceptance."""

    base_url: str
    timeout_s: float = 60.0

    def _get(self, url: str, limit: int) -> bytes:
        if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
            raise ToolchainError("index_unavailable", f"refusing non-HTTP index URL {url}")
        try:
            with urllib.request.urlopen(url, timeout=self.timeout_s) as response:  # noqa: S310 - scheme checked above
                data = response.read(limit + 1)
        except (urllib.error.URLError, OSError) as error:
            raise ToolchainError("index_unavailable", f"cannot fetch {url}: {error}") from error
        if len(data) > limit:
            raise ToolchainError("dependency_too_large", f"{url} exceeds {limit} bytes")
        return data

    def candidates(self, name: str, version: str) -> list[tuple[str, str | None, Callable[[], bytes]]]:
        page_url = f"{self.base_url.rstrip('/')}/{name}/"
        parser = _SimpleLinks()
        parser.feed(self._get(page_url, 16 << 20).decode("utf-8", "replace"))
        found = []
        for href in parser.links:
            url = urllib.parse.urljoin(page_url, href)
            parts = urllib.parse.urlsplit(url)
            filename = urllib.parse.unquote(parts.path.rsplit("/", 1)[-1])
            try:
                wheel_name, wheel_version, _, _ = parse_wheel_filename(filename)
            except InvalidWheelFilename:
                continue
            if wheel_name != name or str(wheel_version) != version:
                continue
            advertised = parts.fragment.removeprefix("sha256=") if parts.fragment.startswith("sha256=") else None
            found.append((filename, advertised, lambda u=url: self._get(u, MAX_WHEEL_BYTES)))
        return found


def open_index(url: str) -> WheelIndex:
    """`https://…/simple/` or `http://…` for a simple index; a directory path or `file://` for a flat wheel directory."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme in ("http", "https"):
        return SimpleIndex(url)
    if parts.scheme == "file":
        return DirectoryIndex(Path(urllib.parse.unquote(parts.path)))
    if parts.scheme == "":
        return DirectoryIndex(Path(url))
    raise ToolchainError("index_unavailable", f"unsupported index URL scheme {parts.scheme!r}")


class PythonWheelResolver:
    """Stages the verified wheel closure for the `python-3` toolchain."""

    def __init__(self, index: WheelIndex, target: PythonTarget | None = None) -> None:
        self._index = index
        self._target = target or PythonTarget()

    def _applies(self, requirement: Requirement) -> bool:
        if requirement.marker is None:
            return True
        try:
            return requirement.marker.evaluate(self._target.marker_environment())
        except InvalidMarker as error:
            raise ToolchainError("invalid_lockfile", f"bad marker on {requirement.name}: {error}") from error

    def _pins(self, source_root: Path, lockfiles: tuple[str, ...]) -> list[PinnedRequirement]:
        pins: list[PinnedRequirement] = []
        for relative in lockfiles:
            data = _read_lockfile(source_root, relative)
            if relative.endswith("uv.lock"):
                pins.extend(parse_uv_lock(data, relative))
            elif relative.endswith(".txt"):
                for requirement, hashes in parse_requirements(data.decode("utf-8"), relative):
                    if self._applies(requirement):
                        version = next(iter(requirement.specifier)).version
                        pins.append(PinnedRequirement(canonicalize_name(requirement.name), version, hashes))
            else:
                raise ToolchainError("unsupported_lockfile", f"{relative}: python-3 reads requirements.txt files and uv.lock")
        return pins

    def stage(self, profile: ToolchainProfile, source_root: Path, lockfiles: tuple[str, ...], destination: Path) -> DependencyClosure:
        pins = self._pins(source_root, lockfiles)
        destination.mkdir(parents=True, exist_ok=True)
        compatible = self._target.compatible_tags()
        staged: dict[str, str] = {}
        for pin in sorted(pins, key=lambda p: (p.name, p.version)):
            files = self._stage_one(pin, compatible, destination)
            staged.update(files)
        return DependencyClosure(destination, dict(sorted(staged.items())))

    def _stage_one(self, pin: PinnedRequirement, compatible: frozenset[tags.Tag], destination: Path) -> dict[str, str]:
        candidates = self._index.candidates(pin.name, pin.version)
        if not candidates:
            raise ToolchainError("dependency_unavailable", f"{pin.name}=={pin.version} is not on the index")
        usable = []
        for filename, advertised, fetch in candidates:
            _, _, _, wheel_tags = parse_wheel_filename(filename)
            if not (wheel_tags & compatible) or (pin.filenames and filename not in pin.filenames):
                continue
            if advertised is not None and advertised not in pin.hashes:
                continue  # the index offers different bytes than the lockfile pins
            usable.append((filename, fetch))
        if not usable:
            raise ToolchainError(
                "dependency_unavailable", f"{pin.name}=={pin.version} has no installable wheel matching the pinned hashes"
            )
        staged: dict[str, str] = {}
        for filename, fetch in usable:
            data = fetch()
            digest = hashlib.sha256(data).hexdigest()
            if digest not in pin.hashes:
                raise ToolchainError(
                    "hash_mismatch", f"{filename}: sha256 {digest} is not among the pinned hashes of {pin.name}=={pin.version}"
                )
            target = destination / filename
            target.write_bytes(data)
            target.chmod(0o644)
            staged[filename] = digest
        return staged


class NoDependencyResolver:
    """For a project with `lockfiles: []`: the closure is empty and nothing is fetched."""

    def stage(self, profile: ToolchainProfile, source_root: Path, lockfiles: tuple[str, ...], destination: Path) -> DependencyClosure:
        if lockfiles:
            raise ToolchainError("unsupported_lockfile", "internal: the empty resolver was given lockfiles")
        destination.mkdir(parents=True, exist_ok=True)
        return DependencyClosure(destination, {})


def resolve_dependencies(
    profile: ToolchainProfile,
    source_root: Path,
    lockfiles: tuple[str, ...],
    destination: Path,
    *,
    index_url: str | None,
    target: PythonTarget | None = None,
) -> DependencyClosure:
    """Stages the closure for a profile. An empty `lockfiles` needs no index; any other needs `index_url`."""
    if not lockfiles:
        return NoDependencyResolver().stage(profile, source_root, lockfiles, destination)
    if index_url is None:
        raise ToolchainError("index_unavailable", "the manifest declares lockfiles but no dependency index is configured")
    if profile.resolver == "none":
        raise ToolchainError("unsupported_lockfile", f"{profile.id} takes no lockfiles; declare `lockfiles: []`")
    from nanoagent.uploaded.resolvers import ECOSYSTEMS, stage_ecosystem

    if profile.resolver in ECOSYSTEMS:
        return stage_ecosystem(profile, source_root, lockfiles, destination, index_url)
    if profile.resolver == "python-hashed-wheels":
        return PythonWheelResolver(open_index(index_url), target).stage(profile, source_root, lockfiles, destination)
    raise ToolchainError("unknown_resolver", f"toolchain {profile.id} names resolver {profile.resolver!r}")
