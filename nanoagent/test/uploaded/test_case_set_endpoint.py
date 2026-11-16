"""POST /v1/installs/{sha256}/benchmark/case-set: the case set body RUSH Lab's Publish benchmark screen POSTs, every field
derived on the member's own NanoAgent from the installed package and the case file by the code the CLI's step 1 runs."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from test_plugin import write_plugin  # noqa: E402

from nanoagent.plugin import install  # noqa: E402
from nanoagent.plugin.package import pack  # noqa: E402
from nanoagent.runtime.config import load_config_args  # noqa: E402
from nanoagent.web.app import create_app  # noqa: E402
from nanoagent.web.config import WebConfig  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "case-set-secret"


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("NANOAGENT_API_TOKEN", TOKEN)
    # The echo plugin runs on this Python, so it has nothing to sync.
    monkeypatch.setattr(install, "SYNC", ("true",))
    config = load_config_args(
        WebConfig,
        [
            "web_cfg=deploy/railway/nanoagent.yaml", "packages=[]", f"workspaces={tmp_path / 'w'}", f"installs={tmp_path / 'i'}",
            f"uv_cache={tmp_path / 'u'}", f"plugin_python={sys.executable}", "host=127.0.0.1", "sandbox=none",
        ],
    )  # fmt: skip
    app = TestClient(create_app(config), headers={"Authorization": f"Bearer {TOKEN}"})
    write_plugin(tmp_path / "echo")
    data = pack(tmp_path / "echo")
    app.sha = hashlib.sha256(data).hexdigest()
    assert app.put(f"/v1/installs/{app.sha}", content=data).status_code == 200
    return app


def request(**changes: Any) -> dict[str, Any]:
    body = {
        "name": "echo-set",
        "cases": {
            "plugin": "echo", "task": "echo", "context": "Echo the value.",
            "answer": [{"value": "hi"}], "refuse": [{"arguments": {"value": "fail"}, "reference_error": "asked to fail"}],
        },
    }  # fmt: skip
    return {**body, **changes}


def post(client: TestClient, **changes: Any):
    return client.post(f"/v1/installs/{client.sha}/benchmark/case-set", json=request(**changes))


def test_derives_the_whole_case_set_from_the_package_and_the_case_file(client: TestClient) -> None:
    reply = post(client)
    assert reply.status_code == 200, reply.text
    body = reply.json()
    assert set(body) == {"name", "plugin_id", "plugin_name", "version", "package_sha256", "task_id", "task", "context", "cases", "private"}
    assert (body["name"], body["plugin_id"], body["package_sha256"], body["task_id"], body["version"]) == ("echo-set", "echo", client.sha, "echo", "1.0.0")
    assert body["context"] == "Echo the value." and body["plugin_name"]
    assert body["private"]["echo-01"] == {"value": "hi"} and "asked to fail" in body["private"]["echo-02"]
    assert body["cases"] == [
        {"case_id": "echo-01", "kind": "answer", "arguments": {"value": "hi"}, "expected_error": None},
        {"case_id": "echo-02", "kind": "refuse", "arguments": {"value": "fail"}, "expected_error": "asked to fail"},
    ]
    task = body["task"]
    assert task["kind"] == "tool" and task["description"] and task["instructions"]
    assert [tool["name"] for tool in task["tools"]] == ["echo"]
    assert set(task["tools"][0]) == {"name", "description", "input_schema", "output_schema", "writes"}
    assert task["input_schema"]["properties"]["value"] and task["output_schema"]["properties"]["value"]


def test_a_case_the_tool_cannot_answer_fails_the_preparation(client: TestClient) -> None:
    cases = request()["cases"] | {"answer": [{"value": "fail"}], "refuse": []}
    reply = post(client, cases=cases)
    assert reply.status_code == 422 and "case echo-01" in reply.json()["error"] and "a case to answer" in reply.json()["error"]


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"cases": request()["cases"] | {"plugin": "other"}}, "the cases are for other, not echo"),
        ({"cases": request()["cases"] | {"task": "nope"}}, "unknown task"),
        ({"cases": request()["cases"] | {"answer": [], "refuse": []}}, "has no cases"),
        ({"cases": request()["cases"] | {"answer": [{"wrong": 1}], "refuse": []}}, "case echo-01: its arguments do not fit the input of task echo"),
        ({"cases": request()["cases"] | {"refuse": [{"arguments": {"value": "fail"}, "reference_error": "another reason"}]}}, "without 'another reason'"),
        ({"cases": request()["cases"] | {"refuse": [{"arguments": {"value": "fine"}, "reference_error": "asked"}]}}, "a case to refuse"),
        ({"name": "Not A Name"}, "case set name"),
    ],
)
def test_a_case_file_that_does_not_fit_the_plugin_is_refused_with_why(client: TestClient, changes: dict[str, Any], message: str) -> None:
    reply = post(client, **changes)
    assert reply.status_code == 422 and message in reply.json()["error"]


def test_a_malformed_body_is_a_bad_request(client: TestClient) -> None:
    assert client.post(f"/v1/installs/{client.sha}/benchmark/case-set", json={"name": "x"}).status_code == 400


def test_an_install_that_is_not_there_and_a_missing_token_are_refused(client: TestClient) -> None:
    assert client.post(f"/v1/installs/{'0' * 64}/benchmark/case-set", json=request()).status_code == 404
    assert client.post(f"/v1/installs/{client.sha}/benchmark/case-set", json=request(), headers={"Authorization": "Bearer no"}).status_code == 401
