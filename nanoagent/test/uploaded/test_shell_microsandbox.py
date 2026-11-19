"""Integration test: the RUSH terminal (reference harness `shell`) in a real microVM, through the runner, relay, gateway and
verifier, with a fake worker API that types at its PTY, and a `rush <command>` run there, remembered.

    .venv/bin/python -m pytest -p no:cacheprovider -m microsandbox test/uploaded/test_shell_microsandbox.py -s

The member checks the toolchain (node, npm, git, curl), installs from npm and pip (internet egress), calls the model with the
OpenAI SDK and with Claude Code from the preset environment, neither carrying the case's prompt (recorded by the gateway, the
upstream the scripted MockProvider), runs `rush python …` (recorded, and python remembered), then python plain, which the
shell runs as `rush python …` too, and exits.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shutil
import sys
import time
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
import runner_fakes as fx
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
TYPED = [
    "node --version; npm --version; git --version; curl --version | head -n 1",
    "npm install -g --silent is-number && ls .rush/npm/lib/node_modules",
    "time claude --version",
    "pip install --quiet --disable-pip-version-check openai",
    "python -c \"import os; from openai import OpenAI; r = OpenAI().chat.completions.create(model=os.environ['RUSH_MODEL'], "
    "messages=[{'role': 'user', 'content': 'say ok'}]); print('MODEL SAID:', r.choices[0].message.content)\"",
    'claude -p "say ok"',
    "echo \"$OPENAI_BASE_URL $ANTHROPIC_BASE_URL $RUSH_MODEL\"; ls",
    "rush python -c \"print('first run')\"",
    "python -c \"print('plain run')\"",
    "exit",
]


class Rush(fx.FakeRush):
    """The worker API, and the member at the terminal: each line is typed once the shell has drawn one more prompt."""

    def __init__(self, source: bytes, package: bytes, typed: list[str]) -> None:
        super().__init__(source)
        self._package, self._typed = package, typed

    async def package(self, attempt_id: str, fence: int) -> bytes:
        return self._package

    async def terminal_link(self, attempt_id: str, fence: int, port: int, token: str) -> None:
        self._typing = asyncio.get_running_loop().create_task(self._type(port, token))

    async def _type(self, port: int, token: str) -> None:
        """The member's page, over the session's link: each line typed once the shell has drawn one more prompt."""
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(json.dumps({"token": token}).encode() + b"\n")
        for count, line in enumerate(self._typed, 1):
            while self.screen.count(b"rush\x1b[0m:") < count:
                await asyncio.sleep(0.2)
            writer.write(json.dumps({"terminal": 0, "data": base64.b64encode(line.encode() + b"\r").decode()}).encode() + b"\n")
            await writer.drain()
        await reader.read()
        writer.close()



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
    supervisor = MicrosandboxSupervisor(tools=HOME / "guest-tools", internet=True, model_hosts=("api.openai.com",))
    supervisor.startup(toolchain("shell-1"))
    endpoint = EndpointProfile("mock", "mock", handle.base_url, "MOCK_KEY", ("127.0.0.1",), "synthetic-key")
    config = RunnerConfig(
        "shell-worker", endpoint, {MODEL: (Decimal("0.000001"), Decimal("0.000004"))}, root, output_maxima={MODEL: 64_000}, capabilities={**fx.CAPABILITIES, "wall_time_ms": 600_000, "max_model_calls": 50, "build_output_bytes": 4 << 30, "build_wall_ms": 1_800_000},
        drain_timeout_s=20, index_urls={"python-3": "https://pypi.org/simple", "javascript-22": "https://registry.npmjs.org"},
    )  # fmt: skip
    isolate()
    runner = AttemptRunner(config, supervisor=supervisor, worker=rush, relay=HostRelay(), plugins=SyncedPlugins())  # type: ignore[arg-type]
    started = time.monotonic()
    result = await runner.run(fx.parse_job(body))
    print(f"attempt took {time.monotonic() - started:.0f} s")
    return rush, result, handle


async def test_the_terminal_records_its_agents_and_remembers_a_rush_runs_program() -> None:
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
        assert final["verdict"] is None, final  # nothing in a Terminal session is scored
        assert "MODEL SAID: ok" in screen and "/api/v1 " in screen and "prompt.md" in screen and "request.json" in screen
        assert "v22." in screen and "git version" in screen and "curl " in screen and "is-number" in screen
        # Claude Code is installed the first time it is typed, its progress on the terminal.
        assert "installing Claude Code 2.1.325" in screen and "installed Claude Code 2.1.325" in screen and "2.1.325 (Claude Code)" in screen
        # The SDK's call and Claude Code's, neither carrying the case's prompt, both recorded.
        responses = rush.of("model_call.response")
        assert len(handle.ledger.calls) >= 2 and len(responses) == len(handle.ledger.calls) and all(r["terminal"] == "completed" for r in responses)
        assert {call["dialect"] for call in rush.of("model_call.admitted")} >= {"chat_completions", "anthropic_messages"}
        # The rush run is recorded and python remembered: typed plain, it runs as `rush python …`, one more recorded run.
        assert "first run" in screen and "plain run" in screen and screen.count("rush · python · ") == 2, screen
        assert len([data for data in rush.of("process.rush") if data.get("run")]) == 2
        assert json.loads((root / "agents.json").read_text()) == ["python"]

        # The next terminal opens on the build the first kept and runs the install it made at once.
        cached, opened, _ = await attempt(root, build_reference("shell"), package, True, provider, ["time claude --version", "exit"])
        screen = cached.screen.decode(errors="replace")
        print(screen)
        assert "2.1.325 (Claude Code)" in screen and "installing" not in screen
        assert opened.outcome == "finalized"
        assert len(list((root / "builds").iterdir())) == 1  # the terminal's build, kept
