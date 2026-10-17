from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from nanoagent.core.agent import Reply, ToolCall
from nanoagent.inference.types import Answer
from nanoagent.plugin import install
from nanoagent.plugin.package import pack
from nanoagent.plugin.python import plugin_python
from nanoagent.runtime.config import load_config_args
from nanoagent.web.app import create_app
from nanoagent.web.config import WebConfig
from test_plugin import README, write_plugin

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "plugin-test-secret"
SHA = "0" * 64


class ScriptedModel:
    """Calls the echo tool once, submits the echo when it is an agent task's agent, then answers
    with what the last tool returned."""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def query(self, messages, tools, on_delta=None, **_):
        results = [message["content"] for message in messages if message["role"] == "tool"]
        if len(results) == 1 and "submit" in {tool["function"]["name"] for tool in tools}:
            return Reply(content=None, tool_calls=[ToolCall("call-2", "submit", '{"value": "hi"}')])
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
            f"uv_cache={tmp_path / 'uv-cache'}",
            f"plugin_python={sys.executable}",
            "host=127.0.0.1",
            "sandbox=none",
        ],
    )
    client = TestClient(create_app(config, plugin_model=model), headers={"Authorization": f"Bearer {TOKEN}"})
    client.config = config
    return client


def _echo(root: Path) -> bytes:
    """The echo plugin, packed."""
    write_plugin(root)
    return pack(root)


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path) -> TestClient:
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


def test_refuses_a_failed_install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path) -> None:
    client = _app(tmp_path, monkeypatch, model, workspaces)
    monkeypatch.setattr(install, "SYNC", ("false",))
    data = _echo(tmp_path / "echo")
    sha = hashlib.sha256(data).hexdigest()
    response = client.put(f"/v1/installs/{sha}", content=data)
    assert response.status_code == 502 and "uv sync failed" in response.json()["error"]
    assert client.get(f"/v1/installs/{sha}").status_code == 404
    assert not (tmp_path / "installs" / sha).exists()


def test_keeps_a_finished_install_for_the_next_process(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path
) -> None:
    restarted = _app(tmp_path, monkeypatch, model, workspaces)
    monkeypatch.setattr(install, "SYNC", ("false",))
    data = pack(tmp_path / "echo")
    assert restarted.put(f"/v1/installs/{client.sha}", content=data).status_code == 200
    # An install built on another Python is built again.
    (tmp_path / "installs" / client.sha / install.INSTALLED).write_text("another python\n", encoding="utf-8")
    again = _app(tmp_path, monkeypatch, model, workspaces)
    monkeypatch.setattr(install, "SYNC", ("false",))
    response = again.put(f"/v1/installs/{client.sha}", content=data)
    assert response.status_code == 502 and "uv sync failed" in response.json()["error"]


def test_starting_removes_the_installs_no_caller_gets_back(tmp_path: Path) -> None:
    root = tmp_path / "installs"
    python = plugin_python(sys.executable)

    def here(name: str) -> str:
        return install.install_marker((root / name).resolve(), python)

    markers = [
        ("used", here("used")),
        ("unused", here("unused")),
        ("unfinished", None),
        ("other-python", "another python\n"),
        # Moved from another folder: its .venv still names that one.
        ("moved", here("used")),
    ]
    for name, marker in markers:
        (root / name).mkdir(parents=True)
        if marker is not None:
            (root / name / install.INSTALLED).write_text(marker, encoding="utf-8")
    month_ago = time.time() - 31 * 86_400
    os.utime(root / "unused" / install.INSTALLED, (month_ago, month_ago))
    install.Installs(root, tmp_path / "uv-cache", 30, python)
    assert [folder.name for folder in root.iterdir()] == ["used"]


def test_builds_only_what_has_no_wheel_for_this_python(tmp_path: Path) -> None:
    lock = tmp_path / "uv.lock"
    wheel = "https://files.pythonhosted.org/packages/ab/cd/{}-1.0-py3-none-any.whl"
    lock.write_text(
        f"""
version = 1
[[package]]
name = "wheeled"
source = {{ registry = "https://pypi.org/simple" }}
wheels = [{{ url = "{wheel.format("wheeled")}" }}]

[[package]]
name = "sdist-only"
source = {{ registry = "https://pypi.org/simple" }}
sdist = {{ url = "https://files.pythonhosted.org/packages/ab/cd/sdist_only-1.0.tar.gz" }}

[[package]]
name = "other-platform"
source = {{ registry = "https://pypi.org/simple" }}
wheels = [{{ url = "https://files.pythonhosted.org/packages/ab/cd/other_platform-1.0-cp312-cp312-win_arm64.whl" }}]

[[package]]
name = "from-git"
source = {{ git = "https://github.com/example/from-git#abc" }}

[[package]]
name = "the-plugin"
source = {{ editable = "." }}
""",
        encoding="utf-8",
    )
    assert install.built_here(lock, plugin_python(sys.executable).tags) == ["sdist-only", "other-platform", "from-git", "the-plugin"]


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
            f"uv_cache={tmp_path / 'uv-cache'}",
            f"plugin_python={sys.executable}",
            "host=127.0.0.1",
            "sandbox=none",
        ],
    )
    client = TestClient(create_app(config, plugin_model=model), headers={"Authorization": f"Bearer {TOKEN}"})
    [plugin] = client.get("/v1/plugins").json()["plugins"]
    assert plugin["id"] == "echo" and len(plugin["uiVersion"]) == 16
    assert client.get(f"/v1/plugins/echo/ui/{plugin['uiVersion']}/index.html").status_code == 200
    [tool] = [event for event in _events(client.post("/v1/workspaces/alice/plugins/echo/runs", json={"input": "echo hi"})) if event["type"] == "tool"]
    assert json.loads(tool["output"])["verdict"]["valid"] is True
    assert client.post("/v1/workspaces/alice/plugins/missing/runs", json={"input": "x"}).status_code == 404


def test_install_routes_require_the_token(client: TestClient) -> None:
    client.headers.pop("Authorization")
    assert client.get(f"/v1/installs/{client.sha}").status_code == 401
    assert client.put(f"/v1/installs/{client.sha}", content=b"").status_code == 401


def runs(client: TestClient, workspace: str = "alice") -> str:
    return f"/v1/workspaces/{workspace}/installs/{client.sha}"


def test_runs_a_prompt_in_the_callers_workspace(client: TestClient, model: ScriptedModel, workspaces: Path) -> None:
    with client.stream("POST", f"{runs(client)}/runs", json={"input": "echo hi"}) as response:
        assert response.status_code == 200
        events = [json.loads(line[len("data: ") :]) for line in response.iter_lines() if line.startswith("data: ")]
    assert [event["type"] for event in events] == ["start", "tool_start", "tool_progress", "tool", "step", "delta", "done"]
    assert events[0]["profile"] == "plugin-echo"
    assert events[-1]["metrics"]["ttft_s"] is not None
    # The task shows as it starts, and reports checking its result before it ends.
    call = events[3]["id"]
    assert {key: events[1][key] for key in ("id", "name")} == {"id": call, "name": "echo"}
    assert {key: events[2][key] for key in ("id", "event", "data")} == {"id": call, "event": "task.result", "data": {}}
    assert events[3]["name"] == "echo" and not events[3]["is_error"]
    # The chat's tool is the echo task: its result is the task's typed output and its verdict.
    result = json.loads(events[3]["output"])
    assert result["output"] == {"value": "hi"} and result["verdict"]["valid"] is True
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
    assert [f["path"] for f in client.get("/v1/workspaces/alice/files").json()["files"]] == ["papers/ms.tex"]
    assert client.get("/v1/workspaces/alice/files/escape").status_code == 404
    assert client.get("/v1/workspaces/alice/files/papers/../../secret.txt").status_code in {400, 404}
    assert client.get("/v1/workspaces/bad.id/files").status_code == 400


def test_refuses_to_run_a_plugin_in_development(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, model: ScriptedModel, workspaces: Path) -> None:
    client = _app(tmp_path, monkeypatch, model, workspaces)
    manifest = write_plugin(tmp_path / "echo")
    manifest.write_text(manifest.read_text().replace("status: ready", "status: in-development"))
    data = pack(tmp_path / "echo")
    client.sha = hashlib.sha256(data).hexdigest()
    assert client.put(f"/v1/installs/{client.sha}", content=data).json()["plugin"]["status"] == "in-development"
    response = client.post(f"{runs(client)}/runs", json={"input": "echo hi"})
    assert response.status_code == 409
    assert response.json() == {"error": "Echo is under maintenance"}


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
    assert client.post(move, json={"from": "notes/draft.md", "to": "papers/draft.md"}).json() == {"moved": True}
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
    return [json.loads(line[len("data: ") :]) for line in response.text.splitlines() if line.startswith("data: ")]


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


def test_a_reference_tool_sees_the_workspace_files(tmp_path: Path) -> None:
    from nanoagent.web.plugin_agent import staged_from

    workspace = tmp_path / "workspace"
    (workspace / "inputs").mkdir(parents=True)
    (workspace / "inputs" / "raw.bib").write_text("@misc{a}")
    stage = staged_from(workspace)
    stage(workspace)
    assert sorted(path.name for path in workspace.rglob("*")) == ["inputs", "raw.bib"]
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    stage(scratch)
    assert (scratch / "inputs" / "raw.bib").read_text() == "@misc{a}"


def _install_decide_echo(client: TestClient, tmp_path: Path) -> None:
    """Install the echo plugin with its echo task as a decide task."""
    root = tmp_path / "echo"
    _echo(root)
    manifest = root / "nanoagent.yaml"
    manifest.write_text(manifest.read_text().replace("runner: tool", "runner: decide"))
    data = pack(root)
    client.sha = hashlib.sha256(data).hexdigest()
    assert client.put(f"/v1/installs/{client.sha}", content=data).status_code == 200


class DecideModel:
    """The chat calls the echo task, whose decider calls echo and then submits; every reply and
    every answer costs 0.01."""

    async def query(self, messages, tools, on_delta=None, **_):
        if any(message["role"] == "tool" for message in messages):
            return Reply(content="I echoed hi.", cost=0.01)
        return Reply(content=None, tool_calls=[ToolCall("call-1", "echo", '{"value": "hi"}')], cost=0.01)

    async def answer(self, messages, *, name, schema):
        assert name == "answer" and list(schema["properties"]) == ["next"]
        return Answer({"next": "echo" if '"calls": []' in messages[-1]["content"] else "submit"}, cost=0.01)


def test_a_chat_runs_a_decide_task_and_counts_its_cost(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, workspaces: Path) -> None:
    client = _app(tmp_path, monkeypatch, DecideModel(), workspaces)
    _install_decide_echo(client, tmp_path)
    with client.stream("POST", f"{runs(client)}/runs", json={"input": "echo hi"}) as response:
        events = [json.loads(line[len("data: ") :]) for line in response.iter_lines() if line.startswith("data: ")]
    [tool] = [event for event in events if event["type"] == "tool"]
    assert tool["name"] == "echo" and json.loads(tool["output"])["output"] == {"value": "hi"}
    # Two chat replies and the decider's two answers.
    assert events[-1]["metrics"]["cost"] == pytest.approx(0.04)


def _install_with_agent_task(client: TestClient, tmp_path: Path) -> None:
    """Install the echo plugin with a second task, echo-agent, that an agent works."""
    root = tmp_path / "echo"
    manifest = write_plugin(root)
    manifest.write_text(
        manifest.read_text()
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
        .replace(
            "TASKS = {Task.ECHO: (EchoInput, EchoOutput)}",
            "TASKS = {Task.ECHO: (EchoInput, EchoOutput), Task.ECHO_AGENT: (EchoInput, EchoOutput)}",
        )
    )
    readme = root / "README.md"
    readme.write_text(readme.read_text().replace("`echo` repeats its input.", "`echo` repeats its input; `echo-agent` has an agent do it."))
    data = pack(root)
    client.sha = hashlib.sha256(data).hexdigest()
    assert client.put(f"/v1/installs/{client.sha}", content=data).status_code == 200


class TaskModel:
    """The chat calls the echo-agent task, whose agent echoes, submits and answers; every reply
    costs 0.01. Keeps the task agent's system prompts and tools."""

    def __init__(self) -> None:
        self.task_agent: list[tuple[str, set[str]]] = []

    async def query(self, messages, tools, on_delta=None, **_):
        names = {tool["function"]["name"] for tool in tools}
        results = [message for message in messages if message["role"] == "tool"]
        if on_delta is not None:
            on_delta("content", "x")
        if "submit" in names:
            self.task_agent.append((messages[0]["content"], names))
            if not results:
                return Reply(content=None, tool_calls=[ToolCall("call-1", "echo", '{"value": "hi"}')], cost=0.01)
            if len(results) == 1:
                return Reply(content=None, tool_calls=[ToolCall("call-2", "submit", '{"value": "hi"}')], cost=0.01)
            return Reply(content="echoed", cost=0.01)
        if not results:
            return Reply(content=None, tool_calls=[ToolCall("call-1", "echo-agent", '{"value": "hi"}')], cost=0.01)
        return Reply(content="I echoed hi.", cost=0.01)


def test_a_chat_runs_an_agent_task_and_counts_its_cost(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, workspaces: Path) -> None:
    model = TaskModel()
    client = _app(tmp_path, monkeypatch, model, workspaces)
    _install_with_agent_task(client, tmp_path)
    with client.stream("POST", f"{runs(client)}/runs", json={"input": "echo hi with the agent"}) as response:
        events = [json.loads(line[len("data: ") :]) for line in response.iter_lines() if line.startswith("data: ")]
    [tool] = [event for event in events if event["type"] == "tool"]
    assert tool["name"] == "echo-agent" and json.loads(tool["output"])["output"] == {"value": "hi"}
    # While it runs, the task shows what its agent writes and each tool it calls; the agent's own
    # calls are the task's progress, not calls of the chat.
    [started] = [event for event in events if event["type"] == "tool_start"]
    assert (started["id"], started["name"]) == (tool["id"], "echo-agent")
    progress = [(event["event"], event["data"]) for event in events if event["type"] == "tool_progress"]
    assert progress == [
        ("task.delta", {"kind": "content", "text": "x"}),
        ("task.tool", {"name": "echo", "isError": False}),
        ("task.delta", {"kind": "content", "text": "x"}),
        ("task.tool", {"name": "submit", "isError": False}),
        ("task.delta", {"kind": "content", "text": "x"}),
        ("task.result", {}),
    ]
    # Two chat replies and the task agent's three.
    assert events[-1]["metrics"]["cost"] == pytest.approx(0.05)
    # The task's agent works with its instructions and only its own tools.
    prompt, names = model.task_agent[0]
    assert "Echo the value with the echo tool." in prompt and names == {"echo", "submit"}
