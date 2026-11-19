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

from nanoagent.inference.types import Answer  # noqa: E402
from nanoagent.plugin import install  # noqa: E402
from nanoagent.plugin.package import pack  # noqa: E402
from nanoagent.runtime.config import load_config_args  # noqa: E402
from nanoagent.web.app import create_app  # noqa: E402
from nanoagent.web.config import WebConfig  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "case-set-secret"


class InputModel:
    """The plugin model of a Harness tab session: answers every request with ``value``, keeping what it was asked."""

    def __init__(self) -> None:
        self.value: dict[str, Any] | None = {"value": "hi"}
        self.asked: list[tuple[list[dict[str, Any]], str, dict[str, Any]]] = []

    async def answer(self, messages: list[dict[str, Any]], *, name: str, schema: dict[str, Any]) -> Answer:
        self.asked.append((messages, name, schema))
        if self.value is None:
            raise ValueError(f"the answer to {name!r} was cut off at the token limit")
        return Answer(dict(self.value))


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
    model = InputModel()
    app = TestClient(create_app(config, plugin_model=model), headers={"Authorization": f"Bearer {TOKEN}"})
    app.model = model
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


def session(client: TestClient, **body: Any):
    return client.post(f"/v1/installs/{client.sha}/benchmark/session", json={"task": "echo", "text": "Echo hi, please.", **body})


def test_a_session_is_one_case_whose_input_the_plugin_model_fills_from_the_request(client: TestClient) -> None:
    reply = session(client)
    assert reply.status_code == 200, reply.text
    body = reply.json()
    assert (body["name"], body["task_id"], body["context"]) == ("harness-session", "echo", "Echo hi, please.")
    assert body["cases"] == [{"case_id": "echo-01", "kind": "answer", "arguments": {"value": "hi"}, "expected_error": None}]
    assert body["private"] == {"echo-01": {"value": "hi"}}
    assert body["limits"] == {"max_model_calls": 200, "wall_time_ms": 3_600_000, "build_output_bytes": 3 << 30, "build_wall_ms": 1_800_000, "tmp_bytes": 4 << 30, "workspace_bytes": 10 << 30, "memory_mb": 4096}
    [(messages, name, schema)] = client.model.asked
    assert name == "echo" and schema["properties"]["value"] and messages[1] == {"role": "user", "content": "Echo hi, please."}


def test_a_sessions_frame_is_its_case_set_but_the_case_read_at_once_without_the_model(client: TestClient) -> None:
    reply = client.post(f"/v1/installs/{client.sha}/benchmark/session-frame", json={"task": "echo", "text": "Echo hi, please."})
    assert reply.status_code == 200, reply.text
    frame = reply.json()
    pinned = session(client).json()
    assert frame == {key: pinned[key] for key in frame} and frame["case_id"] == pinned["cases"][0]["case_id"]
    assert "cases" not in frame and "private" not in frame and len(client.model.asked) == 1  # only the pin asked the model
    refused = client.post(f"/v1/installs/{client.sha}/benchmark/session-frame", json={"task": "nope", "text": "x"})
    assert refused.status_code == 422 and "unknown task" in refused.json()["error"]


def test_a_frame_and_a_pin_take_a_request(client: TestClient) -> None:
    # A free-form Terminal session reads nothing of its plugin: neither is ever asked for one without a request.
    for path in ("session-frame", "session"):
        assert client.post(f"/v1/installs/{client.sha}/benchmark/{path}", json={"task": "echo"}).status_code == 400


def test_a_session_input_that_breaks_the_task_input_and_an_unknown_task_are_refused(client: TestClient) -> None:
    client.model.value = {"wrong": 1}
    assert session(client).status_code == 422 and "do not fit the input of task echo" in session(client).json()["error"]
    reply = session(client, task="nope")
    assert reply.status_code == 422 and "unknown task" in reply.json()["error"]
    assert session(client, text=" ").status_code == 400
    client.model.value = None
    reply = session(client)
    assert reply.status_code == 422 and "could not make task echo's input from the request: the answer to 'echo' was cut off" in reply.json()["error"]
