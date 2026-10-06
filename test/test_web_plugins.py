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
from test_plugin import write_plugin

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "plugin-test-secret"
SERVER = """import json
import os
from pathlib import Path

import anyio
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

server = Server("echo")


@server.list_tools()
async def list_tools():
    schema = lambda name: json.loads(Path("schemas", name).read_text())
    return [types.Tool(name="echo", description="Echo input",
                       inputSchema=schema("input.json"), outputSchema=schema("output.json"))]


@server.call_tool()
async def call_tool(name, arguments):
    Path(os.environ["NANOAGENT_WORKSPACE"], "echo.txt").write_text(arguments["value"])
    return {"ok": True, "value": arguments["value"]}


async def main():
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())

anyio.run(main)
"""


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
        "output": {"ok": True, "value": "hello"},
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
    assert client.get("/v1/workspaces/bob/files").json() == {"files": [], "truncated": False}


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
