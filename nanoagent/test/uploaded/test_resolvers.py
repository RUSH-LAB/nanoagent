"""The Go, Rust, JavaScript and Java resolvers against local directory registries built in the test."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import tarfile
import zipfile
from pathlib import Path

import pytest

from nanoagent.uploaded.resolvers import _go_hash1, _write
from nanoagent.uploaded.toolchains import ToolchainError, resolve_dependencies, toolchain


def tgz(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def stage(toolchain_id: str, source: Path, registry: Path, lockfiles: tuple[str, ...], tmp_path: Path) -> object:
    return resolve_dependencies(toolchain(toolchain_id), source, lockfiles, tmp_path / "deps", index_url=str(registry))


def fail(code: str, *args: object) -> None:
    with pytest.raises(ToolchainError) as error:
        stage(*args)  # type: ignore[arg-type]
    assert error.value.code == code


def test_maven_stages_jars_and_rejects_missing_and_altered(tmp_path: Path) -> None:
    jar = b"PK jar bytes"
    digest = hashlib.sha256(jar).hexdigest()
    registry, source = tmp_path / "registry", tmp_path / "source"
    (registry / "org/x/lib/1.0").mkdir(parents=True)
    source.mkdir()
    (registry / "org/x/lib/1.0/lib-1.0.jar").write_bytes(jar)
    (source / "maven.lock").write_text(f"# closure\norg.x:lib:1.0 sha256:{digest}\n")
    closure = stage("java-21", source, registry, ("maven.lock",), tmp_path)
    assert (tmp_path / "deps/lib/lib-1.0.jar").read_bytes() == jar and closure.files == {"org/x/lib/1.0/lib-1.0.jar": digest}  # type: ignore[attr-defined]
    (source / "maven.lock").write_text(f"org.x:lib:1.0 sha256:{'0' * 64}\n")
    fail("hash_mismatch", "java-21", source, registry, ("maven.lock",), tmp_path)
    (source / "maven.lock").write_text(f"org.x:gone:1.0 sha256:{digest}\n")
    fail("dependency_unavailable", "java-21", source, registry, ("maven.lock",), tmp_path)
    (source / "maven.lock").write_text("org.x:lib:1.0\n")
    fail("invalid_lockfile", "java-21", source, registry, ("maven.lock",), tmp_path)


def test_npm_unpacks_verified_tarballs_as_node_modules(tmp_path: Path) -> None:
    tarball = tgz({"package/index.js": b"module.exports = 1\n", "package/package.json": b"{}"})
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
    registry, source = tmp_path / "registry", tmp_path / "source"
    (registry / "pkg/-").mkdir(parents=True)
    source.mkdir()
    (registry / "pkg/-/pkg-1.0.0.tgz").write_bytes(tarball)
    entry = {"version": "1.0.0", "resolved": "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz", "integrity": integrity}
    lock = {"lockfileVersion": 3, "packages": {"": {}, "node_modules/pkg": entry}}
    (source / "package-lock.json").write_text(json.dumps(lock))
    stage("javascript-22", source, registry, ("package-lock.json",), tmp_path)
    assert (tmp_path / "deps/node_modules/pkg/index.js").read_bytes() == b"module.exports = 1\n"
    lock["packages"]["node_modules/pkg"] = entry | {"integrity": "sha512-" + base64.b64encode(hashlib.sha512(b"x").digest()).decode()}
    (source / "package-lock.json").write_text(json.dumps(lock))
    fail("hash_mismatch", "javascript-22", source, registry, ("package-lock.json",), tmp_path)
    (registry / "pkg/-/pkg-1.0.0.tgz").unlink()
    fail("dependency_unavailable", "javascript-22", source, registry, ("package-lock.json",), tmp_path)
    lock["packages"]["node_modules/pkg"] = {key: value for key, value in entry.items() if key != "integrity"}
    (source / "package-lock.json").write_text(json.dumps(lock))
    fail("unhashed_requirement", "javascript-22", source, registry, ("package-lock.json",), tmp_path)


def test_cargo_vendors_crates_with_checksum_files(tmp_path: Path) -> None:
    crate = tgz({"dep-1.0.0/Cargo.toml": b"[package]\n", "dep-1.0.0/src/lib.rs": b""})
    digest = hashlib.sha256(crate).hexdigest()
    registry, source = tmp_path / "registry", tmp_path / "source"
    (registry / "crates/dep").mkdir(parents=True)
    source.mkdir()
    (registry / "crates/dep/dep-1.0.0.crate").write_bytes(crate)
    index = "registry+https://github.com/rust-lang/crates.io-index"
    (source / "Cargo.lock").write_text(
        f'version = 3\n[[package]]\nname = "harness"\nversion = "0.1.0"\n[[package]]\nname = "dep"\nversion = "1.0.0"\nsource = "{index}"\nchecksum = "{digest}"\n'
    )
    stage("rust-1", source, registry, ("Cargo.lock",), tmp_path)
    checksums = json.loads((tmp_path / "deps/vendor/dep-1.0.0/.cargo-checksum.json").read_text())
    assert checksums["package"] == digest and set(checksums["files"]) == {"Cargo.toml", "src/lib.rs"}
    assert "/deps/vendor" in (tmp_path / "deps/cargo-config.toml").read_text()
    (source / "Cargo.lock").write_text((source / "Cargo.lock").read_text().replace(digest, "0" * 64))
    fail("hash_mismatch", "rust-1", source, registry, ("Cargo.lock",), tmp_path)


def test_go_verifies_module_zips_and_go_mod_against_go_sum(tmp_path: Path) -> None:
    mod = b"module example.com/dep\n"
    entries = [("example.com/dep@v1.0.0/go.mod", mod), ("example.com/dep@v1.0.0/dep.go", b"package dep\n")]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries:
            archive.writestr(name, data)
    registry, source = tmp_path / "registry", tmp_path / "source"
    (registry / "example.com/dep/@v").mkdir(parents=True)
    source.mkdir()
    (registry / "example.com/dep/@v/v1.0.0.zip").write_bytes(buffer.getvalue())
    (registry / "example.com/dep/@v/v1.0.0.mod").write_bytes(mod)
    (source / "go.mod").write_text("module harness\n\ngo 1.24\n\nrequire example.com/dep v1.0.0\n")
    zip_hash, mod_hash = _go_hash1(entries), _go_hash1([("go.mod", mod)])
    (source / "go.sum").write_text(f"example.com/dep v1.0.0 {zip_hash}\nexample.com/dep v1.0.0/go.mod {mod_hash}\n")
    stage("go-1", source, registry, ("go.mod", "go.sum"), tmp_path)
    assert (tmp_path / "deps/proxy/example.com/dep/@v/v1.0.0.zip").is_file()
    (source / "go.sum").write_text(f"example.com/dep v1.0.0 {mod_hash}\nexample.com/dep v1.0.0/go.mod {mod_hash}\n")
    fail("hash_mismatch", "go-1", source, registry, ("go.mod", "go.sum"), tmp_path)
    (source / "go.sum").write_text(f"example.com/dep v1.0.0/go.mod {mod_hash}\n")
    fail("unhashed_requirement", "go-1", source, registry, ("go.mod", "go.sum"), tmp_path)
    fail("unsupported_lockfile", "go-1", source, registry, ("go.mod",), tmp_path)


def test_cpp_takes_no_lockfiles(tmp_path: Path) -> None:
    fail("unsupported_lockfile", "cpp-20", tmp_path, tmp_path, ("go.sum",), tmp_path)


def npm_source(tmp_path: Path, packages: dict[str, dict]) -> Path:
    source = tmp_path / "source"
    source.mkdir()
    (source / "package-lock.json").write_text(json.dumps({"lockfileVersion": 3, "packages": {"": {}, **packages}}))
    return source


@pytest.mark.parametrize("key", ["node_modules/x[..", "node_modules/y[/abs/path", "node_modules/../x", "/abs/node_modules/x", "node_modules//x"])
def test_npm_lock_keys_that_are_not_package_paths_are_rejected(tmp_path: Path, key: str) -> None:
    entry = {"version": "1.0.0", "resolved": "https://r.example/x/-/x-1.0.0.tgz", "integrity": "sha512-AAAA"}
    fail("invalid_lockfile", "javascript-22", npm_source(tmp_path, {key: entry}), tmp_path, ("package-lock.json",), tmp_path)


def test_npm_skips_entries_for_other_os_and_cpu_and_nests_scopes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("nanoagent.uploaded.resolvers.platform.machine", lambda: "aarch64")
    tarball = tgz({"package/index.js": b"1"})
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
    registry = tmp_path / "registry"
    (registry / "p").mkdir(parents=True)
    (registry / "p/a.tgz").write_bytes(tarball)
    entry = {"version": "1.0.0", "resolved": "https://r.example/p/a.tgz", "integrity": integrity}
    wrong = {"version": "1.0.0", "resolved": "https://r.example/p/missing.tgz", "integrity": integrity}
    source = npm_source(
        tmp_path,
        {
            "node_modules/@s/a": entry | {"os": ["linux"], "cpu": ["arm64"]},
            "node_modules/@s/a/node_modules/b": entry,
            "node_modules/x64": wrong | {"cpu": ["x64"]},
            "node_modules/win": wrong | {"os": ["win32"]},
            "node_modules/notmac": entry | {"os": ["!darwin"]},
        },
    )
    closure = stage("javascript-22", source, registry, ("package-lock.json",), tmp_path)
    assert (tmp_path / "deps/node_modules/@s/a/node_modules/b/index.js").is_file() and (tmp_path / "deps/node_modules/notmac/index.js").is_file()
    assert set(closure.files) == {"p/a.tgz"}  # type: ignore[attr-defined]


@pytest.mark.parametrize("module", ["../../../escaped", "a/../b", "/abs", "a//b", "./a", "a/.b"])
def test_go_module_paths_that_escape_are_rejected(tmp_path: Path, module: str) -> None:
    source = tmp_path / "source"
    source.mkdir()
    (source / "go.mod").write_text("module harness\n")
    (source / "go.sum").write_text(f"{module} v1.0.0 h1:AAAA\n")
    fail("invalid_lockfile", "go-1", source, tmp_path, ("go.mod", "go.sum"), tmp_path)


def test_write_refuses_paths_outside_the_closure(tmp_path: Path) -> None:
    (tmp_path / "deps").mkdir()
    with pytest.raises(ToolchainError) as error:
        _write(tmp_path / "deps", "proxy/../../escaped", b"x")
    assert error.value.code == "invalid_dependency" and not (tmp_path / "escaped").exists()
