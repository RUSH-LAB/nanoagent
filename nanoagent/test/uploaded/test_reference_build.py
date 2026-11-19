"""The reference harnesses NanoAgent ships: their names, the deterministic build, the version derived from content, and GET /v1/benchmark/reference-harnesses/{name}."""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

import pytest
import yaml
from starlette.testclient import TestClient

from nanoagent.runtime.config import load_config_args
from nanoagent.uploaded.reference import FOLDER, NAMES, build_reference, content_version
from nanoagent.uploaded.source_zip import FIXED_TIME
from nanoagent.web.app import create_app
from nanoagent.web.config import WebConfig

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "reference-secret"


def manifest_of(data: bytes) -> dict:
    return yaml.safe_load(zipfile.ZipFile(io.BytesIO(data)).read("harness.yaml"))


def test_the_references_are_the_folders_and_each_manifest_carries_its_folders_name() -> None:
    assert NAMES == ("claude-code", "codex", "dsh", "hermes", "nanoagent", "pi", "shell")
    for name in NAMES:
        assert yaml.safe_load((FOLDER / name / "harness.yaml").read_text())["name"] == name


def test_a_reference_builds_to_the_same_zip_under_a_version_derived_from_its_content() -> None:
    first = build_reference("claude-code")
    assert build_reference("claude-code") == first
    manifest = manifest_of(first)
    assert manifest["name"] == "claude-code" and len(manifest["version"]) == 12
    with zipfile.ZipFile(io.BytesIO(first)) as archive:
        assert {info.date_time for info in archive.infolist()} == {FIXED_TIME}
    assert manifest_of(build_reference("codex"))["version"] != manifest["version"]


def test_the_version_follows_the_content(tmp_path: Path) -> None:
    (tmp_path / "harness.yaml").write_text("name: x\n")
    before = content_version(tmp_path)
    assert content_version(tmp_path) == before
    (tmp_path / "main.py").write_text("print(1)\n")
    assert content_version(tmp_path) != before


def test_the_nanoagent_reference_holds_the_working_tree_and_never_a_bytecode_cache() -> None:
    with zipfile.ZipFile(io.BytesIO(build_reference("nanoagent"))) as archive:
        names = archive.namelist()
    assert "nanoagent/core/__init__.py" in names and "taskharness/run.py" in names and "main.py" in names
    assert not any("__pycache__" in name or name.endswith("assemble.py") for name in names)


def test_an_unknown_reference_is_refused() -> None:
    with pytest.raises(ValueError, match="not a reference harness"):
        build_reference("mine")


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("NANOAGENT_API_TOKEN", TOKEN)
    config = load_config_args(
        WebConfig,
        [
            "web_cfg=deploy/railway/nanoagent.yaml", "packages=[]", f"workspaces={tmp_path / 'w'}", f"installs={tmp_path / 'i'}",
            f"uv_cache={tmp_path / 'u'}", f"plugin_python={sys.executable}", "host=127.0.0.1", "sandbox=none",
        ],
    )  # fmt: skip
    return TestClient(create_app(config), headers={"Authorization": f"Bearer {TOKEN}"})


def test_the_route_answers_the_zip_of_a_reference(client: TestClient) -> None:
    response = client.get("/v1/benchmark/reference-harnesses/pi")
    assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
    assert response.content == build_reference("pi")


def test_the_route_refuses_an_unknown_name_and_a_missing_token(client: TestClient) -> None:
    assert client.get("/v1/benchmark/reference-harnesses/mine").status_code == 404
    assert client.get("/v1/benchmark/reference-harnesses/pi", headers={"Authorization": "Bearer wrong"}).status_code == 401
