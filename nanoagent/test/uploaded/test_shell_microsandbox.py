"""Integration test: the RUSH terminal (reference harness `shell`) in a real microVM, through the runner, relay, gateway and
verifier, with a fake worker API that types at its PTY, then a rerun of the harness `rush save` made there.

    .venv/bin/python -m pytest -p no:cacheprovider -m microsandbox test/uploaded/test_shell_microsandbox.py -s

The member checks the toolchain (node, npm, git, curl), installs from npm and pip (internet egress), calls the model with the
OpenAI SDK and with Claude Code from the preset environment, neither carrying the case's prompt (recorded by the gateway, the
upstream the scripted MockProvider), writes a tiny agent that answers, runs it, saves it and exits. The saved harness then works
the case on its own: its files back in the workspace, its packages installed from the lock by the build.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import os
import shutil
import sys
import time
import uuid
import zipfile
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
import runner_fakes as fx
import yaml
from nanoagent.plugin.package import pack
from nanoagent.uploaded.endpoint import EndpointProfile
from nanoagent.uploaded.plugin_package import isolate
from nanoagent.uploaded.reference import build_reference
from nanoagent.uploaded.relay import HostRelay
from nanoagent.uploaded.runner import AttemptRunner, RunnerConfig, SyncedPlugins
from nanoagent.uploaded.sandbox import MicrosandboxSupervisor
from nanoagent.uploaded.toolchains import toolchain

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "acceptance" / "benchmark"))
from mockllm import MockProvider, Scenario, Turn, Usage  # noqa: E402

pytestmark = pytest.mark.microsandbox

HOME = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker"))
MODEL = "test/model"
TOKEN = "alpha"
DIGEST = hashlib.sha256(TOKEN.encode()).hexdigest()[:12]
AGENT = 'import json, hashlib; a = json.load(open("request.json")); json.dump({"digest": hashlib.sha256(a["token"].encode()).hexdigest()[:12]}, open("answer.json", "w"))'
TYPED = [
    "node --version; npm --version; git --version; curl --version | head -n 1",
    "npm install -g --silent is-number && ls .rush/npm/lib/node_modules",
    "claude --version; codex --version; pi --version; hermes --version; dsh --version",
    "pip install --quiet --disable-pip-version-check openai",
    "python -c \"import os; from openai import OpenAI; r = OpenAI().chat.completions.create(model=os.environ['RUSH_MODEL'], "
    "messages=[{'role': 'user', 'content': 'say ok'}]); print('MODEL SAID:', r.choices[0].message.content)\"",
    'claude -p "say ok"',
    "echo \"$OPENAI_BASE_URL $ANTHROPIC_BASE_URL $RUSH_MODEL\"; ls",
    f"printf '%s\\n' '{AGENT}' > agent.py",
    "python agent.py && cat answer.json",
    'rush save my-agent -- python agent.py "$RUSH_PROMPT"',
    "exit",
]


class Rush(fx.FakeRush):
    """The worker API, and the member at the terminal: each line is typed once the shell has drawn one more prompt."""

    def __init__(self, source: bytes, package: bytes, typed: list[str]) -> None:
        super().__init__(source)
        self._package, self._typed, self.saved = package, typed, []

    async def package(self, attempt_id: str, fence: int) -> bytes:
        return self._package

    async def terminal_input(self, attempt_id: str, fence: int, after: int) -> list[dict[str, Any]]:
        for _ in range(50):
            if after < len(self._typed) and self.screen.count(b"rush\x1b[0m:") > after:
                return [{"seq": after + 1, "data": base64.b64encode(self._typed[after].encode() + b"\r").decode(), "rows": None, "cols": None}]
            await asyncio.sleep(0.2)
        return []

    async def save_harness(self, attempt_id: str, fence: int, data: bytes) -> dict[str, Any]:
        self.saved.append(data)
        manifest = yaml.safe_load(zipfile.ZipFile(io.BytesIO(data)).read("harness.yaml"))
        return {"source_sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "harness": {"name": manifest["name"], "version": manifest["version"], "dialects": manifest["dialects"]}}


async def attempt(root: Path, source: bytes, package: bytes, interactive: bool, provider: MockProvider, typed: list[str]) -> tuple[Rush, Any, Any]:
    manifest = fx.FakePlugins().manifest
    task = manifest.task("probe")
    body = fx.job_body("coding", limits={"internet_access": True, "wall_time_ms": 300_000, "max_model_calls": 50, "build_output_bytes": 3 << 30, "build_wall_ms": 1_800_000}, tools=[fx.WAIT_TOOL])
    body["run"] |= {"interactive": interactive, "dialects": ["chat_completions", "responses", "anthropic_messages"], "prompt_bound": False}
    body["task"]["egress_hosts"] = []
    body["case"] |= {"arguments": {"token": TOKEN, "wait_seconds": 0.0}, "input_schema": task.input, "output_schema": task.output}
    body["private_reference"] = {"digest": DIGEST}
    body["plugin"]["sha256"] = hashlib.sha256(package).hexdigest()
    body["attempt_id"] = str(uuid.uuid4())
    rush = Rush(source, package, typed)
    handle = provider.register(Scenario(name="shell", turns=[Turn(usage=Usage(prompt=100, completion=10), repeat=0)]), harness="claude", model=MODEL)
    supervisor = MicrosandboxSupervisor(tools=HOME / "guest-tools", internet=True)
    supervisor.startup(toolchain("shell-1"))
    endpoint = EndpointProfile("mock", "mock", handle.base_url, "MOCK_KEY", ("127.0.0.1",), "synthetic-key")
    config = RunnerConfig(
        "shell-worker", endpoint, {MODEL: (Decimal("0.000001"), Decimal("0.000004"))}, root, capabilities={**fx.CAPABILITIES, "wall_time_ms": 600_000, "max_model_calls": 50, "build_output_bytes": 4 << 30, "build_wall_ms": 1_800_000},
        drain_timeout_s=20, index_urls={"python-3": "https://pypi.org/simple", "javascript-22": "https://registry.npmjs.org"},
    )  # fmt: skip
    isolate()
    runner = AttemptRunner(config, supervisor=supervisor, worker=rush, relay=HostRelay(), plugins=SyncedPlugins())  # type: ignore[arg-type]
    started = time.monotonic()
    result = await runner.run(fx.parse_job(body))
    print(f"attempt took {time.monotonic() - started:.0f} s")
    return rush, result, handle


async def test_the_terminal_is_scored_and_what_it_saved_reruns() -> None:
    package = pack(fx.PROBE)
    root = HOME / "scratch" / f"shell-{uuid.uuid4().hex[:8]}"  # one worker's scratch, where builds are kept between attempts
    root.mkdir(parents=True)
    try:
        await scenario(root, package)
    finally:
        shutil.rmtree(root, ignore_errors=True)


async def scenario(root: Path, package: bytes) -> None:
    with MockProvider() as provider:
        rush, result, handle = await attempt(root, build_reference("shell"), package, True, provider, TYPED)
        screen = rush.screen.decode(errors="replace")
        print(screen)
        assert result.outcome == "finalized", result
        [final] = rush.finalized
        assert final["execution"] == {"status": "answered", "reason": None} and final["verdict"] == "pass", final
        assert "MODEL SAID: ok" in screen and "/api/v1 " in screen and "prompt.md" in screen and "request.json" in screen
        assert "v22." in screen and "git version" in screen and "curl " in screen and "is-number" in screen
        assert "2.1.325 (Claude Code)" in screen and "codex-cli 0.167.0" in screen and "Hermes Agent v0.19.0" in screen and "0.2.2-rc.1" in screen
        # The SDK's call and Claude Code's, neither carrying the case's prompt, both recorded.
        responses = rush.of("model_call.response")
        assert len(handle.ledger.calls) >= 2 and len(responses) == len(handle.ledger.calls) and all(r["terminal"] == "completed" for r in responses)
        assert {call["dialect"] for call in rush.of("model_call.admitted")} >= {"chat_completions", "anthropic_messages"}
        [saved] = rush.saved
        archive = zipfile.ZipFile(io.BytesIO(saved))
        names = set(archive.namelist())
        assert {"harness.yaml", "shell.py", "build.sh", "bin/claude", "package-lock.json", "clis.txt", "executables", "workspace/agent.py", "requirements.txt"} <= names, names
        assert not names & {"workspace/answer.json", "workspace/prompt.md", "workspace/request.json"}
        assert "openai==" in archive.read("requirements.txt").decode()
        manifest = yaml.safe_load(archive.read("harness.yaml"))
        assert manifest["run"]["argv"] == ["python", "/harness/shell.py", 'python agent.py "$RUSH_PROMPT"']
        print(archive.read("harness.yaml").decode())

        again, rerun, _ = await attempt(root, saved, package, False, provider, [])
        print(again.screen.decode(errors="replace"))
        assert rerun.outcome == "finalized", rerun
        [final] = again.finalized
        assert final["execution"] == {"status": "answered", "reason": None} and final["verdict"] == "pass", final

        # The next terminal opens on the build the first kept; one left without an answer has no verdict.
        cached, opened, _ = await attempt(root, build_reference("shell"), package, True, provider, ["exit"])
        assert opened.outcome == "finalized" and cached.finalized[0]["execution"] == {"status": "execution_failed", "reason": "missing_result"}
        assert len(list((root / "builds").iterdir())) == 2  # the terminal's build and the saved harness's
