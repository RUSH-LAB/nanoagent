from __future__ import annotations

import base64
import gzip
import io
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from nanoagent.plugin.package import UNPACKED_MAX_BYTES, PackageError, inspect_package, pack, pack_source
from nanoagent.runtime.config import load_config_args
from nanoagent.web.app import create_app
from nanoagent.web.config import WebConfig
from test_plugin import write_plugin

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "package-test-secret"


@pytest.fixture
def plugin(tmp_path: Path) -> Path:
    root = tmp_path / "echo"
    write_plugin(root)
    return root


def _tar(entries: dict[str, bytes], *, symlink: str | None = None) -> bytes:
    """A .tar.gz of ``entries``, plus a symlink named ``symlink``."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, content in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
        if symlink:
            info = tarfile.TarInfo(symlink)
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            archive.addfile(info)
    return buffer.getvalue()


def _files(data: bytes) -> dict[str, bytes]:
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        return {member.name: archive.extractfile(member).read() for member in archive.getmembers()}


def test_packs_a_plugin_the_same_way_every_time_without_what_git_ignores(plugin: Path) -> None:
    (plugin / "src" / "__pycache__").mkdir()
    (plugin / "src" / "__pycache__" / "echo.cpython-312.pyc").write_bytes(b"\0")
    (plugin / ".venv").mkdir()
    data = pack(plugin)
    assert data == pack(plugin)
    names = set(_files(data))
    assert "echo/nanoagent.yaml" in names and "echo/ui/kit/dom.js" in names
    assert not [name for name in names if "__pycache__" in name or ".venv" in name]


def test_refuses_to_pack_a_plugin_that_breaks_the_rules(plugin: Path) -> None:
    (plugin / "notes.txt").write_text("")
    with pytest.raises(ValueError, match="unexpected notes.txt"):
        pack(plugin)


def test_inspects_a_package_into_its_catalog_entry(plugin: Path) -> None:
    data = pack(plugin)
    entry = inspect_package(data)
    assert (entry["id"], entry["version"], entry["size"]) == ("echo", "1.0.0", len(data))
    assert entry["readme"].startswith("# Echo") and entry["tools"][0]["inputSchema"]["required"] == ["value"]


@pytest.mark.parametrize(
    ("entries", "symlink", "problem"),
    [
        ({"echo/README.md": b"", "../escape.txt": b""}, None, "outside the package folder"),
        ({"/etc/cron.d/x": b""}, None, "outside the package folder"),
        ({"echo/README.md": b"", "other/README.md": b""}, None, "exactly one folder"),
        ({"README.md": b""}, None, "not inside the package folder"),
        ({"echo/README.md": b""}, "echo/link", "not a plain file or folder"),
        ({"Echo_Plugin/README.md": b""}, None, "is not a plugin id"),
    ],
)
def test_refuses_a_package_that_could_escape_its_folder(entries, symlink, problem: str) -> None:
    with pytest.raises(PackageError, match=problem):
        inspect_package(_tar(entries, symlink=symlink))


def test_refuses_a_package_that_inflates_past_the_limit() -> None:
    with pytest.raises(PackageError, match="unpacks to more than"):
        inspect_package(gzip.compress(b"\0" * (UNPACKED_MAX_BYTES + 1)))


def test_refuses_what_is_not_a_package() -> None:
    with pytest.raises(PackageError, match="not a .tar.gz"):
        inspect_package(b"not a package")


def test_lists_every_broken_rule_of_the_packaged_plugin(plugin: Path) -> None:
    files = _files(pack(plugin))
    files.pop("echo/LICENSE")
    with pytest.raises(PackageError) as error:
        inspect_package(_tar(files))
    assert "missing LICENSE" in error.value.violations


def test_the_package_folder_is_named_by_the_plugin_id(plugin: Path) -> None:
    files = {name.replace("echo/", "repeat/", 1): content for name, content in _files(pack(plugin)).items()}
    with pytest.raises(PackageError, match="must be named by the plugin's id 'echo'"):
        inspect_package(_tar(files))


def _source(plugin: Path, tmp_path: Path) -> bytes:
    """``plugin`` committed at plugins/echo of a repository, archived the way GitHub serves a commit."""
    repo = tmp_path / "repo"
    shutil.copytree(plugin, repo / "plugins" / "echo")
    git = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-qm", "plugin"], check=True)
    archive = subprocess.run([*git, "archive", "--format=tar.gz", "--prefix=repo-0abc/", "HEAD"], check=True, capture_output=True)
    return archive.stdout


def test_packs_a_plugin_from_its_source(plugin: Path, tmp_path: Path) -> None:
    entry, data = pack_source(_source(plugin, tmp_path), "plugins/echo")
    assert data == pack(plugin)
    assert (entry["id"], entry["size"]) == ("echo", len(data))


@pytest.mark.parametrize(
    ("path", "problem"),
    [("plugins/missing", "no plugin folder at 'plugins/missing'"), ("../x", "not a folder inside"), ("", "unexpected plugins")],
)
def test_refuses_a_source_without_a_plugin_at_its_path(plugin: Path, tmp_path: Path, path: str, problem: str) -> None:
    with pytest.raises(PackageError, match=problem):
        pack_source(_source(plugin, tmp_path), path)


def test_refuses_a_link_in_the_plugins_source() -> None:
    source = _tar({"repo-0abc/plugins/echo/README.md": b""}, symlink="repo-0abc/plugins/echo/link")
    with pytest.raises(PackageError, match="not a plain file or folder"):
        pack_source(source, "plugins/echo")


def test_a_manifest_cannot_read_the_hosts_environment(plugin: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOST_SECRET", "hunter2")
    files = _files(pack(plugin))
    files["echo/nanoagent.yaml"] = files["echo/nanoagent.yaml"].replace(b"group: Testing", b"group: ${oc.env:HOST_SECRET}")
    with pytest.raises(PackageError) as error:
        inspect_package(_tar(files))
    assert "HOST_SECRET" in str(error.value) and "hunter2" not in str(error.value)


@pytest.fixture
def client(plugin: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("NANOAGENT_API_TOKEN", TOKEN)
    config = load_config_args(
        WebConfig,
        ["web_cfg=deploy/railway/nanoagent.yaml", f"packages=[{plugin}]", f"workspaces={tmp_path / 'workspaces'}"],
    )
    return TestClient(create_app(config), headers={"Authorization": f"Bearer {TOKEN}"})


def test_serves_its_packages_for_download(client: TestClient, plugin: Path) -> None:
    [entry] = client.get("/v1/packages").json()["packages"]
    assert (entry["id"], entry["size"]) == ("echo", len(pack(plugin)))
    download = client.get("/v1/packages/echo")
    assert download.content == pack(plugin)
    assert download.headers["content-disposition"] == 'attachment; filename="echo-1.0.0.tar.gz"'
    assert client.get("/v1/packages/missing").status_code == 404
    assert client.get("/v1/packages", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_inspects_an_upload(client: TestClient, plugin: Path) -> None:
    accepted = client.post("/v1/packages/inspect", content=pack(plugin))
    assert accepted.status_code == 200 and accepted.json()["package"]["id"] == "echo"
    refused = client.post("/v1/packages/inspect", content=b"not a package")
    assert refused.status_code == 422 and "not a .tar.gz" in refused.json()["violations"][0]


def test_packs_a_plugin_from_a_source_archive(client: TestClient, plugin: Path, tmp_path: Path) -> None:
    accepted = client.post("/v1/packages/source", params={"path": "plugins/echo"}, content=_source(plugin, tmp_path))
    assert accepted.status_code == 200 and accepted.json()["package"]["id"] == "echo"
    assert base64.b64decode(accepted.json()["data"]) == pack(plugin)
    refused = client.post("/v1/packages/source", params={"path": "nowhere"}, content=_source(plugin, tmp_path / "again"))
    assert refused.status_code == 422 and "no plugin folder" in refused.json()["error"]


def test_production_offers_every_built_in_plugin(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("NANOAGENT_API_TOKEN", TOKEN)
    config = load_config_args(WebConfig, ["web_cfg=deploy/railway/nanoagent.yaml", f"workspaces={tmp_path}"])
    packages = TestClient(create_app(config), headers={"Authorization": f"Bearer {TOKEN}"}).get("/v1/packages").json()
    built_in = sorted(path.name for path in (ROOT / "plugins").iterdir() if path.is_dir())
    assert sorted(entry["id"] for entry in packages["packages"]) == built_in
