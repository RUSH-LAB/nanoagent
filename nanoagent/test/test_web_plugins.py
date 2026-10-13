from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from nanoagent.core.agent import Reply, ToolCall
from nanoagent.plugin import install
from nanoagent.plugin.package import pack
from nanoagent.runtime.config import load_config_args
from nanoagent.web.app import create_app
from nanoagent.web.config import WebConfig
from test_plugin import README, SERVER, write_plugin

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "plugin-test-secret"
SHA = "0" * 64
class ScriptedModel:
    """Calls the echo tool once, then answers with what it returned."""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def query(self, messages, tools, on_delta=None, **_):
        results = [message["content"] for message in messages if message["role"] == "tool"]
        if results:
            if on_delta is not None:
                on_delta("content", "echoed")
            return Reply(content=f"echoed {results[-1]}")
        self.prompts.append(messages[0]["content"])
        return Reply(content=None, tool_calls=[ToolCall("call-1", "echo", '{"value": "hi"}')])


@pytest.fixture
def model() -> ScriptedModel:
    return ScriptedModel()


@pytest.fixture
def workspaces(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("workspaces")


def _app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path) -> TestClient:
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("NANOAGENT_API_TOKEN", TOKEN)
    # The echo plugin runs on this Python, so it has nothing to sync.
    monkeypatch.setattr(install, "SYNC", ("true",))
    config = load_config_args(
        WebConfig,
        [
            "web_cfg=deploy/railway/nanoagent.yaml",
            "packages=[]",
            f"workspaces={workspaces}",
            f"installs={tmp_path / 'installs'}",
            "host=127.0.0.1",
            "sandbox=none",
        ],
    )
    client = TestClient(create_app(config, plugin_model=model), headers={"Authorization": f"Bearer {TOKEN}"})
    client.config = config
    return client


def _echo(root: Path) -> bytes:
    """The echo plugin, run on this Python, packed."""
    manifest = write_plugin(root)
    manifest.write_text(manifest.read_text().replace("[echo-server]", f"[{sys.executable}, src/server.py]"))
    (root / "src" / "server.py").write_text(SERVER, encoding="utf-8")
    return pack(root)


@pytest.fixture
def client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path
) -> TestClient:
    client = _app(tmp_path, monkeypatch, model, workspaces)
    data = _echo(tmp_path / "echo")
    client.sha = hashlib.sha256(data).hexdigest()
    installed = client.put(f"/v1/installs/{client.sha}", content=data)
    assert installed.status_code == 200, installed.text
    return client


def test_installs_a_package_by_its_sha256(client: TestClient) -> None:
    plugin = client.get(f"/v1/installs/{client.sha}").json()["plugin"]
    assert plugin["id"] == "echo" and plugin["sha256"] == client.sha
    assert plugin["readme"] == README
    assert plugin["tools"][0]["inputSchema"]["required"] == ["value"]
    assert plugin["tasks"][0]["inputSchema"]["required"] == ["value"]
    assert len(plugin["uiVersion"]) == 16
    assert client.get(f"/v1/installs/{SHA}").status_code == 404


def test_refuses_a_package_that_is_not_its_sha256(client: TestClient, tmp_path: Path) -> None:
    data = pack(tmp_path / "echo")
    response = client.put(f"/v1/installs/{SHA}", content=data)
    assert response.status_code == 422 and "sha256" in response.json()["error"]
    assert client.put("/v1/installs/not-a-sha", content=data).status_code == 422
    refused = client.put(f"/v1/installs/{hashlib.sha256(b'x').hexdigest()}", content=b"x")
    assert refused.status_code == 422 and "gzip" in refused.json()["error"]


def test_refuses_a_failed_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path
) -> None:
    client = _app(tmp_path, monkeypatch, model, workspaces)
    monkeypatch.setattr(install, "SYNC", ("false",))
    data = _echo(tmp_path / "echo")
    sha = hashlib.sha256(data).hexdigest()
    response = client.put(f"/v1/installs/{sha}", content=data)
    assert response.status_code == 502 and "uv sync failed" in response.json()["error"]
    assert client.get(f"/v1/installs/{sha}").status_code == 404
    assert not (tmp_path / "installs" / sha).exists()


def test_serves_its_own_packages_by_id_to_mochi_on_production(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path
) -> None:
    """COMPAT(mochi-installs): remove with the routes by plugin id."""
    _echo(tmp_path / "echo")
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("NANOAGENT_API_TOKEN", TOKEN)
    monkeypatch.setattr(install, "SYNC", ("true",))
    config = load_config_args(
        WebConfig,
        [
            "web_cfg=deploy/railway/nanoagent.yaml",
            f"packages=[{tmp_path / 'echo'}]",
            f"workspaces={workspaces}",
            f"installs={tmp_path / 'installs'}",
            "host=127.0.0.1",
            "sandbox=none",
        ],
    )
    client = TestClient(create_app(config, plugin_model=model), headers={"Authorization": f"Bearer {TOKEN}"})
    [plugin] = client.get("/v1/plugins").json()["plugins"]
    assert plugin["id"] == "echo" and len(plugin["uiVersion"]) == 16
    assert client.get(f"/v1/plugins/echo/ui/{plugin['uiVersion']}/index.html").status_code == 200
    events = _events(client.post("/v1/workspaces/alice/plugins/echo/tasks/echo/runs", json={"arguments": {"value": "hi"}}))
    assert events[-2]["type"] == "task.verdict" and events[-2]["valid"] is True
    assert client.post("/v1/workspaces/alice/plugins/missing/runs", json={"input": "x"}).status_code == 404


def test_install_routes_require_the_token(client: TestClient) -> None:
    client.headers.pop("Authorization")
    assert client.get(f"/v1/installs/{client.sha}").status_code == 401
    assert client.put(f"/v1/installs/{client.sha}", content=b"").status_code == 401


def runs(client: TestClient, workspace: str = "alice") -> str:
    return f"/v1/workspaces/{workspace}/installs/{client.sha}"


def test_runs_a_prompt_in_the_callers_workspace(
    client: TestClient, model: ScriptedModel, workspaces: Path
) -> None:
    with client.stream("POST", f"{runs(client)}/runs", json={"input": "echo hi"}) as response:
        assert response.status_code == 200
        events = [
            json.loads(line[len("data: ") :])
            for line in response.iter_lines()
            if line.startswith("data: ")
        ]
    assert [event["type"] for event in events] == ["start", "tool", "step", "delta", "done"]
    assert events[0]["profile"] == "plugin-echo"
    assert events[-1]["metrics"]["ttft_s"] is not None
    assert events[1]["name"] == "echo" and not events[1]["is_error"]
    assert "hi" in events[-1]["answer"]
    assert "You operate the Echo plugin" in model.prompts[0]
    # The file stays until the caller removes the workspace; until then it can be listed and read.
    assert (workspaces / "alice" / "echo.txt").read_text() == "hi"
    [listed] = client.get("/v1/workspaces/alice/files").json()["files"]
    assert listed["path"] == "echo.txt" and listed["size"] == 2
    assert client.get("/v1/workspaces/alice/files/echo.txt").text == "hi"
    assert client.get("/v1/workspaces/bob/files").json() == {
        "files": [],
        "folders": [],
        "truncated": False,
    }


def test_plugin_runs_choose_an_apps_profile_within_the_limits(client: TestClient) -> None:
    refused = client.post(f"{runs(client)}/runs", json={"input": "x", "profile": "pi-deepseek"})
    assert refused.status_code == 400 and "cannot run apps" in refused.json()["error"]
    chosen = client.post(f"{runs(client)}/runs", json={"input": "x", "profile": "app-deepseek", "settings": {"max_steps": 3}})
    assert chosen.status_code == 200
    assert _events(chosen)[-1]["model"] == "deepseek/deepseek-v4-flash-0731"
    over = client.post(f"{runs(client)}/runs", json={"input": "x", "settings": {"max_steps": 99}})
    assert over.status_code == 400 and "at most 6" in over.json()["error"]
    thinking = client.post(f"{runs(client)}/runs", json={"input": "x", "settings": {"thinking_level": "high"}})
    assert thinking.status_code == 400 and "thinking_level" in thinking.json()["error"]
    # Mochi's NanoAgent runs only its profiles: a run cannot name a model of its own.
    named = client.post(f"{runs(client)}/runs", json={"input": "x", "model": {"provider": "openrouter", "model": "x/y"}})
    assert named.status_code == 400 and "configured profiles" in named.json()["error"]
    assert client.post(f"/v1/workspaces/alice/installs/{SHA}/runs", json={"input": "x"}).status_code == 404
    assert client.post(f"/v1/workspaces/../installs/{client.sha}/runs", json={"input": "x"}).status_code == 404


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


def test_refuses_to_run_a_plugin_in_development(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path
) -> None:
    client = _app(tmp_path, monkeypatch, model, workspaces)
    manifest = write_plugin(tmp_path / "echo")
    manifest.write_text(manifest.read_text().replace("status: ready", "status: in-development"))
    data = pack(tmp_path / "echo")
    client.sha = hashlib.sha256(data).hexdigest()
    assert client.put(f"/v1/installs/{client.sha}", content=data).json()["plugin"]["status"] == "in-development"
    response = client.post(f"{runs(client)}/runs", json={"input": "echo hi"})
    assert response.status_code == 409
    assert response.json() == {"error": "Echo is under maintenance"}
    assert client.post(f"{runs(client)}/tasks/echo/runs", json={"arguments": {"value": "hi"}}).status_code == 409


def test_saves_workspace_files_then_removes_the_workspace(client: TestClient, workspaces: Path) -> None:
    files = "/v1/workspaces/alice/files"
    # Create: a new file makes its folders; create=1 refuses to replace it.
    saved = client.put(f"{files}/notes/draft.md?create=1", content=b"# Draft")
    assert saved.status_code == 200 and saved.json()["path"] == "notes/draft.md"
    assert client.put(f"{files}/notes/draft.md?create=1", content=b"x").status_code == 409
    # Save: a plain PUT replaces the contents.
    assert client.put(f"{files}/notes/draft.md", content=b"# Final").json()["size"] == 7
    assert client.get(f"{files}/notes/draft.md").text == "# Final"
    listing = client.get(files).json()
    assert listing["folders"] == ["notes"]
    assert [entry["path"] for entry in listing["files"]] == ["notes/draft.md"]
    # Paths stay inside the workspace, and files have a size limit.
    assert client.put(f"{files}/../escape.txt", content=b"x").status_code in {400, 404}
    too_big = b"x" * (10 * 1024 * 1024 + 1)
    assert client.put(f"{files}/big.bin", content=too_big).status_code == 413
    # Removing the workspace takes everything in it; removing it again finds nothing.
    assert client.delete("/v1/workspaces/alice").json() == {"deleted": True}
    assert not (workspaces / "alice").exists()
    assert client.delete("/v1/workspaces/alice").json() == {"deleted": False}
    assert client.delete("/v1/workspaces/bad.id").status_code == 400


def test_keeps_the_workspace_edits_mochi_on_production_makes(client: TestClient, workspaces: Path) -> None:
    """COMPAT(mochi-workspace-edits): remove with the routes."""
    files = "/v1/workspaces/alice/files"
    client.put(f"{files}/notes/draft.md", content=b"# Final")
    assert client.post("/v1/workspaces/alice/folders/papers/empty").json() == {"created": True}
    assert client.post("/v1/workspaces/alice/folders/papers/empty").status_code == 409
    assert client.get(files).json()["folders"] == ["notes", "papers", "papers/empty"]
    move = "/v1/workspaces/alice/move"
    assert client.post(move, json={"from": "notes/draft.md", "to": "papers/draft.md"}).json() == {
        "moved": True
    }
    assert client.post(move, json={"from": "papers", "to": "papers/empty/inner"}).status_code == 400
    assert client.post(move, json={"from": "papers", "to": "archive"}).status_code == 200
    assert (workspaces / "alice" / "archive" / "draft.md").read_text() == "# Final"
    assert client.post(move, json={"from": "missing", "to": "x"}).status_code == 404
    assert client.post(move, json={"from": "a"}).status_code == 400
    assert client.delete(f"{files}/archive/draft.md").json() == {"deleted": True}
    assert client.delete("/v1/workspaces/alice/folders/archive").json() == {"deleted": True}
    assert not (workspaces / "alice" / "archive").exists()
    assert client.post("/v1/workspaces/alice/folders/a/../../b").status_code in {400, 404}


def _events(response) -> list[dict]:
    return [json.loads(line[len("data: "):]) for line in response.text.splitlines() if line.startswith("data: ")]


def test_serves_the_plugin_front_end_confined_to_the_bridge(client: TestClient) -> None:
    from nanoagent.web.app import UI_POLICY

    plugin = client.get(f"/v1/installs/{client.sha}").json()["plugin"]
    ui = f"/v1/installs/{client.sha}/ui/{plugin['uiVersion']}"
    page = client.get(f"{ui}/index.html")
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")
    assert page.headers["content-security-policy"] == UI_POLICY
    assert page.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert "connect-src 'none'" in UI_POLICY
    assert client.get(f"{ui}/../nanoagent.yaml").status_code == 404
    assert client.get(f"{ui}/missing.js").status_code == 404
    assert client.get(f"/v1/installs/{client.sha}/ui/0000000000000000/index.html").status_code == 404
    assert client.get(f"/v1/installs/{client.sha}/ui/index.html").status_code == 404
    assert client.get(f"/v1/installs/{SHA}/ui/{plugin['uiVersion']}/index.html").status_code == 404
    client.headers.pop("Authorization")
    assert client.get(f"{ui}/index.html").status_code == 401


def test_runs_a_tool_task_the_verified_way(client: TestClient, workspaces: Path) -> None:
    response = client.post(f"{runs(client)}/tasks/echo/runs", json={"arguments": {"value": "hi"}})
    assert response.status_code == 200
    events = _events(response)
    assert [event["type"] for event in events] == ["task.started", "task.result", "task.verdict", "task.done"]
    assert events[1]["response"] == {"value": "hi"}
    assert events[2]["valid"] is True
    metrics = events[3]["metrics"]
    assert metrics["model"] is None and metrics["cost"] == 0.0 and metrics["ttft_s"] is None
    assert metrics["duration_s"] > 0
    assert len({event["runId"] for event in events}) == 1
    assert (workspaces / "alice" / "echo.txt").read_text() == "hi"


def test_a_reference_tool_sees_the_workspace_files(tmp_path: Path) -> None:
    from nanoagent.web.app import _staged_from

    workspace = tmp_path / "workspace"
    (workspace / "inputs").mkdir(parents=True)
    (workspace / "inputs" / "raw.bib").write_text("@misc{a}")
    stage = _staged_from(workspace)
    stage(workspace)
    assert sorted(path.name for path in workspace.rglob("*")) == ["inputs", "raw.bib"]
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    stage(scratch)
    assert (scratch / "inputs" / "raw.bib").read_text() == "@misc{a}"


def test_task_runs_choose_their_settings_within_the_limits(client: TestClient) -> None:
    tasks = f"{runs(client)}/tasks/echo/runs"
    chosen = client.post(tasks, json={"arguments": {"value": "hi"}, "profile": "app-deepseek", "settings": {"max_steps": 2}})
    assert chosen.status_code == 200 and _events(chosen)[-1]["metrics"]["duration_s"] > 0
    over = client.post(tasks, json={"arguments": {"value": "hi"}, "settings": {"cost_limit": 5}})
    assert over.status_code == 400 and "at most 0.1" in over.json()["error"]
    assert client.post(tasks, json={"arguments": {"value": "hi"}, "extra": 1}).status_code == 400


def test_task_runs_report_bad_requests_and_failures(client: TestClient) -> None:
    tasks = f"{runs(client)}/tasks"
    assert client.post(f"{tasks}/missing/runs", json={"arguments": {}}).status_code == 404
    assert client.post(f"{tasks}/echo/runs", json={"value": "hi"}).status_code == 400
    events = _events(client.post(f"{tasks}/echo/runs", json={"arguments": {"value": 42}}))
    # The input is checked before the task starts.
    assert [event["type"] for event in events] == ["task.error", "task.done"]
    assert "metrics" not in events[-1]
    assert "42" in next(event for event in events if event["type"] == "task.error")["message"]


def test_runs_an_agent_task_with_only_its_tools(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path
) -> None:
    client = _app(tmp_path, monkeypatch, model, workspaces)
    root = tmp_path / "echo"
    manifest = write_plugin(root)
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
    contract = root / "contract.py"
    contract.write_text(
        contract.read_text()
        .replace('class Task(Enum):\n    ECHO = "echo"\n', 'class Task(Enum):\n    ECHO = "echo"\n    ECHO_AGENT = "echo-agent"\n')
        .replace("TASKS = {Task.ECHO: EchoInput}", "TASKS = {Task.ECHO: EchoInput, Task.ECHO_AGENT: EchoInput}")
    )
    (root / "src" / "server.py").write_text(SERVER, encoding="utf-8")
    data = pack(root)
    client.sha = hashlib.sha256(data).hexdigest()
    assert client.put(f"/v1/installs/{client.sha}", content=data).status_code == 200
    events = _events(client.post(f"{runs(client)}/tasks/echo-agent/runs", json={"arguments": {"value": "hi"}}))
    assert [event["type"] for event in events] == [
        "task.started",
        "task.tool",
        "task.answer",
        "task.verdict",
        "task.done",
    ]
    assert events[1]["name"] == "echo" and events[1]["isError"] is False
    assert events[3]["valid"] is True
    # Task runs stream the model, so time to first token is measured.
    metrics = events[4]["metrics"]
    assert metrics["model"] == client.config.model.model
    assert metrics["ttft_s"] is not None and metrics["ttft_s"] <= metrics["duration_s"]
    assert metrics["generation_s"] >= 0
    assert "Echo the value with the echo tool." in model.prompts[-1]
