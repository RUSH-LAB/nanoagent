"""Exercise the published wire schema and a source fixture with the real plugin verifier."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from importlib.resources import files
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator, ValidationError
from mockllm import MockProvider, NormalizedUsage, Scenario, Turn, Usage
from mockllm.engine import Stream

from nanoagent.plugin.manifest import load_manifest
from nanoagent.plugin.verifier import verify_task

ROOT = Path(__file__).resolve().parents[3]
# The wire schema ships with the package (nanoagent.uploaded); tests read that copy, never docs/.
SCHEMA = files("nanoagent.uploaded").joinpath("uploaded-harness-v1.schema.json")
PROBE = ROOT / "test" / "plugins" / "acceptance-probe"
PROTOCOL = "rush.harness.v1"
MODEL = "test/model"


def validator(shape: str) -> Draft202012Validator:
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    schema["$ref"] = f"#/$defs/{shape}"
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)


# The contract's published examples: a manifest and the two result envelopes.
EXAMPLE_MANIFEST = """\
protocol: rush.harness.v1
name: go-example
version: "1"
dialects: [chat_completions]
toolchain: go-1
lockfiles: [go.mod, go.sum]
build:
  argv: [go, build, -mod=vendor, -o, /build-out/harness, ./cmd/harness]
  outputs: [harness]
run:
  argv: [/harness/harness]
"""
EXAMPLE_RESULTS = (
    '{"protocol":"rush.harness.v1","status":"answered","answer":{"sum":42}}',
    '{"protocol":"rush.harness.v1","status":"refused","reason":"The required data is unavailable for this case."}',
)


def test_contract_examples_match_the_schema() -> None:
    validator("Manifest").validate(yaml.safe_load(EXAMPLE_MANIFEST))
    for result in EXAMPLE_RESULTS:
        validator("Result").validate(json.loads(result))


@pytest.mark.parametrize(
    "result",
    [
        {"status": "answered", "answer": []},
        {"status": "answered", "answer": {}, "reason": "both"},
        {"status": "answered", "answer": {}, "verdict": "pass"},
        {"status": "refused", "reason": "\t\n"},
        {"status": "refused", "reason": "none", "answer": {}},
        {"status": "error", "reason": "crash"},
    ],
)
def test_result_rejects_ambiguous_or_authoritative_payloads(result: dict) -> None:
    with pytest.raises(ValidationError):
        validator("Result").validate({"protocol": PROTOCOL, **result})


def test_harness_cannot_claim_trusted_trace_origin() -> None:
    event = {
        "protocol": PROTOCOL, "event": "span.start", "emitter_id": "main",
        "sequence": 1, "span_id": "root", "kind": "agent", "name": "Harness",
    }
    check = validator("HarnessEvent")
    check.validate(event)
    with pytest.raises(ValidationError):
        check.validate({**event, "origin": "openrouter"})


def test_tool_calls_include_both_ids_when_declaring_a_cause() -> None:
    call = {"name": "wait", "arguments": {"wait_seconds": 0}}
    check = validator("ToolCall")
    check.validate(call)
    check.validate({**call, "cause": {"model_call_id": "model-1", "tool_call_id": "call_0"}})
    with pytest.raises(ValidationError):
        check.validate({**call, "cause": {"tool_call_id": "call_0"}})

    result = validator("ToolResult")
    result.validate({"output": {"waited": 0}})
    result.validate({"error": {"code": "tool_denied", "message": "Tool is outside the case policy"}})
    with pytest.raises(ValidationError):
        result.validate({"output": {}, "error": {"code": "tool_denied", "message": "Denied"}})


def test_managed_command_distinguishes_exit_signal_and_timeout() -> None:
    call = {"argv": ["go", "test", "./pkg/config"], "cwd": ".", "timeout_ms": 5000}
    request = validator("ExecCall")
    request.validate(call)
    with pytest.raises(ValidationError):
        request.validate({**call, "timeout_ms": 0})

    streams = {
        "stdout": {"base64": "b2sK", "truncated": False},
        "stderr": {"base64": "", "truncated": True},
    }
    result = validator("ExecResult")
    for termination in (
        {"status": "exited", "exit_code": 23},
        {"status": "signaled", "signal": 9},
        {"status": "timed_out"},
    ):
        result.validate({**streams, "termination": termination})
    with pytest.raises(ValidationError):
        result.validate({**streams, "termination": {"status": "exited", "exit_code": 23, "signal": 9}})


@pytest.mark.acceptance
@pytest.mark.parametrize("override", [None, "Digest the supplied token. Preserve {literal}."], ids=["default", "edited"])
def test_uploaded_python_wire_contract_with_mock_provider_and_real_verifier(
    tmp_path: Path, probe_package: bytes, mock_provider: MockProvider, override: str | None,
) -> None:
    manifest = load_manifest(PROBE)
    task = manifest.task("probe")
    arguments = {"token": "café {literal}", "wait_seconds": 0.0}
    digest = hashlib.sha256(arguments["token"].encode()).hexdigest()[:12]
    scenario = Scenario(name="uploaded-wire", turns=[Turn(
        act={"answer": {"digest": "@digest"}}, stream=Stream(chunks=3), usage=Usage(prompt=51, completion=6),
    )])
    upstream = mock_provider.register(scenario, harness="nanoagent", model=MODEL, refs={"digest": digest})
    # A coding prompt in the shape of the plugin benchmark's template; production rendering belongs to the RUSH server (prompt.js).
    values = {
        "Task": task.description,
        "Instructions": task.instructions if override is None else override,
        "Case context": "Use the acceptance probe inputs.",
        "Input": json.dumps(arguments, ensure_ascii=False, sort_keys=True, indent=2),
        "Input schema": json.dumps(task.input, ensure_ascii=False, sort_keys=True, indent=2),
        "Output schema": json.dumps(task.output, ensure_ascii=False, sort_keys=True, indent=2),
        "Response guidance": "Provide an answer that follows the output schema. If the task cannot be answered, explain why.",
    }
    prompt = "\n\n".join(f"{heading}\n{value}" for heading, value in values.items()) + "\n"
    limits = {
        "wall_time_ms": 10000, "max_model_calls": 1, "max_output_tokens_per_call": 80, "max_cost_usd": 0.5, "internet_access": False, "cpus": 1,
        "memory_mb": 512, "pids": 128, "workspace_bytes": 1 << 20, "workspace_files": 100, "tmp_bytes": 1 << 20, "build_wall_ms": 60000, "build_memory_mb": 512,
        "build_output_bytes": 1 << 20, "build_files": 100, "build_tmp_bytes": 1 << 20,
    }
    request = {
        "protocol": PROTOCOL,
        "attempt_id": "8d95587d-b8aa-4d38-841b-38020be439da",
        "policy": "coding",
        "task": {"id": task.id, "kind": task.runner, "description": task.description, "instructions": task.instructions, "plugin_name": manifest.name},
        "case": {"case_id": "probe-01", "arguments": arguments, "context": "Use the acceptance probe inputs.", "input_schema": task.input, "output_schema": task.output},
        "prompt": {"system": None, "user": prompt, "sha256": hashlib.sha256(prompt.encode()).hexdigest()},
        "workspace": "/rush/workspace",
        "openrouter": {"base_url": upstream.base_url, "model": MODEL, "dialects": ["chat_completions"]},
        # A coding harness is given no tools.
        "tools": {"url": mock_provider.root + "/tools", "available": []},
        "exec_url": mock_provider.root + "/exec",
        "events_url": mock_provider.root + "/events",
        "limits": limits,
        "interactive": False,
    }
    validator("Request").validate(request)
    assert task.instructions and task.reference not in task.tools
    assert digest not in json.dumps(request)

    source = tmp_path / "harness.py"
    source.write_text('''\
import json
import os
import sys
from pathlib import Path

import openai

assert len(sys.argv) == 1
request = json.loads(Path(os.environ["RUSH_REQUEST"]).read_text(encoding="utf-8"))
router = request["openrouter"]
with openai.OpenAI(base_url=router["base_url"], api_key=os.environ["RUSH_ATTEMPT_TOKEN"], max_retries=0) as client:
    with client.chat.completions.stream(
        model=router["model"], messages=[{"role": "user", "content": request["prompt"]["user"]}],
        max_tokens=request["limits"]["max_output_tokens_per_call"], stream_options={"include_usage": True},
        tools=[{"type": "function", "function": {"name": "submit", "parameters": request["case"]["output_schema"]}}],
    ) as stream:
        [call] = stream.get_final_completion().choices[0].message.tool_calls
assert call.function.name == "submit"
result = Path(os.environ["RUSH_RESULT"])
staged = result.with_suffix(".tmp")
staged.write_text(json.dumps({
    "protocol": request["protocol"], "status": "answered", "answer": json.loads(call.function.arguments),
}), encoding="utf-8")
staged.replace(result)
''', encoding="utf-8")
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    result_path = tmp_path / "result.json"
    subprocess.run(
        [sys.executable, str(source)], cwd=tmp_path, check=True, timeout=10,
        env={
            "RUSH_REQUEST": str(request_path), "RUSH_RESULT": str(result_path),
            "RUSH_WORKSPACE": str(tmp_path), "RUSH_ATTEMPT_TOKEN": "test-attempt-token",
        },
    )
    result = json.loads(result_path.read_text(encoding="utf-8"))
    validator("Result").validate(result)
    assert verify_task(manifest, task.id, arguments, result["answer"], {"digest": digest}, tmp_path).valid
    upstream.ledger.assert_clean()
    [call] = upstream.ledger.main_calls
    assert call.request is not None
    assert call.request.messages == [{"role": "user", "content": prompt}]
    assert call.usage == NormalizedUsage(input=51, output=6)
