from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.core.agent import Agent, Reply, StopReason, ToolCall
from nanoagent.plugin import load_manifest
from nanoagent.plugin.manifest import PluginError
from nanoagent.plugin.tasks import run_task
from nanoagent.plugin.verifier import Verification
from test_plugin import write_plugin


def evaluated_plugin(root: Path):
    manifest = write_plugin(root)
    manifest.write_text(
        manifest.read_text().replace("v0001", "v0002")
        .replace("runner: tool", "runner: agent")
        .replace("tools: [echo]", "tools: []\n    evaluator: echo")
    )
    product = root / "product/product.yaml"
    product.write_text(product.read_text().replace("v0001", "v0002"))
    contract = root / "contract.py"
    contract.write_text(
        contract.read_text()
        .replace("@dataclass\nclass EchoOutput", "@dataclass\nclass CandidateInput(Output):\n    source: str\n\n\n@dataclass\nclass EchoOutput")
        .replace("TOOLS = {Tool.ECHO: (EchoInput, EchoOutput)}", "TOOLS = {Tool.ECHO: (CandidateInput, EchoOutput)}")
    )
    server = root / "src/plugin/__main__.py"
    server.write_text(server.read_text().replace("EchoInput", "CandidateInput").replace("given.value", "given.source"))
    verifier = root / "verifier/__init__.py"
    verifier.write_text(verifier.read_text().replace("bool(value.value)", "bool(value.source)")
                        .replace("output_value.value == input_value.value", "output_value.value == input_value.source"))
    return load_manifest(root)


@pytest.mark.parametrize("valid", [True, False])
async def test_submission_stops_the_model_then_evaluates_and_verifies(tmp_path, monkeypatch, valid):
    manifest = evaluated_plugin(tmp_path / "plugin")
    order, events = [], []

    class Model:
        async def query(self, messages, tools, **kwargs):
            assert order == []  # No model request is allowed after submit.
            order.append("model")
            assert [tool["function"]["name"] for tool in tools] == ["submit"]
            schema = tools[0]["function"]["parameters"]
            assert set(schema["properties"]) == {"source"}
            return Reply(None, [ToolCall("candidate", "submit", '{"source": "the code"}')])

    async def evaluate(manifest, name, arguments, *, workspace, timeout):
        assert order == ["model"]
        assert name == "echo" and arguments == {"source": "the code"}
        order.append("evaluate")
        return {"value": "measured report"}

    def verify(manifest, task, arguments, output, reference, workspace):
        assert order == ["model", "evaluate"]
        assert arguments == {"value": "request"} and output == {"value": "measured report"}
        order.append("verify")
        return Verification(valid, float(valid), "accepted" if valid else "rejected", {})

    monkeypatch.setattr("nanoagent.plugin.tasks.call_tool_async", evaluate)
    monkeypatch.setattr("nanoagent.plugin.tasks.verify_task", verify)
    outcome = await run_task(
        manifest, manifest.task("echo"), {"value": "request"}, tmp_path / "run",
        make_agent=lambda system: Agent(Model(), [], system_prompt=system, max_steps=1),
        make_decider=None, timeout=30, on_event=lambda kind, data: events.append((kind, data)),
        stage=lambda folder: folder.mkdir(exist_ok=True),
    )
    assert order == ["model", "evaluate", "verify"]
    assert outcome.agent.stop_reason is StopReason.SUBMITTED
    assert outcome.output == {"value": "measured report"} and outcome.verdict.valid is valid
    assert next(data for kind, data in events if kind == "task.verdict")["valid"] is valid


@pytest.mark.parametrize("submission", [None, {"value": "wrong format"}])
async def test_no_valid_submission_never_runs_the_evaluator(tmp_path, monkeypatch, submission):
    manifest = evaluated_plugin(tmp_path / "plugin")

    class Model:
        async def query(self, messages, tools, **kwargs):
            calls = [] if submission is None else [ToolCall("invalid", "submit", json.dumps(submission))]
            return Reply("finished", calls)

    async def unexpected(*args, **kwargs):
        raise AssertionError("evaluation requires a valid submission")

    monkeypatch.setattr("nanoagent.plugin.tasks.call_tool_async", unexpected)
    with pytest.raises(RuntimeError, match="without calling submit"):
        await run_task(
            manifest, manifest.task("echo"), {"value": "request"}, tmp_path / "run",
            make_agent=lambda system: Agent(Model(), [], system_prompt=system, max_steps=1),
            make_decider=None, timeout=30, on_event=lambda *_: None,
            stage=lambda folder: folder.mkdir(exist_ok=True),
        )


async def test_evaluator_error_is_not_a_completed_or_verified_task(tmp_path, monkeypatch):
    manifest = evaluated_plugin(tmp_path / "plugin")
    events = []

    class Model:
        async def query(self, messages, tools, **kwargs):
            return Reply(None, [ToolCall("candidate", "submit", '{"source": "invalid C++"}')])

    async def evaluate(*args, **kwargs):
        raise RuntimeError("compiler error")

    monkeypatch.setattr("nanoagent.plugin.tasks.call_tool_async", evaluate)
    with pytest.raises(RuntimeError, match="compiler error"):
        await run_task(
            manifest, manifest.task("echo"), {"value": "request"}, tmp_path / "run",
            make_agent=lambda system: Agent(Model(), [], system_prompt=system),
            make_decider=None, timeout=30, on_event=lambda kind, _: events.append(kind),
            stage=lambda folder: folder.mkdir(exist_ok=True),
        )
    assert "task.result" not in events and "task.verdict" not in events


@pytest.mark.parametrize(
    ("edit", "message"),
    [
        (("evaluator: echo", "evaluator: unknown"), "not a declared tool"),
        (("tools: []", "tools: [echo]"), "must be outside its tools"),
        (("runner: agent", "runner: decide"), "requires an agent runner"),
    ],
)
def test_evaluator_configuration_is_checked_before_execution(tmp_path, edit, message):
    evaluated_plugin(tmp_path)
    path = tmp_path / "nanoagent.yaml"
    path.write_text(path.read_text().replace(*edit))
    with pytest.raises(PluginError, match=message):
        load_manifest(tmp_path)


def test_v0001_migrates_without_changing_its_task(tmp_path):
    from nanoagent.plugin.authoring import migrate

    write_plugin(tmp_path)
    manifest = migrate(tmp_path)
    assert manifest.spec == "nanoagent.plugin/v0002"
    assert manifest.task("echo").runner == "tool" and manifest.task("echo").evaluator is None


def test_contract_loads_are_serialized_across_specs(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    old = write_plugin(tmp_path / "old").parent
    new = evaluated_plugin(tmp_path / "new").root
    folders = [old, new] * 8
    with ThreadPoolExecutor(8) as pool:
        manifests = list(pool.map(load_manifest, folders))
    assert [manifest.root for manifest in manifests] == [folder.resolve() for folder in folders]


async def test_corrected_submission_runs_real_mcp_evaluator_and_restricted_verifier(tmp_path):
    manifest = evaluated_plugin(tmp_path / "plugin")

    class Model:
        calls = 0

        async def query(self, messages, tools, **kwargs):
            self.calls += 1
            assert self.calls <= 2
            arguments = '{"wrong": "format"}' if self.calls == 1 else '{"source": "actual source"}'
            return Reply(None, [ToolCall(f"submission-{self.calls}", "submit", arguments)])

    model = Model()
    outcome = await run_task(
        manifest, manifest.task("echo"), {"value": "request"}, tmp_path / "run",
        make_agent=lambda system: Agent(model, [], system_prompt=system, max_steps=2),
        make_decider=None, timeout=30, on_event=lambda *_: None,
        stage=lambda folder: folder.mkdir(exist_ok=True),
    )
    assert model.calls == 2 and outcome.agent.stop_reason is StopReason.SUBMITTED
    assert outcome.output == {"value": "actual source"} and outcome.verdict.valid
    assert (tmp_path / "run/echo.txt").read_text() == "actual source"
