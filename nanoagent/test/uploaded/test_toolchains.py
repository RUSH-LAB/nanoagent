"""Toolchain profiles and the Python verified-wheel resolver."""

from __future__ import annotations

import functools
import hashlib
import http.server
import threading
import zipfile
from pathlib import Path

import pytest

from nanoagent.uploaded.toolchains import (
    TOOLCHAINS,
    PythonTarget,
    ToolchainError,
    parse_requirements,
    resolve_dependencies,
    toolchain,
)

TARGET = PythonTarget(machine="aarch64")


def make_wheel(directory: Path, name: str = "demo_pkg", version: str = "1.0", tag: str = "py3-none-any", body: str = "X = 1\n") -> tuple[Path, str]:
    path = directory / f"{name}-{version}-{tag}.whl"
    with zipfile.ZipFile(path, "w") as wheel:
        wheel.writestr(f"{name}/__init__.py", body)
        wheel.writestr(f"{name}-{version}.dist-info/METADATA", f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n")
        wheel.writestr(f"{name}-{version}.dist-info/WHEEL", f"Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: {tag}\n")
        wheel.writestr(f"{name}-{version}.dist-info/RECORD", "")
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def source(tmp_path) -> Path:
    root = tmp_path / "source"
    root.mkdir()
    return root


@pytest.fixture
def index(tmp_path) -> Path:
    root = tmp_path / "index"
    root.mkdir()
    return root


def stage(source, index, tmp_path, lockfiles=("requirements.txt",), url=None):
    return resolve_dependencies(
        toolchain("python-3"), source, tuple(lockfiles), tmp_path / "deps", index_url=url or str(index), target=TARGET
    )


def test_unknown_toolchain_has_a_specific_error():
    with pytest.raises(ToolchainError) as caught:
        toolchain("cobol-85")
    assert caught.value.code == "unknown_toolchain" and "python-3" in caught.value.message


def test_every_profile_image_is_pinned_by_digest():
    for profile in TOOLCHAINS.values():
        for image in (profile.build_image, profile.runtime_image):
            assert "@sha256:" in image and len(image.split("sha256:")[1]) == 64
    assert toolchain("python-3").offline.network == "none"


def test_closure_is_staged_with_every_hash_verified(source, index, tmp_path):
    wheel, digest = make_wheel(index)
    (source / "requirements.txt").write_text(f"demo-pkg==1.0 \\\n    --hash=sha256:{digest}\n")
    closure = stage(source, index, tmp_path)
    assert closure.files == {wheel.name: digest}
    assert (closure.directory / wheel.name).read_bytes() == wheel.read_bytes()


def test_a_wheel_whose_bytes_differ_from_the_pinned_hash_fails_the_build(source, index, tmp_path):
    make_wheel(index)
    (source / "requirements.txt").write_text(f"demo-pkg==1.0 --hash=sha256:{'0' * 64}\n")
    with pytest.raises(ToolchainError) as caught:
        stage(source, index, tmp_path)
    assert caught.value.code == "hash_mismatch"


def test_a_declared_dependency_missing_from_the_index_fails(source, index, tmp_path):
    (source / "requirements.txt").write_text(f"absent==2.0 --hash=sha256:{'1' * 64}\n")
    with pytest.raises(ToolchainError) as caught:
        stage(source, index, tmp_path)
    assert caught.value.code == "dependency_unavailable" and "absent==2.0" in caught.value.message


def test_a_wheel_for_another_platform_is_not_installable(source, index, tmp_path):
    _, digest = make_wheel(index, tag="cp312-cp312-win_amd64")
    (source / "requirements.txt").write_text(f"demo-pkg==1.0 --hash=sha256:{digest}\n")
    with pytest.raises(ToolchainError) as caught:
        stage(source, index, tmp_path)
    assert caught.value.code == "dependency_unavailable"


def test_a_platform_wheel_matching_the_runtime_is_accepted(source, index, tmp_path):
    wheel, digest = make_wheel(index, tag="cp312-cp312-manylinux_2_17_aarch64.manylinux2014_aarch64")
    (source / "requirements.txt").write_text(f"demo-pkg==1.0 --hash=sha256:{digest}\n")
    assert wheel.name in stage(source, index, tmp_path).files


@pytest.mark.parametrize(
    ("line", "code"),
    [
        ("demo-pkg==1.0", "unhashed_requirement"),
        (f"demo-pkg>=1.0 --hash=sha256:{'a' * 64}", "unpinned_requirement"),
        (f"demo-pkg==1.* --hash=sha256:{'a' * 64}", "unpinned_requirement"),
        ("-r other.txt", "unsupported_lockfile_directive"),
        ("--index-url https://evil.example/simple", "unsupported_lockfile_directive"),
        (f"demo-pkg @ https://evil.example/x.whl --hash=sha256:{'a' * 64}", "unsupported_lockfile_directive"),
    ],
)
def test_lockfile_lines_that_could_change_what_installs_are_rejected(line, code):
    with pytest.raises(ToolchainError) as caught:
        parse_requirements(line + "\n", "requirements.txt")
    assert caught.value.code == code


def test_requirements_for_other_environments_are_skipped_by_marker(source, index, tmp_path):
    _, digest = make_wheel(index)
    (source / "requirements.txt").write_text(
        f"demo-pkg==1.0 --hash=sha256:{digest}\nwinonly==1.0 ; sys_platform == 'win32' --hash=sha256:{'2' * 64}\n"
    )
    assert len(stage(source, index, tmp_path).files) == 1


def test_no_lockfiles_means_an_empty_closure_without_an_index(source, tmp_path):
    closure = resolve_dependencies(toolchain("python-3"), source, (), tmp_path / "deps", index_url=None)
    assert closure.empty and closure.directory.is_dir()


def test_lockfiles_without_a_configured_index_fail_closed(source, tmp_path):
    (source / "requirements.txt").write_text("")
    with pytest.raises(ToolchainError) as caught:
        resolve_dependencies(toolchain("python-3"), source, ("requirements.txt",), tmp_path / "deps", index_url=None)
    assert caught.value.code == "index_unavailable"


def test_a_declared_lockfile_that_is_missing_or_a_link_is_rejected(source, index, tmp_path):
    with pytest.raises(ToolchainError) as caught:
        stage(source, index, tmp_path)
    assert caught.value.code == "lockfile_missing"
    (source / "real.txt").write_text("")
    (source / "requirements.txt").symlink_to(source / "real.txt")
    with pytest.raises(ToolchainError) as caught:
        stage(source, index, tmp_path)
    assert caught.value.code == "lockfile_missing"


def test_uv_lock_registry_packages_are_staged_and_the_project_is_skipped(source, index, tmp_path):
    wheel, digest = make_wheel(index)
    (source / "uv.lock").write_text(
        f"""version = 1
[[package]]
name = "app"
version = "0.1.0"
source = {{ virtual = "." }}
[[package]]
name = "demo-pkg"
version = "1.0"
source = {{ registry = "https://pypi.org/simple" }}
wheels = [{{ url = "https://files.example/{wheel.name}", hash = "sha256:{digest}", size = 1 }}]
"""
    )
    assert stage(source, index, tmp_path, lockfiles=("uv.lock",)).files == {wheel.name: digest}


def test_uv_lock_git_sources_are_rejected(source, index, tmp_path):
    (source / "uv.lock").write_text('version = 1\n[[package]]\nname = "x"\nversion = "1"\nsource = { git = "https://example/x" }\n')
    with pytest.raises(ToolchainError) as caught:
        stage(source, index, tmp_path, lockfiles=("uv.lock",))
    assert caught.value.code == "unsupported_lockfile_directive"


def test_an_http_simple_index_serves_the_closure_and_advertised_hashes_must_match(source, index, tmp_path):
    wheel, digest = make_wheel(index)
    page = index / "demo-pkg"
    page.mkdir()
    (page / "index.html").write_text(f'<a href="../{wheel.name}#sha256={digest}">{wheel.name}</a>')
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(index))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_port}"
        (source / "requirements.txt").write_text(f"demo-pkg==1.0 --hash=sha256:{digest}\n")
        assert stage(source, index, tmp_path, url=url).files == {wheel.name: digest}
        (source / "requirements.txt").write_text(f"demo-pkg==1.0 --hash=sha256:{'3' * 64}\n")
        with pytest.raises(ToolchainError) as caught:
            stage(source, index, tmp_path / "again", url=url)
        assert caught.value.code == "dependency_unavailable"
    finally:
        server.shutdown()
