"""POST /v1/installs/{sha256}/benchmark/case-set: the case set body RUSH Lab's Publish benchmark screen POSTs, every field
derived on the member's own NanoAgent from the installed package and the case file by the code the CLI's step 1 runs."""

from __future__ import annotations

import base64
import hashlib
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml
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


DOCUMENT = {
    "plugin": "echo", "task": "echo",
    "cases": [{"prompt": "Echo the value hi.", "arguments": {"value": "hi"}}],
    "refuse": [{"prompt": "Echo the value fail.", "arguments": {"value": "fail"}, "reference_error": "asked to fail"}],
}  # fmt: skip


def request(**changes: Any) -> dict[str, Any]:
    """The body: the case file as YAML text (``cases`` is its document, ``case_file`` replaces the text outright), and the files."""
    changes = {**changes}
    document = changes.pop("cases", DOCUMENT)
    return {"name": "echo-set", "case_file": yaml.safe_dump(document, sort_keys=False), "files": {}, **changes}


def post(client: TestClient, **changes: Any):
    return client.post(f"/v1/installs/{client.sha}/benchmark/case-set", json=request(**changes))


def test_derives_the_whole_case_set_from_the_package_and_the_case_file(client: TestClient) -> None:
    reply = post(client)
    assert reply.status_code == 200, reply.text
    body = reply.json()
    assert set(body) == {"name", "plugin_id", "plugin_name", "version", "package_sha256", "task_id", "task", "cases", "private"}
    assert (body["name"], body["plugin_id"], body["package_sha256"], body["task_id"], body["version"]) == ("echo-set", "echo", client.sha, "echo", "1.0.0")
    assert body["plugin_name"]
    assert body["private"]["echo-01"] == {"value": "hi"} and "asked to fail" in body["private"]["echo-02"]
    assert body["cases"] == [
        {"case_id": "echo-01", "kind": "answer", "prompt": "Echo the value hi.", "arguments": {"value": "hi"}, "fixtures": None, "expected_error": None},
        {"case_id": "echo-02", "kind": "refuse", "prompt": "Echo the value fail.", "arguments": {"value": "fail"}, "fixtures": None, "expected_error": "asked to fail"},
    ]
    task = body["task"]
    assert task["kind"] == "tool" and task["description"] and "instructions" not in task
    assert [tool["name"] for tool in task["tools"]] == ["echo"]
    assert set(task["tools"][0]) == {"name", "description", "input_schema", "output_schema", "writes"}
    assert task["input_schema"]["properties"]["value"] and task["output_schema"]["properties"]["value"]


def test_a_case_the_tool_cannot_answer_fails_the_preparation(client: TestClient) -> None:
    cases = DOCUMENT | {"cases": [{"prompt": "Echo fail.", "arguments": {"value": "fail"}}], "refuse": []}
    reply = post(client, cases=cases)
    assert reply.status_code == 422 and "case echo-01" in reply.json()["error"] and "a case to answer" in reply.json()["error"]


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"cases": DOCUMENT | {"plugin": "other"}}, "the cases are for other, not echo"),
        ({"cases": DOCUMENT | {"task": "nope"}}, "unknown task"),
        ({"cases": DOCUMENT | {"cases": [], "refuse": []}}, "has no cases"),
        ({"cases": DOCUMENT | {"cases": [{"prompt": "Echo.", "arguments": {"wrong": 1}}], "refuse": []}}, "case echo-01: its arguments do not fit the input of task echo"),
        ({"cases": DOCUMENT | {"refuse": [{"prompt": "Echo fail.", "arguments": {"value": "fail"}, "reference_error": "another reason"}]}}, "without 'another reason'"),
        ({"cases": DOCUMENT | {"refuse": [{"prompt": "Echo fine.", "arguments": {"value": "fine"}, "reference_error": "asked"}]}}, "a case to refuse"),
        ({"cases": DOCUMENT | {"cases": [{"prompt": "Echo.", "arguments": {"value": "hi"}}], "refuse": []}}, "the prompt does not state argument value (hi)"),
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


def test_fixture_folders_resolve_against_the_uploaded_files(client: TestClient) -> None:
    document = yaml.safe_load(request()["case_file"])
    document["cases"][0]["fixtures"] = "inputs"
    files = {"inputs/a.txt": base64.b64encode(b"hi").decode()}
    body = post(client, cases=document, files=files).json()
    assert body["cases"][0]["fixtures"]["files"].keys() == {"a.txt"}
    reply = post(client, cases=document)
    assert reply.status_code == 422 and "case echo-01: the fixtures inputs are not a folder of the uploaded case folder" in reply.json()["error"]


def test_a_fixture_named_answer_json_is_refused(client: TestClient) -> None:
    document = yaml.safe_load(request()["case_file"])
    document["cases"][0]["fixtures"] = "inputs"
    reply = post(client, cases=document, files={"inputs/answer.json": "e30="})
    assert reply.status_code == 422 and "case echo-01: the fixtures hold answer.json at their root" in reply.json()["error"]


def test_a_yaml_syntax_error_is_refused_naming_its_line(client: TestClient) -> None:
    reply = post(client, case_file="plugin: echo\ntask: [echo\n")
    assert reply.status_code == 422 and "not valid YAML at line" in reply.json()["error"]


def test_the_old_case_file_shape_is_refused(client: TestClient) -> None:
    old = {"plugin": "echo", "task": "echo", "context": "c", "answer": [{"value": "hi"}], "refuse": []}
    reply = post(client, cases=old)
    assert reply.status_code == 422 and "case file shape" in reply.json()["error"]


OLD_CASES = {
    "plugin": "echo", "task": "echo", "context": "Echo values.",
    "answer": [{"value": "hi"}], "refuse": [{"arguments": {"value": "fail"}, "reference_error": "asked to fail"}],
}  # fmt: skip


def post_old(client: TestClient, **changes: Any):
    return client.post(f"/v1/installs/{client.sha}/benchmark/case-set", json={"name": "echo-set", "cases": OLD_CASES, **changes})


# COMPAT(case-set-cases): production RUSH still sends the old body and publishes what comes back.
def test_the_old_body_is_answered_with_the_old_publication(client: TestClient) -> None:
    reply = post_old(client)
    assert reply.status_code == 200, reply.text
    body = reply.json()
    assert set(body) == {"name", "plugin_id", "plugin_name", "version", "package_sha256", "task_id", "task", "context", "cases", "private"}
    assert body["context"] == "Echo values." and body["task"]["instructions"]
    assert body["cases"] == [
        {"case_id": "echo-01", "kind": "answer", "arguments": {"value": "hi"}, "expected_error": None},
        {"case_id": "echo-02", "kind": "refuse", "arguments": {"value": "fail"}, "expected_error": "asked to fail"},
    ]
    assert body["private"]["echo-01"] == {"value": "hi"} and "asked to fail" in body["private"]["echo-02"]


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"cases": OLD_CASES | {"plugin": "other"}}, "the cases are for other, not echo"),
        ({"cases": OLD_CASES | {"answer": [], "refuse": []}}, "has no cases"),
        ({"cases": OLD_CASES | {"answer": [{"wrong": 1}]}}, "case echo-01: its arguments do not fit the input of task echo"),
        ({"cases": OLD_CASES | {"answer": [{"value": "fail"}]}}, "a case to answer"),
        ({"name": "Not A Name"}, "case set name"),
    ],
)
def test_the_old_body_that_does_not_fit_the_plugin_is_refused_with_why(client: TestClient, changes: dict[str, Any], message: str) -> None:
    reply = post_old(client, **changes)
    assert reply.status_code == 422 and message in reply.json()["error"]


def test_a_body_with_neither_form_is_a_bad_request(client: TestClient) -> None:
    assert client.post(f"/v1/installs/{client.sha}/benchmark/case-set", json={"name": "x", "other": 1}).status_code == 400
    assert post_old(client, case_file="x").status_code == 400


def test_the_old_body_with_the_case_file_as_json_is_a_bad_request(client: TestClient) -> None:
    reply = client.post(f"/v1/installs/{client.sha}/benchmark/case-set", json={"name": "x", "cases": {"plugin": "echo"}})
    assert reply.status_code == 400


def test_a_sessions_frame_is_its_case_set_but_the_case(client: TestClient) -> None:
    reply = client.post(f"/v1/installs/{client.sha}/benchmark/session-frame", json={"task": "echo", "text": "Echo hi, please."})
    assert reply.status_code == 200, reply.text
    frame = reply.json()
    assert frame["case_id"] == "echo-01" and "cases" not in frame and "context" not in frame and "private" not in frame
    refused = client.post(f"/v1/installs/{client.sha}/benchmark/session-frame", json={"task": "nope", "text": "x"})
    assert refused.status_code == 422 and "unknown task" in refused.json()["error"]
    assert client.post(f"/v1/installs/{client.sha}/benchmark/session-frame", json={"task": "echo"}).status_code == 400
