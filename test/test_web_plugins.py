from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from nanoagent.core.agent import Reply, ToolCall
from nanoagent.runtime.config import load_config_args
from nanoagent.web.app import create_app
from nanoagent.web.config import WebConfig
from test_plugin import SERVER, write_plugin

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "plugin-test-secret"
class ScriptedModel:
    """Calls the echo tool once, then answers with what it returned."""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def query(self, messages, tools, **_):
        results = [message["content"] for message in messages if message["role"] == "tool"]
        if results:
            return Reply(content=f"echoed {results[-1]}")
        self.prompts.append(messages[0]["content"])
        return Reply(content=None, tool_calls=[ToolCall("call-1", "echo", '{"value": "hi"}')])


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
def workspaces(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("workspaces")


@pytest.fixture
def client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path
) -> TestClient:
    manifest = write_plugin(tmp_path)
    manifest.write_text(
        manifest.read_text().replace("[echo-server]", f"[{sys.executable}, src/server.py]")
    )
    (tmp_path / "src" / "server.py").write_text(SERVER, encoding="utf-8")
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("NANOAGENT_API_TOKEN", TOKEN)
    config = load_config_args(
        WebConfig,
        [
            "web_cfg=deploy/railway/nanoagent.yaml",
            f"plugins=[{tmp_path}]",
            f"workspaces={workspaces}",
        ],
    )
    return TestClient(create_app(config, plugin_model=model), headers={"Authorization": f"Bearer {TOKEN}"})


def test_lists_plugins_with_readme_and_schemas(client: TestClient) -> None:
    [plugin] = client.get("/v1/plugins").json()["plugins"]
    assert plugin["id"] == "echo"
    assert plugin["readme"] == "# Echo\n"
    assert plugin["tools"][0]["inputSchema"]["required"] == ["value"]
    assert plugin["tasks"][0]["tools"] == ["echo"]


def test_plugin_routes_require_the_token(client: TestClient) -> None:
    client.headers.pop("Authorization")
    assert client.get("/v1/plugins").status_code == 401
    assert client.post("/v1/plugins/echo/tasks/echo", json={"value": "x"}).status_code == 401


def test_runs_a_verified_plugin_task(client: TestClient) -> None:
    response = client.post("/v1/plugins/echo/tasks/echo", json={"value": "hello"})
    assert response.status_code == 200
    assert response.json() == {
        "plugin": "echo",
        "task": "echo",
        "tool": "echo",
        "output": {"value": "hello"},
    }


def test_rejects_unknown_plugins_and_invalid_input(client: TestClient) -> None:
    assert client.post("/v1/plugins/missing/tasks/echo", json={}).status_code == 404
    assert client.post("/v1/plugins/echo/tasks/missing", json={}).status_code == 404
    response = client.post("/v1/plugins/echo/tasks/echo", json={"value": 42})
    assert response.status_code == 400
    assert "invalid input" in response.json()["error"]


RUNS = "/v1/workspaces/alice/plugins/echo/runs"


def test_runs_a_prompt_in_the_callers_workspace(
    client: TestClient, model: ScriptedModel, workspaces: Path
) -> None:
    with client.stream("POST", RUNS, json={"input": "echo hi"}) as response:
        assert response.status_code == 200
        events = [
            json.loads(line[len("data: ") :])
            for line in response.iter_lines()
            if line.startswith("data: ")
        ]
    assert [event["type"] for event in events] == ["start", "tool", "step", "done"]
    assert events[0]["profile"] == "plugin-echo"
    assert events[1]["name"] == "echo" and not events[1]["is_error"]
    assert "hi" in events[-1]["answer"]
    assert "You operate the Echo plugin" in model.prompts[0]
    # The file outlives the run, and its owner can list and read it.
    assert (workspaces / "alice" / "echo.txt").read_text() == "hi"
    [listed] = client.get("/v1/workspaces/alice/files").json()["files"]
    assert listed["path"] == "echo.txt" and listed["size"] == 2
    assert client.get("/v1/workspaces/alice/files/echo.txt").text == "hi"
    assert client.get("/v1/workspaces/bob/files").json() == {
        "files": [],
        "folders": [],
        "truncated": False,
    }


def test_plugin_runs_reject_profile_selection(client: TestClient) -> None:
    response = client.post(RUNS, json={"input": "x", "profile": "pi-deepseek"})
    assert response.status_code == 400
    assert client.post("/v1/workspaces/alice/plugins/missing/runs", json={"input": "x"}).status_code == 404
    assert client.post("/v1/workspaces/../plugins/echo/runs", json={"input": "x"}).status_code == 404


def test_workspace_files_stay_inside_their_workspace(client: TestClient, workspaces: Path) -> None:
    (workspaces / "alice" / "papers").mkdir(parents=True)
    (workspaces / "alice" / "papers" / "ms.tex").write_text("\\documentclass{article}")
    (workspaces / "secret.txt").write_text("not yours")
    (workspaces / "alice" / "escape").symlink_to(workspaces / "secret.txt")
    assert [f["path"] for f in client.get("/v1/workspaces/alice/files").json()["files"]] == [
        "papers/ms.tex"
    ]
    assert client.get("/v1/workspaces/alice/files/escape").status_code == 404
    assert client.get("/v1/workspaces/alice/files/papers/../../secret.txt").status_code in {400, 404}
    assert client.get("/v1/workspaces/bad.id/files").status_code == 400
    assert client.delete("/v1/workspaces/alice/files/papers/ms.tex").json() == {"deleted": True}
    assert not (workspaces / "alice" / "papers" / "ms.tex").exists()


def test_refuses_to_run_a_plugin_in_development(tmp_path: Path, workspaces: Path) -> None:
    manifest = write_plugin(tmp_path)
    manifest.write_text(manifest.read_text().replace("status: ready", "status: in-development"))
    # Unfinished: a plugin being built need not pass the rules a ready one must.
    (tmp_path / "contract.py").unlink()
    config = load_config_args(
        WebConfig,
        [
            "web_cfg=deploy/railway/nanoagent.yaml",
            f"plugins=[{tmp_path}]",
            f"workspaces={workspaces}",
            "api_token=null",
            "host=127.0.0.1",
        ],
    )
    client = TestClient(create_app(config, plugin_model=ScriptedModel()))
    [listed] = client.get("/v1/plugins").json()["plugins"]
    assert listed["status"] == "in-development"
    assert "tools" not in listed
    response = client.post(RUNS, json={"input": "echo hi"})
    assert response.status_code == 409
    assert response.json() == {"error": "Echo is under maintenance"}
    assert client.post("/v1/plugins/echo/tasks/echo", json={"value": "hi"}).status_code == 409


def test_manages_workspace_files_and_folders(client: TestClient, workspaces: Path) -> None:
    files = "/v1/workspaces/alice/files"
    # Create: a new file makes its folders; create=1 refuses to replace it.
    saved = client.put(f"{files}/notes/draft.md?create=1", content=b"# Draft")
    assert saved.status_code == 200 and saved.json()["path"] == "notes/draft.md"
    assert client.put(f"{files}/notes/draft.md?create=1", content=b"x").status_code == 409
    # Save: a plain PUT replaces the contents.
    assert client.put(f"{files}/notes/draft.md", content=b"# Final").json()["size"] == 7
    assert client.get(f"{files}/notes/draft.md").text == "# Final"
    # Folders, including empty ones, are listed.
    assert client.post("/v1/workspaces/alice/folders/papers/empty").json() == {"created": True}
    assert client.post("/v1/workspaces/alice/folders/papers/empty").status_code == 409
    listing = client.get(files).json()
    assert listing["folders"] == ["notes", "papers", "papers/empty"]
    assert [entry["path"] for entry in listing["files"]] == ["notes/draft.md"]
    # Move a file, then a folder; a folder may not move inside itself.
    move = "/v1/workspaces/alice/move"
    assert client.post(move, json={"from": "notes/draft.md", "to": "papers/draft.md"}).json() == {
        "moved": True
    }
    assert client.post(move, json={"from": "papers", "to": "papers/empty/inner"}).status_code == 400
    assert client.post(move, json={"from": "papers", "to": "archive"}).status_code == 200
    assert (workspaces / "alice" / "archive" / "draft.md").read_text() == "# Final"
    assert client.post(move, json={"from": "missing", "to": "x"}).status_code == 404
    assert client.post(move, json={"from": "a"}).status_code == 400
    # Delete a folder and everything in it.
    assert client.delete("/v1/workspaces/alice/folders/archive").json() == {"deleted": True}
    assert not (workspaces / "alice" / "archive").exists()
    # Paths stay inside the workspace, and files have a size limit.
    assert client.put(f"{files}/../escape.txt", content=b"x").status_code in {400, 404}
    assert client.post("/v1/workspaces/alice/folders/a/../../b").status_code in {400, 404}
    too_big = b"x" * (10 * 1024 * 1024 + 1)
    assert client.put(f"{files}/big.bin", content=too_big).status_code == 413



def _events(response) -> list[dict]:
    return [json.loads(line[len("data: "):]) for line in response.text.splitlines() if line.startswith("data: ")]


def test_serves_the_plugin_front_end_confined_to_the_bridge(client: TestClient) -> None:
    from nanoagent.web.app import UI_POLICY

    page = client.get("/v1/plugins/echo/ui/index.html")
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")
    assert page.headers["content-security-policy"] == UI_POLICY
    assert "connect-src 'none'" in UI_POLICY
    assert client.get("/v1/plugins/echo/ui/../nanoagent.yaml").status_code == 404
    assert client.get("/v1/plugins/echo/ui/missing.js").status_code == 404
    assert client.get("/v1/plugins/missing/ui/index.html").status_code == 404
    client.headers.pop("Authorization")
    assert client.get("/v1/plugins/echo/ui/index.html").status_code == 401


def test_lists_each_tasks_input_schema(client: TestClient) -> None:
    [plugin] = client.get("/v1/plugins").json()["plugins"]
    assert plugin["tasks"][0]["inputSchema"]["required"] == ["value"]


def test_runs_a_tool_task_the_verified_way(client: TestClient, workspaces: Path) -> None:
    response = client.post("/v1/workspaces/alice/plugins/echo/tasks/echo/runs", json={"arguments": {"value": "hi"}})
    assert response.status_code == 200
    events = _events(response)
    assert [event["type"] for event in events] == ["task.started", "task.result", "task.verdict", "task.done"]
    assert events[1]["response"] == {"value": "hi"}
    assert events[2]["valid"] is True
    assert len({event["runId"] for event in events}) == 1
    assert (workspaces / "alice" / "echo.txt").read_text() == "hi"


def test_task_runs_report_bad_requests_and_failures(client: TestClient) -> None:
    runs = "/v1/workspaces/alice/plugins/echo/tasks"
    assert client.post(f"{runs}/missing/runs", json={"arguments": {}}).status_code == 404
    assert client.post(f"{runs}/echo/runs", json={"value": "hi"}).status_code == 400
    events = _events(client.post(f"{runs}/echo/runs", json={"arguments": {"value": 42}}))
    # The input is checked before the task starts.
    assert [event["type"] for event in events] == ["task.error", "task.done"]
    assert "42" in next(event for event in events if event["type"] == "task.error")["message"]


def test_runs_an_agent_task_with_only_its_tools(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path
) -> None:
    manifest = write_plugin(tmp_path)
    manifest.write_text(
        manifest.read_text().replace("[echo-server]", f"[{sys.executable}, src/server.py]")
        + """  echo-agent:
    description: Echo with an agent
    runner: agent
    tools: [echo]
    reference: null
    instructions: Echo the value with the echo tool.
"""
    )
    contract = tmp_path / "contract.py"
    contract.write_text(
        contract.read_text()
        .replace('class Task(Enum):\n    ECHO = "echo"\n', 'class Task(Enum):\n    ECHO = "echo"\n    ECHO_AGENT = "echo-agent"\n')
        .replace("TASKS = {Task.ECHO: EchoInput}", "TASKS = {Task.ECHO: EchoInput, Task.ECHO_AGENT: EchoInput}")
    )
    (tmp_path / "src" / "server.py").write_text(SERVER, encoding="utf-8")
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("NANOAGENT_API_TOKEN", TOKEN)
    config = load_config_args(
        WebConfig,
        ["web_cfg=deploy/railway/nanoagent.yaml", f"plugins=[{tmp_path}]", f"workspaces={workspaces}"],
    )
    client = TestClient(create_app(config, plugin_model=model), headers={"Authorization": f"Bearer {TOKEN}"})
    events = _events(
        client.post("/v1/workspaces/alice/plugins/echo/tasks/echo-agent/runs", json={"arguments": {"value": "hi"}})
    )
    assert [event["type"] for event in events] == [
        "task.started",
        "task.tool",
        "task.answer",
        "task.verdict",
        "task.done",
    ]
    assert events[1]["name"] == "echo" and events[1]["isError"] is False
    assert events[3]["valid"] is True
    assert "Echo the value with the echo tool." in model.prompts[-1]
