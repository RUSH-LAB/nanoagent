"""Integration test: the real supervisor and its microVMs, the relay, attempt services, plugin tools and verifier, with a fake worker API.

    .venv/bin/python -m pytest -p no:cacheprovider -m microsandbox test/uploaded/test_runner_microsandbox.py

A tiny Python harness reads its request, calls `/chat/completions` with the exact prompt through the relay, calls the
probe plugin's `wait` tool through `/tools` with the model's `cause`, tries direct egress and writes `result.json`. The
upstream is the scripted MockProvider; the verdict comes from the acceptance-probe plugin's real verifier.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
import uuid
from decimal import Decimal
from pathlib import Path

import pytest
import runner_fakes as fx
from nanoagent.plugin.package import pack
from nanoagent.uploaded.endpoint import EndpointProfile
from nanoagent.uploaded.plugin_package import isolate
from nanoagent.uploaded.relay import HostRelay
from nanoagent.uploaded.runner import AttemptRunner, RunnerConfig, SyncedPlugins
from nanoagent.uploaded.sandbox import MicrosandboxSupervisor
from nanoagent.uploaded.toolchains import toolchain

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "acceptance" / "benchmark"))
from mockllm import MockProvider, Scenario, Turn, Usage  # noqa: E402

pytestmark = pytest.mark.microsandbox

TOOLS = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker")) / "guest-tools"
SCRATCH = Path(os.environ.get("RUSH_WORKER_HOME", Path.home() / "rush-worker")) / "scratch"
MODEL = "test/model"
TOKEN = "alpha"
DIGEST = hashlib.sha256(TOKEN.encode()).hexdigest()[:12]

HARNESS = r'''
import errno, hashlib, json, os, socket, subprocess, urllib.request

request = json.load(open(os.environ["RUSH_REQUEST"]))
auth = {"Authorization": "Bearer " + os.environ["RUSH_ATTEMPT_TOKEN"], "Content-Type": "application/json"}


def post(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), auth)
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response), response.headers


chat, headers = post(request["openrouter"]["base_url"] + "/chat/completions", {
    "model": request["openrouter"]["model"],
    "messages": [{"role": "user", "content": request["prompt"]["user"]}],
    "tools": [{"type": "function", "function": {"name": "wait", "parameters": {"type": "object"}}}],
})
if request["policy"] == "task_tools":
    call = chat["choices"][0]["message"]["tool_calls"][0]
    tool, _ = post(request["tools"]["url"], {
        "name": call["function"]["name"], "arguments": json.loads(call["function"]["arguments"]),
        "cause": {"model_call_id": headers["X-Rush-Call-Id"], "tool_call_id": call["id"]},
    })
    assert tool["output"]["waited"] == 0, tool
else:
    assert request["tools"]["available"] == []

subprocess.run(["/bin/true"], check=True)
sock = socket.socket()
sock.settimeout(3)
try:
    sock.connect(("1.1.1.1", 443))
    egress = "ok"
except OSError as error:
    egress = errno.errorcode.get(error.errno, str(error.errno))
open(os.path.join(os.environ["RUSH_WORKSPACE"], "egress.txt"), "w").write(egress)

digest = hashlib.sha256(request["case"]["arguments"]["token"].encode()).hexdigest()[:12]
if request["policy"] == "coding":
    # RUSH_RESULT is ignored under the coding policy: the answer is the workspace's answer.json.
    open(os.environ["RUSH_RESULT"], "w").write("not a result")
    json.dump({"digest": digest}, open(os.path.join(os.environ["RUSH_WORKSPACE"], "answer.json"), "w"))
else:
    tmp = os.environ["RUSH_RESULT"] + ".tmp"
    with open(tmp, "w") as out:
        json.dump({"protocol": "rush.harness.v1", "status": "answered", "answer": {"digest": digest}}, out)
    os.rename(tmp, os.environ["RUSH_RESULT"])
'''


def source_zip() -> bytes:
    import io
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "harness.yaml",
            "protocol: rush.harness.v1\nname: h\nversion: '1'\ndialects: [chat_completions]\ntoolchain: python-3\nlockfiles: []\nbuild:\n  argv: [sh, -c, cp main.py /build-out/main.py]\n  outputs: [main.py]\nrun:\n  argv: [python, /harness/main.py]\n",
        )
        archive.writestr("main.py", HARNESS)
    return buffer.getvalue()


@pytest.mark.parametrize(("policy", "internet"), [("task_tools", False), ("coding", False), ("coding", True)])
async def test_attempt_runs_through_relay_gateway_tools_and_verifier(policy: str, internet: bool) -> None:
    package = pack(fx.PROBE)
    manifest = fx.FakePlugins().manifest
    task = manifest.task("probe")
    body = fx.job_body(policy, limits={"internet_access": internet, "wall_time_ms": 120_000}, tools=[fx.WAIT_TOOL])
    body["task"]["egress_hosts"] = []
    body["case"] |= {"arguments": {"token": TOKEN, "wait_seconds": 0.0}, "input_schema": task.input, "output_schema": task.output}
    body["private_reference"] = {"digest": DIGEST}
    body["plugin"]["sha256"] = hashlib.sha256(package).hexdigest()
    body["attempt_id"] = str(uuid.uuid4())
    job = fx.parse_job(body)

    class Rush(fx.FakeRush):
        async def package(self, attempt_id: str, fence: int) -> bytes:
            return package

    rush = Rush(source_zip())
    root = SCRATCH / f"runner-{uuid.uuid4().hex[:8]}"
    root.mkdir(parents=True)
    scenario = Scenario(name="probe", turns=[Turn(act={"wait": 0.0}, usage=Usage(prompt=100, completion=10))])
    try:
        with MockProvider() as provider:
            handle = provider.register(scenario, harness="nanoagent", model=MODEL)
            supervisor = MicrosandboxSupervisor(tools=TOOLS, internet=True, model_hosts=("api.openai.com",))
            supervisor.startup(toolchain("python-3"))
            endpoint = EndpointProfile("mock", "mock", handle.base_url, "MOCK_KEY", ("127.0.0.1",), "synthetic-key")
            config = RunnerConfig(
                "image-worker", endpoint, {MODEL: (Decimal("0.000001"), Decimal("0.000004"))}, root, capabilities={**fx.CAPABILITIES, "wall_time_ms": 600_000}, drain_timeout_s=20
            )
            isolate()  # the host sandbox the verifier runs in
            runner = AttemptRunner(config, supervisor=supervisor, worker=rush, relay=HostRelay(), plugins=SyncedPlugins())  # type: ignore[arg-type]
            result = await runner.run(job)
            assert not handle.ledger.violations and len(handle.ledger.calls) == 1
    finally:
        shutil.rmtree(root, ignore_errors=True)

    assert result.outcome == "finalized", result
    [final] = rush.finalized
    assert final["execution"] == {"status": "answered", "reason": None}
    assert final["verdict"] == "pass" and final["verifier_error"] is None, final
    health = rush.of("collector.health")[0]
    assert health["complete"] is True and health["loss_reasons"] == [], health
    execs = {tuple(data["argv"]) for data in rush.of("process.exec")}
    assert ("python", "/harness/main.py") in execs and ("/bin/true",) in execs
    assert rush.of("process.clone") and any(data["exit_code"] == 0 for data in rush.of("process.exit"))
    assert rush.of("model_call.response")[0]["terminal"] == "completed"
    assert bool(rush.of("tool.completed")) is (policy == "task_tools"), "the coding policy has no tools"
    assert rush.of("attempt.started")[0]["policy"] == policy and rush.of("attempt.started")[0]["limits"]["internet_access"] is internet
    [snapshot] = rush.of("snapshot.taken")
    files = {entry["path"]: entry["sha256"] for entry in snapshot["diff"]}
    assert set(files) == {"egress.txt", *(["answer.json"] if policy == "coding" else [])}
    reached = files["egress.txt"] == hashlib.sha256(b"ok").hexdigest()
    assert reached is internet, "direct egress follows internet_access"
    assert final["coverage"]["status"] == "complete", final["coverage"]
    # The mock reports tokens but no cost, so the reservation is kept (uncertain) until a generation lookup could settle it.
    assert [(call, outcome) for call, outcome, _, _ in rush.settles] == [(call, "uncertain") for call in rush.admissions] and len(rush.admissions) == 1
    [counters] = rush.of("cpu.counters")
    assert [p["identity"]["role"] for p in counters["processes"]] == (["harness", "tool"] if policy == "task_tools" else ["harness"])
    assert all(p["user_ns"] + p["system_ns"] > 0 for p in counters["processes"])
