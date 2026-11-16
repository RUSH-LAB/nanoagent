"""NanoAgent as the task tools uploaded harness (uploaded/reference_harnesses/nanoagent): schema-built types, the broker tools, and an attempt."""

import asyncio
import json
import os
import re
import subprocess
import sys
import threading
from pathlib import Path

import httpx
import pytest
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

HARNESS = Path(__file__).resolve().parents[1] / "src" / "nanoagent" / "uploaded" / "reference_harnesses" / "nanoagent"
sys.path.insert(0, str(HARNESS))
sys.path.insert(0, str(Path(__file__).parent))

from test_plugin import PLUGINS, _word_check  # noqa: E402

from nanoagent.plugin.dataflow import Answers, Question, fill, values  # noqa: E402
from nanoagent.plugin.runtime import PluginSession  # noqa: E402
from nanoagent.plugin.tasks import run_task  # noqa: E402
from taskharness.broker import Broker, BrokerTool, ToolSpec  # noqa: E402
from taskharness.schema_types import SchemaError, SchemaTypes, validator  # noqa: E402
from taskharness.work import work_decide  # noqa: E402

from assemble import assemble  # noqa: E402


def test_schema_types_intern_equal_definitions_and_ignore_the_outer_description() -> None:
    types = SchemaTypes()
    word = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False}
    assert types.build(word, "A") is types.build({**word, "description": "the field using it"}, "B")
    nullable = {"anyOf": [word, {"type": "null"}], "description": "maybe"}
    assert types.build(nullable, "C") is types.build(word, "D")
    assert types.build({"enum": ["a", "b"]}, "E") is not types.build({"enum": ["a", "c"]}, "F")


def test_schema_types_refuse_what_the_dataflow_cannot_fill() -> None:
    with pytest.raises(SchemaError, match="optional properties"):
        SchemaTypes().build({"type": "object", "properties": {"x": {"type": "string"}}}, "T")
    with pytest.raises(SchemaError, match="unsupported schema"):
        SchemaTypes().build({"type": "object", "properties": {"x": {"oneOf": []}}, "required": ["x"]}, "T")


def test_the_validator_names_the_first_violation() -> None:
    check = validator({"type": "object", "properties": {"n": {"type": "integer"}}, "required": ["n"], "additionalProperties": False})
    check({"n": 1})
    with pytest.raises(ValueError, match="n: 'x' is not of type 'integer'"):
        check({"n": "x"})
    with pytest.raises(ValueError, match="Additional properties"):
        check({"n": 1, "extra": 2})


class _Recorded:
    """A scripted decider that records each batch's questions without their texts (which name types)."""

    def __init__(self, answer) -> None:
        self.answer = answer
        self.batches: list[list[tuple]] = []

    async def decide(self, state, questions):
        self.batches.append([(q.id, q.kind, q.options, q.path) for q in questions])
        return Answers({q.id: self.answer(state, q) for q in questions})

    def record(self):
        return None


def _resolve(state, path: str):
    value = state
    for name, index in re.findall(r"\.?(\w+)|\[(\d+)\]", path):
        value = value[name] if name else value[int(index)]
    return value


def _answer_for(verdicts: dict):
    added: list[str] = []

    def answer(state, question):
        calls = state["calls"]
        if question.id == "next":
            return "read_words" if len(calls) < 2 else "submit"
        if question.id == "text":
            return "input.reference" if not calls else "input.raw"
        if question.id == "add":
            if len(added) == len(verdicts):
                return "done"
            added.append(list(verdicts)[len(added)])
            return "add"
        [word] = [word for word in calls[1]["output"]["words"] if word["text"] == added[-1]]
        label, closest, differs = verdicts[word["text"]]
        if question.id == "label":
            return label
        if question.id == "differs":
            return "null" if differs is None else "build"
        if question.id == "value":
            return differs[::-1]
        value = {"word": word["text"], "closest": closest, "error": word["error"]}[question.id]
        if value is None:
            return "null"
        [option] = [o for o in question.options if o != "null" and _resolve(state, o) == value]
        return option

    return answer


class _PluginBroker:
    """The broker's role locally: a plugin session behind `call`, as the broker keeps one per attempt."""

    def __init__(self, session: PluginSession) -> None:
        self.session = session

    async def call(self, name, arguments, *, tool_call_id=None):
        assert tool_call_id is None  # a decider's calls are the harness's own
        return await self.session.call(name, arguments)


async def test_a_decide_task_from_schemas_matches_run_task_on_a_real_plugin_task(tmp_path: Path) -> None:
    manifest, arguments = _word_check(tmp_path)
    task = manifest.task("check-words")
    verdicts = {
        "Cat": ("known", "Cat", None),
        "cat": ("changed", "Cat", ["first"]),
        "DOG": ("changed", "dog", ["first", "rest"]),
        "fish": ("new", None, None),
        "b1rd": ("unreadable", None, None),
    }
    typed = _Recorded(_answer_for(verdicts))
    outcome = await run_task(
        manifest,
        task,
        arguments,
        tmp_path,
        make_agent=None,
        make_decider=lambda _system: typed,
        timeout=120,
        on_event=lambda *_: None,
        stage=lambda _folder: None,
    )
    assert outcome.verdict.valid and outcome.verdict.score == 1.0

    schematic = _Recorded(_answer_for(verdicts))
    specs = [ToolSpec(t.name, t.description, t.input, t.output) for t in (manifest.tool(name) for name in task.tools)]
    async with PluginSession(manifest, tmp_path, timeout=120) as session:
        output = await work_decide(
            system="decide",
            arguments=arguments,
            input_schema=task.input,
            output_schema=task.output,
            tools=specs,
            broker=_PluginBroker(session),
            model=None,
            max_steps=50,
            spans=None,
            root_span=None,
            decider=schematic,
        )
    assert output == outcome.output
    assert schematic.batches == typed.batches


def test_the_values_a_schema_built_input_offers_match_the_plugins_types() -> None:
    from nanoagent.plugin.manifest import load_manifest

    manifest = load_manifest(PLUGINS / "word-check")
    task = manifest.task("check-words")
    types = SchemaTypes()
    arguments = {"reference": "a b", "raw": "c"}
    built = values(arguments, types.build(task.input, "Input"), "input")
    real = values(arguments, task.input_type, "input")
    assert [(path, value) for _, path, value in built] == [(path, value) for _, path, value in real]

    async def options(input_type, output_type):
        asked: list[list[Question]] = []

        async def ask(questions, forced):
            asked.append(questions)
            return {q.id: q.options[0] for q in questions}

        pool = values(arguments, input_type, "input")
        with pytest.raises(Exception):
            await fill(output_type, "output", pool, ask)
        return [[(q.id, q.kind, q.options, q.path) for q in batch] for batch in asked]

    built_options = asyncio.run(options(types.build(task.input, "Input"), types.build(task.output, "Output")))
    assert built_options == asyncio.run(options(task.input_type, task.output_type)) and built_options


def _transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_the_broker_sends_an_agents_call_with_its_cause_and_a_deciders_without() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = json.loads(request.content)
        if body["name"] == "bad":
            return httpx.Response(409, json={"error": {"code": "tool_mismatch", "message": "no"}})
        return httpx.Response(200, json={"output": {"value": 1, "images": [{"media_type": "image/png", "data": "AA=="}]}})

    from taskharness.broker import CURRENT_TOOL_CALL
    from taskharness.events import CURRENT_SPAN

    async with _transport(handler) as client:
        broker = Broker("http://broker/tools", "tok", client, {"tc1": "call-9"}.__getitem__)
        spec = ToolSpec("t", "does t", {"type": "object"}, {"type": "object"})
        CURRENT_TOOL_CALL.set("tc1")
        result = await BrokerTool(spec, broker).run(x=1)
        assert json.loads(result) == {"value": 1} and result.images == [{"media_type": "image/png", "data": "AA=="}]
        CURRENT_SPAN.set("s7")
        await broker.call("t", {"x": 2})
        with pytest.raises(RuntimeError, match="tool bad failed: tool_mismatch: no"):
            await broker.call("bad", {})
    first, second, _ = seen
    assert json.loads(first.content)["cause"] == {"model_call_id": "call-9", "tool_call_id": "tc1"}
    assert "x-rush-span-id" not in first.headers and first.headers["authorization"] == "Bearer tok"
    assert "cause" not in json.loads(second.content) and second.headers["x-rush-span-id"] == "s7"


class _Gateway:
    """The attempt's gateway, broker and events as one fake server; ``script`` answers each chat completion."""

    def __init__(self, script) -> None:
        self.script, self.chats, self.tools, self.events = script, [], [], []
        app = Starlette(routes=[Route("/api/v1/chat/completions", self.chat, methods=["POST"]), Route("/tools", self.tool, methods=["POST"]), Route("/events", self.event, methods=["POST"])])
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error"))

    async def chat(self, request: Request):
        body = await request.json()
        self.chats.append(body)
        message = self.script(len(self.chats), body)
        return JSONResponse(
            {"id": "x", "object": "chat.completion", "created": 0, "model": body["model"], "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", **message}}], "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}},
            headers={"X-Rush-Call-Id": f"call-{len(self.chats)}"},
        )

    async def tool(self, request: Request):
        body = await request.json()
        self.tools.append((body, request.headers.get("x-rush-span-id")))
        return JSONResponse({"output": {"text": body["arguments"]["text"].upper()}})

    async def event(self, request: Request):
        self.events.append(await request.json())
        return JSONResponse({"receipt": len(self.events)})

    def __enter__(self):
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        while not self.server.started:
            self.thread.join(0.02)
        self.port = self.server.servers[0].sockets[0].getsockname()[1]
        return self

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(10)


TEXT = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False}


def _request(gateway: _Gateway, kind: str, prompt: dict) -> dict:
    return {
        "protocol": "rush.harness.v1",
        "attempt_id": "a1",
        "policy": "task_tools",
        "task": {"id": "shout", "kind": kind, "description": "Shout", "instructions": "Loudly", "plugin_name": "Shouter"},
        "case": {"case_id": "c-01", "arguments": {"text": "hi"}, "context": "", "input_schema": TEXT, "output_schema": TEXT},
        "prompt": {**prompt, "sha256": "0" * 64},
        "workspace": "/rush/workspace",
        "openrouter": {"base_url": f"http://127.0.0.1:{gateway.port}/api/v1", "model": "m/x", "dialects": ["chat_completions"]},
        "tools": {"url": f"http://127.0.0.1:{gateway.port}/tools", "available": [{"name": "shout", "description": "Upper-cases", "input_schema": TEXT, "output_schema": TEXT}]},
        "exec_url": "http://127.0.0.1:1/exec",
        "events_url": f"http://127.0.0.1:{gateway.port}/events",
        "limits": {"wall_time_ms": 600000, "max_model_calls": 8, "max_output_tokens_per_call": 512, "max_cost_usd": 1.5},
    }


def _attempt(tmp_path: Path, assembled: Path, request: dict) -> dict:
    (tmp_path / "request.json").write_text(json.dumps(request))
    env = {
        **os.environ,
        "RUSH_REQUEST": str(tmp_path / "request.json"),
        "RUSH_RESULT": str(tmp_path / "result.json"),
        "RUSH_ATTEMPT_TOKEN": "secret",
    }
    done = subprocess.run([os.environ.get("HARNESS_PYTHON", sys.executable), str(assembled / "main.py")], env=env, capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr
    return json.loads((tmp_path / "result.json").read_text())


def _tool_call(name: str, arguments: dict, call_id: str) -> dict:
    return {"content": None, "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}]}


def test_an_agent_attempt_uses_the_prompt_verbatim_and_sends_tool_calls_with_their_cause(tmp_path: Path) -> None:
    def script(count, body):
        return _tool_call("shout", {"text": "hi"}, "tc-a") if count == 1 else _tool_call("submit", {"text": "HI"}, "tc-b")

    with _Gateway(script) as gateway:
        assembled = assemble(tmp_path / "upload")
        result = _attempt(tmp_path, assembled, _request(gateway, "agent", {"system": "SYSTEM TEXT", "user": "USER TEXT"}))
    assert result == {"protocol": "rush.harness.v1", "status": "answered", "answer": {"text": "HI"}}
    first = gateway.chats[0]["messages"]
    assert [(m["role"], m["content"]) for m in first] == [("system", "SYSTEM TEXT"), ("user", "USER TEXT")]
    assert "provider" not in json.dumps(gateway.chats[0]) and gateway.chats[0].get("max_tokens", gateway.chats[0].get("max_completion_tokens")) == 512
    [(call, span)] = gateway.tools
    assert call == {"name": "shout", "arguments": {"text": "hi"}, "cause": {"model_call_id": "call-1", "tool_call_id": "tc-a"}}
    assert [e["event"] for e in gateway.events] == ["span.start", "span.end"] and gateway.events[0]["kind"] == "agent"
    assert span == gateway.events[0]["span_id"]
    assert [e["sequence"] for e in gateway.events] == [1, 2]


def test_an_agent_that_ends_with_text_and_no_submission_refuses(tmp_path: Path) -> None:
    with _Gateway(lambda count, body: {"content": "  cannot be answered  "}) as gateway:
        result = _attempt(tmp_path, assemble(tmp_path / "upload"), _request(gateway, "tool", {"system": "S", "user": "U"}))
    assert result == {"protocol": "rush.harness.v1", "status": "refused", "reason": "cannot be answered"}


def test_a_decide_attempt_sends_its_calls_under_a_decision_span_and_asks_for_required_parameters(tmp_path: Path) -> None:
    def script(count, body):
        assert [m["role"] for m in body["messages"]] == ["system", "user"] and body["messages"][0]["content"] == "DECIDE SYSTEM"
        properties = body["response_format"]["json_schema"]["schema"]["properties"]
        if "next" in properties:
            return {"content": json.dumps({"next": "shout" if "\"tool\": \"shout\"" not in body["messages"][1]["content"] else "submit"})}
        return {"content": json.dumps({"text": "input.text"})}

    with _Gateway(script) as gateway:
        result = _attempt(tmp_path, assemble(tmp_path / "upload"), _request(gateway, "decide", {"system": "DECIDE SYSTEM", "user": None}))
    assert result == {"protocol": "rush.harness.v1", "status": "answered", "answer": {"text": "hi"}}
    assert gateway.chats[0]["response_format"]["type"] == "json_schema"
    assert gateway.chats[0]["provider"] == {"require_parameters": True}
    [(call, span)] = gateway.tools
    assert call == {"name": "shout", "arguments": {"text": "hi"}}
    starts = {e["span_id"]: e for e in gateway.events if e["event"] == "span.start"}
    root = next(e["span_id"] for e in starts.values() if e["kind"] == "agent")
    assert starts[span]["kind"] == "decision" and starts[span]["parent_span_id"] == root
    ended = [e["span_id"] for e in gateway.events if e["event"] == "span.end"]
    assert sorted(ended) == sorted(starts) and ended[-1] == root
