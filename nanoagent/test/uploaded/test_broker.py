"""The tool broker: proposal verification, adaptations, schemas, workspace exclusivity, and a real plugin through PluginSession."""

from __future__ import annotations

import contextlib
import dataclasses
import os
from pathlib import Path
from typing import Any

import anyio
import httpx
import pytest

import service_fakes as fakes
from nanoagent.plugin.manifest import load_manifest
from nanoagent.uploaded.attempt import ToolPolicy
from nanoagent.uploaded.broker import PluginToolRunner, ToolError
from service_fakes import PATHS, ScriptedTransport, chat_request, make_rig, propose, stream_script

PROBE = Path(__file__).resolve().parents[1] / "plugins" / "acceptance-probe"


def last(rig, kind):
    return rig.journal.of(kind)[-1].data


async def call(client: httpx.AsyncClient, name: str, arguments: dict[str, Any], cause: tuple[str, str] | None = None, **kwargs: Any) -> httpx.Response:
    body: dict[str, Any] = {"name": name, "arguments": arguments}
    if cause:
        body["cause"] = {"model_call_id": cause[0], "tool_call_id": cause[1]}
    return await client.post("/tools", json=body, **kwargs)


async def test_matching_proposal_runs_without_an_adaptation(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        cause = await propose(client, rig, "read", {"n": 2})
        response = await call(client, "read", {"n": 2.0}, cause, headers={"x-rush-span-id": "t1"})
    assert response.status_code == 200 and response.json() == {"output": {"ok": True, "echo": {"n": 2.0}}} and response.headers["x-rush-call-id"]
    invoked = last(rig, "tool.invoked")
    assert invoked["adapted"] is False and invoked["adaptation"] is None and invoked["cause"] == {"model_call_id": cause[0], "tool_call_id": cause[1]}
    assert invoked["span_id"] == "t1" and last(rig, "tool.completed")["ok"] is True
    assert rig.tools.calls == [("read", {"n": 2.0})]


async def test_changed_arguments_are_an_adaptation_linked_to_the_proposal(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        cause = await propose(client, rig, "read", {"n": 2})
        response = await call(client, "read", {"n": 3}, cause)
    assert response.status_code == 200
    adaptation = last(rig, "tool.invoked")["adaptation"]
    assert last(rig, "tool.invoked")["adapted"] is True
    assert adaptation["proposal_arguments"] == {"n": 2} and adaptation["actual_arguments"] == {"n": 3}
    assert adaptation["model_call_id"] == cause[0] and adaptation["tool_call_id"] == "call_1" and adaptation["proposal_raw_arguments"] == '{"n": 2}'
    assert rig.tools.calls == [("read", {"n": 3})]


async def test_unknown_proposal_and_mismatched_tool_are_409(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        model_call, tool_call = await propose(client, rig, "read", {"n": 1})
        unknown_call = await call(client, "read", {"n": 1}, ("no-such-call", tool_call))
        unknown_tool_call = await call(client, "read", {"n": 1}, (model_call, "call_zzz"))
        mismatch = await call(client, "write", {}, (model_call, tool_call))
    assert (unknown_call.status_code, unknown_call.json()["error"]["code"]) == (409, "unknown_proposal")
    assert unknown_tool_call.json()["error"]["code"] == "unknown_proposal"
    assert (mismatch.status_code, mismatch.json()["error"]["code"]) == (409, "tool_mismatch")
    assert [e.data["code"] for e in rig.journal.of("tool.rejected")] == ["unknown_proposal", "unknown_proposal", "tool_mismatch"]
    assert rig.tools.calls == [] and last(rig, "tool.rejected")["cause"]["tool_call_id"] == tool_call


async def test_unavailable_tools_are_refused_including_private_ones(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        response = await call(client, "digest", {"token": "t"})
    assert response.status_code == 403 and response.json()["error"]["code"] == "tool_not_available" and rig.tools.calls == []


async def test_schema_violations_in_either_direction(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        bad_input = await call(client, "read", {"n": "x"})
        rig.tools.output = {"nope": 1}
        bad_output = await call(client, "read", {"n": 1})
        malformed = await client.post("/tools", json={"arguments": {}})
    assert (bad_input.status_code, bad_input.json()["error"]["code"]) == (400, "invalid_arguments") and "/n" in bad_input.json()["error"]["message"]
    assert (bad_output.status_code, bad_output.json()["error"]["code"]) == (502, "invalid_output")
    assert malformed.status_code == 400 and malformed.json()["error"]["code"] == "schema_violation"
    assert len(rig.tools.calls) == 1  # only the call with valid input ran


async def test_tool_errors_use_the_envelope(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    rig.tools.fail = ToolError("tool_failed", "boom")
    async with rig.client() as client:
        response = await call(client, "read", {"n": 1})
    assert response.status_code == 422 and response.json() == {"error": {"code": "tool_failed", "message": "boom"}}
    assert last(rig, "tool.completed")["ok"] is False and last(rig, "tool.completed")["error"]["code"] == "tool_failed"


async def test_token_and_revocation_gate_the_broker(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    async with rig.client() as client:
        assert (await call(client, "read", {"n": 1}, headers={"authorization": "Bearer x"})).status_code == 401
        await rig.services.revoke(1)
        assert (await call(client, "read", {"n": 1})).json()["error"]["code"] == "revoked"
    assert rig.tools.calls == []


async def test_mcp_lists_the_tools_and_calls_them_through_the_broker(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())

    async def rpc(client: httpx.AsyncClient, method: str, params: dict[str, Any] | None = None, **kwargs: Any) -> httpx.Response:
        return await client.post("/mcp", json={"jsonrpc": "2.0", "id": 7, "method": method, **({"params": params} if params is not None else {})}, **kwargs)

    async with rig.client() as client:
        hello = (await rpc(client, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})).json()
        initialized = await client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"})
        listed = (await rpc(client, "tools/list")).json()["result"]["tools"]
        called = (await rpc(client, "tools/call", {"name": "read", "arguments": {"n": 2}})).json()["result"]
        refused = (await rpc(client, "tools/call", {"name": "read", "arguments": {"n": "x"}})).json()["result"]
        unknown = (await rpc(client, "resources/list")).json()
        stream = await client.get("/mcp")
        unauthorized = await rpc(client, "tools/list", headers={"authorization": "Bearer x"})
    assert hello["result"]["protocolVersion"] == "2025-06-18" and hello["result"]["capabilities"] == {"tools": {}}
    assert initialized.status_code == 202 and stream.status_code == 405 and unauthorized.status_code == 401
    assert [(tool["name"], tool["description"]) for tool in listed] == [("read", "Read the n-th entry."), ("write", "Write the workspace.")]
    assert listed[0]["inputSchema"] == fakes.TOOLS[0].input_schema and listed[0]["outputSchema"] == fakes.TOOLS[0].output_schema
    assert called == {"content": [{"type": "text", "text": '{"ok": true, "echo": {"n": 2}}'}], "structuredContent": {"ok": True, "echo": {"n": 2}}}
    assert refused["isError"] is True and refused["content"][0]["text"].startswith("invalid_arguments: ")
    assert unknown["error"]["code"] == -32601
    # Each call is the broker's: recorded as a POST /tools call is.
    assert rig.tools.calls == [("read", {"n": 2})] and last(rig, "tool.invoked")["tool"] == "read" and last(rig, "tool.completed")["ok"] is True
    assert last(rig, "tool.rejected")["code"] == "invalid_arguments"


async def test_writing_tools_are_exclusive_and_readers_run_together(tmp_path: Path) -> None:
    rig = make_rig(tmp_path, ScriptedTransport())
    rig.tools.delay = 0.05

    async def go(name: str, arguments: dict[str, Any]) -> None:
        async with rig.client() as client:
            assert (await call(client, name, arguments)).status_code == 200

    async with anyio.create_task_group() as group:
        for _ in range(3):
            group.start_soon(go, "read", {"n": 1})
        for _ in range(3):
            group.start_soon(go, "write", {})
        for _ in range(2):
            group.start_soon(go, "read", {"n": 1})
    assert rig.tools.overlaps == 0 and rig.tools.max_readers >= 2 and len(rig.tools.calls) == 8


async def _broker_during_stream(tmp_path: Path, chunks: list[bytes], *, expect_before_release: bool):
    hold = anyio.Event()
    rig = make_rig(tmp_path, ScriptedTransport(stream_script(chunks, hold=hold)))
    outcome: dict[str, httpx.Response] = {}

    async def stream() -> None:
        async with rig.client() as client:
            outcome["stream"] = await client.post(PATHS["chat_completions"], json=chat_request(stream=True))

    async def act() -> None:
        while not rig.journal.of("model_call.admitted"):
            await anyio.sleep(0.01)
        model_call = rig.journal.of("model_call.admitted")[0].data["call_id"]
        async with rig.client() as client:
            outcome["tool"] = await call(client, "read", {"n": 1}, (model_call, "call_a"))

    async def release() -> None:
        await anyio.sleep(0.2)
        assert ("tool" in outcome) is expect_before_release
        assert "stream" not in outcome  # the upstream stream is still open
        hold.set()

    async with anyio.create_task_group() as group:
        for task in (stream, act, release):
            group.start_soon(task)
    return rig, outcome


async def test_a_completed_proposal_is_callable_while_the_stream_is_still_open(tmp_path: Path) -> None:
    # The held chunk is the final [DONE]: the tool call's arguments finished two frames earlier.
    rig, outcome = await _broker_during_stream(tmp_path, fakes.chat_stream_chunks(), expect_before_release=True)
    assert outcome["tool"].status_code == 200 and rig.tools.calls == [("read", {"n": 1})]
    [early] = last(rig, "model_call.response")["registrations"]
    assert early["early"] is True and early["tool_call_id"] == "call_a" and early["frame_index"] == 2
    assert early["registered_ns"] < last(rig, "model_call.response")["completed_ns"]


async def test_broker_waits_for_a_proposal_whose_arguments_are_not_complete_yet(tmp_path: Path) -> None:
    # The held chunk carries the finish_reason frame, so the proposal does not exist until it is released.
    rig, outcome = await _broker_during_stream(tmp_path, fakes.chat_stream_chunks()[:3], expect_before_release=False)
    assert outcome["tool"].status_code == 200 and rig.tools.calls == [("read", {"n": 1})]


# ---- the plugin runner -------------------------------------------------------------------------------------------------

WAIT = ToolPolicy(
    "wait",
    False,
    {"type": "object", "properties": {"wait_seconds": {"type": "number"}}, "required": ["wait_seconds"]},
    {"type": "object", "properties": {"waited": {"type": "number"}}, "required": ["waited"]},
    "wait a while",
)


async def test_real_probe_tool_runs_through_plugin_session_via_the_broker(tmp_path: Path) -> None:
    manifest = load_manifest(PROBE)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    async with PluginToolRunner(manifest, workspace, ("wait",), timeout=120) as runner:
        rig = make_rig(tmp_path, ScriptedTransport(), policy=fakes.make_policy(tools=(WAIT,)))
        rig.services.broker.runner = runner
        async with rig.client() as client:
            cause = await propose(client, rig, "wait", {"wait_seconds": 0.1})
            response = await call(client, "wait", {"wait_seconds": 0.1}, cause)
            private = await call(client, "digest", {"token": "t"})
    assert response.status_code == 200 and response.json() == {"output": {"waited": 0.1}}
    assert private.status_code == 403 and private.json()["error"]["code"] == "tool_not_available"
    assert last(rig, "tool.completed")["ok"] is True


async def test_runner_refuses_reference_tools_unknown_tools_and_ungranted_env(tmp_path: Path) -> None:
    manifest = load_manifest(PROBE)
    with pytest.raises(ValueError, match=r"reference tools \['digest'\] run privately"):
        PluginToolRunner(manifest, tmp_path, ("wait", "digest"))
    with pytest.raises(ValueError, match="has no tools"):
        PluginToolRunner(manifest, tmp_path, ("nope",))
    with pytest.raises(ValueError, match=r"environment variables \['SECRET_TOKEN'\]"):
        PluginToolRunner(dataclasses.replace(manifest, env=("SECRET_TOKEN",)), tmp_path, ("wait",))
    PluginToolRunner(dataclasses.replace(manifest, env=("SECRET_TOKEN",)), tmp_path, ("wait",), allowed_env=frozenset({"SECRET_TOKEN"}))
    runner = PluginToolRunner(manifest, tmp_path, ("wait",))
    with pytest.raises(ToolError, match="not a permitted tool"):
        await runner.run("digest", {"token": "t"}, tmp_path)
    with pytest.raises(ToolError, match="different workspace"):
        await runner.run("wait", {"wait_seconds": 0}, tmp_path / "elsewhere")


# ---- read-only fixtures ------------------------------------------------------------------------------------------------


async def test_the_runner_hands_its_fixtures_folder_to_the_sandbox_as_read_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from nanoagent.plugin import sandbox

    manifest = load_manifest(PROBE)
    workspace, fixtures = tmp_path / "workspace", tmp_path / "fixtures"
    workspace.mkdir()
    fixtures.mkdir()
    launched: list[dict[str, Any]] = []
    real = sandbox.launch

    def spy(argv, **kwargs):
        launched.append(kwargs)
        return real(argv, **kwargs)

    monkeypatch.setattr(sandbox, "launch", spy)
    async with PluginToolRunner(manifest, workspace, ("wait",), fixtures=fixtures, timeout=120) as runner:
        assert await runner.run("wait", {"wait_seconds": 0}, workspace) == {"waited": 0}
    # The plugin's own process is the launch that is given the fixtures; the verifier's launches read the workspace instead.
    [mcp_launch] = [kwargs for kwargs in launched if fixtures in kwargs.get("readable", [])]
    assert mcp_launch["readable"] == [fixtures] and mcp_launch["writable"] == [workspace]
    with pytest.raises(ValueError, match="fixtures .* is not a folder"):
        async with PluginToolRunner(manifest, workspace, ("wait",), fixtures=tmp_path / "missing"):
            pass


def _confinement_kinds() -> list[str]:
    import shutil
    import sys

    if sys.platform == "darwin" and Path("/usr/bin/sandbox-exec").exists():
        return ["seatbelt"]
    return ["bwrap"] if sys.platform.startswith("linux") and shutil.which("bwrap") else []


@pytest.mark.skipif(not _confinement_kinds(), reason="needs seatbelt (macOS) or bwrap (Linux)")
def test_a_process_launched_with_fixtures_can_read_them_but_not_write_them(tmp_path: Path) -> None:
    import subprocess
    import sys

    from nanoagent.plugin import sandbox
    from nanoagent.plugin.python import plugin_python

    plugin, workspace, fixtures = tmp_path / "plugin", tmp_path / "workspace", tmp_path / "fixtures"
    for folder in (plugin, workspace, fixtures):
        folder.mkdir()
    (fixtures / "data.txt").write_text("fixture")
    script = (
        "import sys\n"
        "print(open(sys.argv[1]).read())\n"
        "for path in sys.argv[2:]:\n"
        "    try:\n"
        "        open(path, 'w').write('x'); print('wrote')\n"
        "    except OSError:\n"
        "        print('refused')\n"
    )
    sandbox.configure(_confinement_kinds()[0], plugin_python(sys.executable))
    try:
        # The same arguments PluginSession passes for a runner with fixtures.
        with sandbox.launch(
            [sys.executable, "-I", "-c", script, str(fixtures / "data.txt"), str(fixtures / "data.txt"), str(workspace / "out")],
            root=plugin,
            env={},
            readable=[fixtures],
            writable=[workspace],
        ) as (argv, env):
            output = subprocess.run(argv, env=env, capture_output=True, text=True, check=True).stdout.split("\n")
    finally:
        sandbox.configure("none")
    assert output[:3] == ["fixture", "refused", "wrote"]


# ---- a launcher in place of the host sandbox ---------------------------------------------------------------------------


class RecordingLauncher:
    """Runs the plugin as a plain local process, recording how the session used the launcher."""

    def __init__(self, view: Path) -> None:
        self.view = view
        self.launches: list[dict[str, str]] = []
        self.views = 0

    @contextlib.contextmanager
    def launch(self, manifest, env):
        self.launches.append(dict(env))
        yield list(manifest.command), dict(os.environ)

    @contextlib.contextmanager
    def workspace_view(self):
        self.views += 1
        yield self.view


async def test_a_launcher_replaces_the_host_sandbox_and_the_workspace_need_not_exist_on_the_host(tmp_path: Path) -> None:
    manifest = load_manifest(PROBE)
    view = tmp_path / "view"
    view.mkdir()
    launcher = RecordingLauncher(view)
    workspace = Path("/rush/workspace")  # a path inside the tool container only
    async with PluginToolRunner(manifest, workspace, ("wait",), timeout=120, launcher=launcher) as runner:
        assert await runner.run("wait", {"wait_seconds": 0}, workspace) == {"waited": 0}
    assert launcher.launches == [{"NANOAGENT_WORKSPACE": "/rush/workspace"}] and launcher.views == 1
