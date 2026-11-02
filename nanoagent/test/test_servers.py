"""vLLM and SGLang, the engines that serve a model from a server of one's own, as NanoAgent providers.

``Engine`` is a fake of each engine's OpenAI-compatible server, answering and refusing as the real
ones do (recorded from vLLM 0.32 on vllm-metal and SGLang from source on its MLX runtime, both
serving Qwen3-1.7B): vLLM sends a reply's reasoning as ``reasoning`` and counts it in
``completion_tokens_details``, refuses tools it was not started to parse (400) and a model it does
not serve (404); SGLang sends ``reasoning_content`` and counts it in ``usage.reasoning_tokens``,
answers a tool call as text when it has no tool-call parser, answers any model name with its own,
says which parser it runs at ``/server_info``, and ends with ``finish_reason: abort`` an answer its
sampler cannot hold to a schema. Both refuse a wrong key with 401 ``{"error": "Unauthorized"}``.

With ``NANOAGENT_TEST_VLLM`` or ``NANOAGENT_TEST_SGLANG`` set to ``<its /v1 address>,<key or
nothing>,<model>``, the tests marked live run against that real server too.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import openai
import pytest
from starlette.testclient import TestClient

from nanoagent.harness.choice import RunModel
from nanoagent.harness.registry import loop_model
from nanoagent.inference.config import LeanInferConfig
from nanoagent.inference.providers import PROVIDERS, MissingKeyError, MissingServerError, build_provider
from nanoagent.llm.server import NO_THINKING, ServerConfig
from nanoagent.plugin import install
from nanoagent.plugin.package import pack
from nanoagent.runtime.config import load_config_args, parse_kv_list
from nanoagent.web.app import create_app, is_server_url
from nanoagent.web.config import WebConfig
from test_plugin import write_plugin

ROOT = Path(__file__).resolve().parents[1]
ENGINES = ("vllm", "sglang")
VARIABLES = {"vllm": ("VLLM_BASE_URL", "VLLM_API_KEY"), "sglang": ("SGLANG_BASE_URL", "SGLANG_API_KEY")}
TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "The weather in a city.",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}
SCHEMA = {"type": "object", "properties": {"next": {"type": "string", "enum": ["a", "b"]}}, "required": ["next"]}


def _pieces(text: str | None) -> list[str]:
    """``text`` in the few-character fragments a stream sends it in."""
    return [text[index : index + 3] for index in range(0, len(text), 3)] if text else []


class Engine:
    """A fake of ``kind``'s server (see the module docstring) serving ``model`` at ``url`` until
    closed. Each chat completion answers with the next of ``turns`` (``{"content": "ok"}`` once
    they run out): ``content`` and ``reasoning`` text, a ``tool`` call ``(name, arguments)``, and the
    ``finish`` reason. ``failures`` chat completions are answered 503 first, as an engine starting up."""

    def __init__(self, kind: str, model: str, *, key: str | None = None, tool_parser: bool = True) -> None:
        self.kind, self.model, self.key, self.tool_parser = kind, model, key, tool_parser
        self.turns: list[dict[str, Any]] = []
        self.requests: list[dict[str, Any]] = []
        self.failures = 0
        engine = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: object) -> None:
                pass

            def do_GET(self) -> None:
                engine._get(self)

            def do_POST(self) -> None:
                engine._post(self)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self._server.server_port}/v1"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    @staticmethod
    def _send(handler: BaseHTTPRequestHandler, status: int, body: bytes, content_type: str = "application/json") -> None:
        handler.send_response(status)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    def _json(self, handler: BaseHTTPRequestHandler, status: int, value: Any) -> None:
        self._send(handler, status, json.dumps(value).encode())

    def _error(self, handler: BaseHTTPRequestHandler, status: int, message: str, kind: str) -> None:
        error = {"message": message, "type": kind, "param": None, "code": status}
        self._json(handler, status, {"error": error} if self.kind == "vllm" else {"object": "error", **error})

    def _authorized(self, handler: BaseHTTPRequestHandler) -> bool:
        if self.key is None or handler.headers.get("Authorization") == f"Bearer {self.key}":
            return True
        self._json(handler, 401, {"error": "Unauthorized"})
        return False

    def _get(self, handler: BaseHTTPRequestHandler) -> None:
        if not self._authorized(handler):
            return
        if handler.path == "/v1/models":
            entry = {"id": self.model, "object": "model", "owned_by": self.kind, "root": self.model, "parent": None, "max_model_len": 16384}
            self._json(handler, 200, {"object": "list", "data": [entry]})
        elif handler.path == "/server_info" and self.kind == "sglang":
            self._json(handler, 200, {"tool_call_parser": "qwen" if self.tool_parser else None, "reasoning_parser": "qwen3"})
        else:
            self._json(handler, 404, {"detail": "Not Found"})

    def _post(self, handler: BaseHTTPRequestHandler) -> None:
        body = json.loads(handler.rfile.read(int(handler.headers["Content-Length"])))
        self.requests.append({"path": handler.path, "authorization": handler.headers.get("Authorization"), "body": body})
        if not self._authorized(handler):
            return
        if handler.path != "/v1/chat/completions":
            return self._json(handler, 404, {"detail": "Not Found"})
        if self.failures:
            self.failures -= 1
            return self._error(handler, 503, "the engine is starting", "ServiceUnavailableError")
        if self.kind == "vllm" and body["model"] != self.model:
            return self._error(handler, 404, f"The model `{body['model']}` does not exist. Valid aliases: {self.model}.", "NotFoundError")
        if self.kind == "vllm" and body.get("tools") and not self.tool_parser:
            message = '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set'
            return self._error(handler, 400, message, "BadRequestError")
        turn = self.turns.pop(0) if self.turns else {"content": "ok"}
        content, reasoning, tool = turn.get("content"), turn.get("reasoning"), turn.get("tool")
        if tool and not self.tool_parser:
            # An engine that parses no tool calls (SGLang without --tool-call-parser) answers one as text.
            name, arguments = tool
            content, tool = f"<tool_call>\n{json.dumps({'name': name, 'arguments': json.loads(arguments)})}\n</tool_call>", None
        finish = turn.get("finish") or ("tool_calls" if tool else "stop")
        field = "reasoning" if self.kind == "vllm" else "reasoning_content"
        thought = len(_pieces(reasoning))
        usage: dict[str, Any] = {"prompt_tokens": 11, "completion_tokens": 7 + thought, "total_tokens": 18 + thought}
        if self.kind == "vllm":
            usage["completion_tokens_details"] = {"reasoning_tokens": thought}
        else:
            usage["reasoning_tokens"] = thought
        call_id = "chatcmpl-tool-9e01" if self.kind == "vllm" else "call_4aa3"
        base = {"id": "chatcmpl-1", "created": 0, "model": body["model"]}
        if not body.get("stream"):
            message = {"role": "assistant", "content": content, field: reasoning}
            if tool:
                message["tool_calls"] = [{"id": call_id, "type": "function", "function": {"name": tool[0], "arguments": tool[1]}}]
            choice = {"index": 0, "message": message, "finish_reason": finish}
            return self._json(handler, 200, {**base, "object": "chat.completion", "choices": [choice], "usage": usage})
        deltas: list[dict[str, Any]] = [{"role": "assistant", "content": ""}]
        deltas += [{field: piece} for piece in _pieces(reasoning)]
        deltas += [{"content": piece} for piece in _pieces(content)]
        if tool:
            name, arguments = tool
            if self.kind == "vllm":
                calls = [{"id": call_id, "type": "function", "index": 0, "function": {"name": name}}]
                calls += [{"index": 0, "function": {"arguments": piece}} for piece in _pieces(arguments)]
            else:
                calls = [{"id": call_id, "index": 0, "type": "function", "function": {"name": name, "arguments": ""}}]
                calls += [{"id": None, "index": 0, "type": "function", "function": {"name": None, "arguments": piece}} for piece in _pieces(arguments)]
            deltas += [{"content": None, "tool_calls": [call]} for call in calls]
        chunks = [{"index": 0, "delta": delta, "finish_reason": None} for delta in deltas] + [{"index": 0, "delta": {}, "finish_reason": finish}]
        events = [{**base, "object": "chat.completion.chunk", "choices": [chunk]} for chunk in chunks]
        if (body.get("stream_options") or {}).get("include_usage"):
            events.append({**base, "object": "chat.completion.chunk", "choices": [], "usage": usage})
        stream = "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"
        self._send(handler, 200, stream.encode(), "text/event-stream")


@pytest.fixture(params=ENGINES)
def engine(request: pytest.FixtureRequest) -> Engine:
    served = Engine(request.param, "org/model-1b", key="engine-key")
    yield served
    served.close()


def _backend(engine: Engine, monkeypatch: pytest.MonkeyPatch, **config: Any):
    url, key = VARIABLES[engine.kind]
    monkeypatch.setenv(url, engine.url)
    monkeypatch.setenv(key, engine.key or "")
    return build_provider(LeanInferConfig(provider=engine.kind, model=engine.model, retry_base_delay=0.0, **config))


def test_the_engines_are_providers_of_their_own() -> None:
    assert PROVIDERS == ("sglang", "vllm", "openrouter", "bedrock")
    with pytest.raises(ValueError, match="choose from sglang, vllm, openrouter, bedrock"):
        build_provider(LeanInferConfig(provider="tgi", model="m"))


@pytest.mark.parametrize("kind", ENGINES)
def test_an_engine_without_a_server_says_which_to_set(kind: str, monkeypatch: pytest.MonkeyPatch) -> None:
    url, _ = VARIABLES[kind]
    monkeypatch.delenv(url, raising=False)
    name = {"vllm": "vLLM", "sglang": "SGLang"}[kind]
    with pytest.raises(MissingServerError, match=rf"No {name} server is set \({url}\): add one to run org/m") as raised:
        build_provider(LeanInferConfig(provider=kind, model="org/m"))
    # The web host and the loop refuse it as they refuse a missing key.
    assert isinstance(raised.value, MissingKeyError)
    monkeypatch.setenv(url, "127.0.0.1:8000/v1")
    with pytest.raises(ValueError, match=rf"{url} must start with http:// or https://"):
        build_provider(LeanInferConfig(provider=kind, model="org/m"))


async def test_an_engine_is_reached_at_its_variables_address_with_its_key(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    backend = _backend(engine, monkeypatch)
    try:
        reply = await backend.generate([{"role": "user", "content": "hi"}])
    finally:
        await backend.aclose()
    assert reply.text == "ok"
    [request] = engine.requests
    assert request["path"] == "/v1/chat/completions" and request["authorization"] == "Bearer engine-key"
    # Only what the config sets is sent: no OpenRouter routing, temperature 0.0.
    assert request["body"] == {"model": "org/model-1b", "messages": [{"role": "user", "content": "hi"}], "temperature": 0.0}


async def test_a_config_names_its_server_over_the_variables(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    url, key = VARIABLES[engine.kind]
    monkeypatch.setenv(url, "http://127.0.0.1:9/v1")
    monkeypatch.setenv(key, "not-this-one")
    backend = build_provider(LeanInferConfig(provider=engine.kind, model=engine.model, base_url=engine.url, api_key="engine-key"))
    try:
        assert (await backend.generate([{"role": "user", "content": "hi"}])).text == "ok"
    finally:
        await backend.aclose()
    assert engine.requests[0]["authorization"] == "Bearer engine-key"


@pytest.mark.parametrize("stream", [False, True])
async def test_a_reply_keeps_its_reasoning_apart_from_its_answer(engine: Engine, monkeypatch: pytest.MonkeyPatch, stream: bool) -> None:
    engine.turns = [{"reasoning": "Seventeen threes.", "content": "51"}]
    deltas: list[tuple[str, str]] = []
    backend = _backend(engine, monkeypatch)
    try:
        reply = await backend.generate(
            [{"role": "user", "content": "17 * 3?"}], on_delta=(lambda kind, text: deltas.append((kind, text))) if stream else None
        )
    finally:
        await backend.aclose()
    assert (reply.text, reply.reasoning, reply.finish_reason) == ("51", "Seventeen threes.", "stop")
    # vLLM counts the reasoning in completion_tokens_details, SGLang in usage itself: both are read.
    assert reply.usage["reasoning_tokens"] == 6 and reply.usage["total_tokens"] == 24
    if stream:
        assert [kind for kind, _ in deltas] == ["reasoning"] * 6 + ["content"]
        assert "".join(text for kind, text in deltas if kind == "reasoning") == "Seventeen threes."
        assert engine.requests[0]["body"]["stream_options"] == {"include_usage": True}


@pytest.mark.parametrize("stream", [False, True])
async def test_a_tool_call_comes_back_whole(engine: Engine, monkeypatch: pytest.MonkeyPatch, stream: bool) -> None:
    engine.turns = [{"reasoning": "Use the tool.", "tool": ("get_weather", '{"city": "Paris"}')}]
    backend = _backend(engine, monkeypatch)
    try:
        reply = await backend.generate(
            [{"role": "user", "content": "Weather in Paris?"}], tools=[TOOL], on_delta=(lambda *_: None) if stream else None
        )
    finally:
        await backend.aclose()
    [call] = reply.tool_calls
    assert (call.name, json.loads(call.arguments), reply.finish_reason) == ("get_weather", {"city": "Paris"}, "tool_calls")
    assert call.id.startswith("chatcmpl-tool-" if engine.kind == "vllm" else "call_")
    assert engine.requests[0]["body"]["tools"] == [TOOL]


async def test_an_answer_is_held_to_its_schema(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    engine.turns = [{"reasoning": "b it is.", "content": '{"next": "b"}'}]
    backend = _backend(engine, monkeypatch)
    try:
        answer = await backend.answer([{"role": "user", "content": "pick b"}], name="decide", schema=SCHEMA)
    finally:
        await backend.aclose()
    assert answer.value == {"next": "b"} and answer.cost == 0.0
    sent = engine.requests[0]["body"]
    assert sent["response_format"] == {"type": "json_schema", "json_schema": {"name": "decide", "schema": SCHEMA, "strict": True}}
    # OpenRouter's provider routing is OpenRouter's alone.
    assert "provider" not in sent


async def test_an_answer_the_server_stopped_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    # SGLang's Apple Silicon runtime cannot hold its sampler to a schema, and ends the reply.
    engine = Engine("sglang", "org/model-1b")
    engine.turns = [{"content": '{\n  "option_b', "finish": "abort"}]
    backend = _backend(engine, monkeypatch)
    try:
        with pytest.raises(ValueError, match="the server stopped its answer to 'decide' before it was done"):
            await backend.answer([{"role": "user", "content": "pick b"}], name="decide", schema=SCHEMA)
    finally:
        await backend.aclose()
        engine.close()


async def test_a_wrong_key_fails_at_once(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    backend = _backend(engine, monkeypatch, max_retries=3)
    # The server was started again with another key.
    engine.key = "the-servers-key"
    try:
        with pytest.raises(openai.AuthenticationError, match="Unauthorized"):
            await backend.generate([{"role": "user", "content": "hi"}])
    finally:
        await backend.aclose()
    assert len(engine.requests) == 1


async def test_an_engine_starting_up_is_waited_for(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    engine.failures = 2
    backend = _backend(engine, monkeypatch, max_retries=2)
    try:
        assert (await backend.generate([{"role": "user", "content": "hi"}])).text == "ok"
    finally:
        await backend.aclose()
    assert len(engine.requests) == 3


async def test_vllm_refuses_tools_it_was_not_started_to_call_and_models_it_does_not_serve(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = Engine("vllm", "org/model-1b", tool_parser=False)
    backend = _backend(engine, monkeypatch, max_retries=3)
    try:
        with pytest.raises(openai.BadRequestError, match="--enable-auto-tool-choice and --tool-call-parser"):
            await backend.generate([{"role": "user", "content": "Weather?"}], tools=[TOOL])
        other = build_provider(LeanInferConfig(provider="vllm", model="org/other", max_retries=3))
        try:
            with pytest.raises(openai.NotFoundError, match="The model `org/other` does not exist"):
                await other.generate([{"role": "user", "content": "hi"}])
        finally:
            await other.aclose()
    finally:
        await backend.aclose()
        engine.close()
    # Neither is tried again.
    assert len(engine.requests) == 2


async def test_sglang_without_a_tool_parser_answers_a_call_as_text(monkeypatch: pytest.MonkeyPatch) -> None:
    # Why the web host refuses apps on such a server (test_an_app_needs_a_server_that_parses_tool_calls).
    engine = Engine("sglang", "org/model-1b", tool_parser=False)
    engine.turns = [{"tool": ("get_weather", '{"city": "Paris"}')}]
    backend = _backend(engine, monkeypatch)
    try:
        reply = await backend.generate([{"role": "user", "content": "Weather?"}], tools=[TOOL])
    finally:
        await backend.aclose()
        engine.close()
    assert reply.tool_calls == [] and reply.text.startswith("<tool_call>")


@pytest.mark.parametrize(
    ("value", "valid"),
    [
        ("http://127.0.0.1:8000/v1", True),
        ("https://gpu.lab.example/sglang/v1", True),
        ("http://[::1]:8000/v1", True),
        ("127.0.0.1:8000/v1", False),
        ("ftp://host/v1", False),
        ("http:///v1", False),
        ("http://user:secret@host/v1", False),
        ("http://host/v1?key=secret", False),
        ("http://host/v1?", False),
        ("http://host/v1#top", False),
        ("http://host:99999/v1", False),
    ],
)
def test_a_server_address_names_a_server_and_nothing_secret(value: str, valid: bool) -> None:
    assert is_server_url(value) is valid


# Stands in for js/pi-runner: index.js answers with the options of its envelope, models.js prints
# the catalog in $FAKE_CATALOG, as the PI runner lists a server's models each time it is asked.
RUNNER = """
import json, sys
envelope = json.loads(sys.stdin.readline())
print(json.dumps({"type": "done", "answer": json.dumps(envelope["options"]), "stop_reason": "answer",
                  "steps": 1, "usage": {}, "cost": 0.0, "error": None}))
"""
LISTER = "import os, pathlib, sys; sys.stdout.write(pathlib.Path(os.environ['FAKE_CATALOG']).read_text())"
DEEPSEEK = {
    "provider": "openrouter",
    "id": "deepseek/deepseek-v4-flash-0731",
    "name": "DeepSeek",
    "contextWindow": 1000,
    "maxTokens": 100,
    "reasoning": False,
    "cost": {"input": 0.05, "output": 0.2},
}


def _catalog(path: Path, servers: dict[str, dict[str, Any]]) -> None:
    """Write the catalog the fake PI runner lists: OpenRouter's model, and each server engine as
    ``servers`` says (``baseUrl``, ``error``, ``tools``, its ``models``), unset when not named."""
    providers = [{"id": "openrouter", "name": "OpenRouter", "keySet": True}]
    models = [DEEPSEEK]
    for kind, name in (("vllm", "vLLM"), ("sglang", "SGLang")):
        server = servers.get(kind)
        providers.append(
            {
                "id": kind,
                "name": name,
                "keySet": server is not None,
                "baseUrl": server and server["baseUrl"],
                "error": server and server.get("error"),
                "tools": server and server.get("tools"),
            }
        )
        models += [
            {"provider": kind, "id": model, "name": model, "contextWindow": 16384, "maxTokens": 16384, "reasoning": None, "cost": {"input": 0, "output": 0}}
            for model in (server or {}).get("models", [])
        ]
    path.write_text(json.dumps({"providers": providers, "models": models}))


def _web(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """A member's own NanoAgent (run_models), its default profile on the fake PI runner, with the echo plugin installed."""
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    # PUT /v1/keys sets the servers' variables in this process's environment itself: set and removed
    # here first, so that the test's end removes whatever it set too.
    for name in [name for pair in VARIABLES.values() for name in pair]:
        monkeypatch.setenv(name, "")
        monkeypatch.delenv(name)
    monkeypatch.setenv("FAKE_CATALOG", str(tmp_path / "catalog.json"))
    _catalog(tmp_path / "catalog.json", {})
    runner = tmp_path / "pi"
    runner.mkdir()
    (runner / "index.js").write_text(RUNNER)
    (runner / "models.js").write_text(LISTER)
    profile = tmp_path / "pi-fake.yaml"
    profile.write_text(
        "_ > nanoagent.runtime.config.HarnessProfileConfig:\n"
        "label: Fake · PI\n"
        "model: deepseek/deepseek-v4-flash-0731\n"
        "harness > nanoagent.runtime.config.HarnessConfig:\n"
        "  type: pi\n"
        f"  command: [{sys.executable}, {runner / 'index.js'}]\n"
        "  cwd: null\n"
        "  options: [provider=openrouter, api_key_env=OPENROUTER_API_KEY, thinking_level=off]\n"
        "model_overrides > nanoagent.runtime.config.ModelPart:\n"
    )
    # The echo plugin runs on this Python, so it has nothing to sync.
    monkeypatch.setattr(install, "SYNC", ("true",))
    config = load_config_args(
        WebConfig,
        [
            "web_cfg=deploy/railway/nanoagent.yaml",
            f"profiles=[{profile}]",
            "default_profile=pi-fake",
            "packages=[]",
            f"workspaces={tmp_path / 'workspaces'}",
            f"installs={tmp_path / 'installs'}",
            f"uv_cache={tmp_path / 'uv-cache'}",
            f"plugin_python={sys.executable}",
            "host=127.0.0.1",
            "api_token=null",
            "sandbox=none",
            "run_models=true",
        ],
    )
    client = TestClient(create_app(config))
    write_plugin(tmp_path / "echo")
    data = pack(tmp_path / "echo")
    client.sha = hashlib.sha256(data).hexdigest()
    assert client.put(f"/v1/installs/{client.sha}", content=data).status_code == 200
    client.catalog = tmp_path / "catalog.json"
    return client


def _events(response) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def test_a_members_nanoagent_keeps_a_servers_address_as_it_keeps_a_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _web(tmp_path, monkeypatch)
    changes = {"VLLM_BASE_URL": "http://127.0.0.1:8000/v1", "VLLM_API_KEY": "k", "SGLANG_BASE_URL": "https://gpu.example/v1"}
    assert client.put("/v1/keys", json={"changes": changes}).json() == {"keys": sorted(changes)}
    assert os.environ["VLLM_BASE_URL"] == "http://127.0.0.1:8000/v1" and os.environ["SGLANG_BASE_URL"] == "https://gpu.example/v1"
    assert client.put("/v1/keys", json={"changes": {"SGLANG_BASE_URL": None}}).status_code == 200
    assert "SGLANG_BASE_URL" not in os.environ
    for changes in (
        {"VLLM_BASE_URL": "127.0.0.1:8000/v1"},
        {"VLLM_BASE_URL": "http://user:secret@host/v1"},
        {"SGLANG_BASE_URL": "http://host/v1?key=secret"},
        {"SGLANG_BASE_URL": "http://host/ v1"},
        # Only the engines' own: an SDK's base URL would send its key elsewhere.
        {"OPENAI_BASE_URL": "http://127.0.0.1:8000/v1"},
    ):
        assert client.put("/v1/keys", json={"changes": changes}).status_code == 400, changes
    assert os.environ["VLLM_BASE_URL"] == "http://127.0.0.1:8000/v1"


def test_the_models_a_server_serves_are_listed_as_it_serves_them(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _web(tmp_path, monkeypatch)
    _catalog(client.catalog, {"vllm": {"baseUrl": "http://gpu:8000/v1", "models": ["org/a"]}})
    first = client.get("/v1/models").json()
    assert [(model["provider"], model["id"], model["apps"]) for model in first["models"]] == [
        ("openrouter", "deepseek/deepseek-v4-flash-0731", True),
        ("vllm", "org/a", True),
    ]
    # The server is started again with another model: the next listing has it.
    _catalog(client.catalog, {"vllm": {"baseUrl": "http://gpu:8000/v1", "models": ["org/b"]}, "sglang": {"baseUrl": "http://gpu:30000/v1", "models": ["org/c"], "tools": False}})
    second = client.get("/v1/models").json()
    assert [(model["id"], model["apps"]) for model in second["models"][1:]] == [("org/b", True), ("org/c", False)]
    assert [provider["keySet"] for provider in second["providers"]] == [True, True, True]


def test_a_chat_runs_on_the_model_a_server_serves(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _web(tmp_path, monkeypatch)
    _catalog(client.catalog, {"vllm": {"baseUrl": "http://gpu:8000/v1", "models": ["org/a"]}})
    [*_, done] = _events(client.post("/v1/runs", json={"input": "x", "model": {"provider": "vllm", "model": "org/a"}}))
    assert done["model"] == "org/a"
    options = json.loads(done["answer"])
    # The profile's OpenRouter key does not go with the server's model.
    assert options["provider"] == "vllm" and options["model"] == "org/a" and "api_key_env" not in options


def test_a_model_a_server_has_started_serving_since_is_listed_before_it_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _web(tmp_path, monkeypatch)
    _catalog(client.catalog, {"vllm": {"baseUrl": "http://gpu:8000/v1", "models": ["org/a"]}})
    assert client.get("/v1/models").status_code == 200
    _catalog(client.catalog, {"vllm": {"baseUrl": "http://gpu:8000/v1", "models": ["org/b"]}})
    [*_, done] = _events(client.post("/v1/runs", json={"input": "x", "model": {"provider": "vllm", "model": "org/b"}}))
    assert done["model"] == "org/b"


@pytest.mark.parametrize(
    ("servers", "error"),
    [
        ({}, r"No vLLM server is set \(VLLM_BASE_URL\): add one to run org/z"),
        ({"vllm": {"baseUrl": "http://gpu:8000/v1", "error": "Could not reach the vLLM server at http://gpu:8000/v1: ECONNREFUSED"}}, "ECONNREFUSED"),
        ({"vllm": {"baseUrl": "http://gpu:8000/v1", "models": ["org/a"]}}, "The vLLM server at http://gpu:8000/v1 does not serve org/z; it serves org/a"),
    ],
)
def test_a_model_no_server_serves_says_why(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, servers: dict, error: str) -> None:
    client = _web(tmp_path, monkeypatch)
    _catalog(client.catalog, servers)
    refused = client.post("/v1/runs", json={"input": "x", "model": {"provider": "vllm", "model": "org/z"}})
    assert refused.status_code == 400 and re.search(error, refused.json()["error"]), refused.json()


def _app_turns(engine: Engine) -> None:
    engine.turns = [{"reasoning": "Echo it.", "tool": ("echo", '{"value": "hi"}')}, {"content": "I echoed hi."}]


@pytest.mark.parametrize("kind", ENGINES)
def test_an_app_runs_on_the_model_a_server_serves(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str) -> None:
    client = _web(tmp_path, monkeypatch)
    engine = Engine(kind, "org/model-1b", key="engine-key")
    try:
        url, key = VARIABLES[kind]
        assert client.put("/v1/keys", json={"changes": {url: engine.url, key: "engine-key"}}).status_code == 200
        _catalog(client.catalog, {kind: {"baseUrl": engine.url, "models": [engine.model], "tools": True}})
        _app_turns(engine)
        events = _events(client.post(f"/v1/workspaces/alice/installs/{client.sha}/runs", json={"input": "echo hi", "model": {"provider": kind, "model": engine.model}}))
    finally:
        engine.close()
    [tool] = [event for event in events if event["type"] == "tool"]
    assert tool["name"] == "echo" and not tool["is_error"] and json.loads(tool["output"])["verdict"]["valid"] is True
    done = events[-1]
    assert done["type"] == "done" and done["answer"] == "I echoed hi." and done["model"] == engine.model
    # A server of one's own costs nothing; the loop still counts its tokens, reasoning included.
    assert done["cost"] == 0.0 and done["usage"]["reasoning_tokens"] == 3
    # Both requests went to the server, as the model it serves, with the app's tool and the server's key,
    # asking a template that thinks by default (Qwen3's) not to, as the loop runs every model.
    assert [request["body"]["model"] for request in engine.requests] == [engine.model] * 2
    assert {request["authorization"] for request in engine.requests} == {"Bearer engine-key"}
    assert "echo" in {tool["function"]["name"] for tool in engine.requests[0]["body"]["tools"]}
    assert [request["body"]["chat_template_kwargs"] for request in engine.requests] == [{"enable_thinking": False}] * 2
    assert (tmp_path / "workspaces" / "alice" / "echo.txt").read_text() == "hi"


def test_the_loop_runs_a_servers_model_without_thinking_unless_its_config_says_how(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(ROOT)
    monkeypatch.setenv("NANOAGENT_API_TOKEN", "t")
    cfg = load_config_args(WebConfig, ["web_cfg=deploy/railway/nanoagent.yaml"])
    served, _ = loop_model(cfg, None, model=RunModel("vllm", "org/m"), prices=(0.0, 0.0))
    # Its server is the one VLLM_BASE_URL names when the loop builds it.
    assert (served.provider, served.model, served.base_url, served.extra_body) == ("vllm", "org/m", None, [NO_THINKING])
    assert parse_kv_list(served.extra_body) == {"chat_template_kwargs": {"enable_thinking": False}}
    told = replace(cfg, model=replace(cfg.model, extra_body=['chat_template_kwargs={"enable_thinking": true}']))
    assert loop_model(told, None, model=RunModel("sglang", "org/m"), prices=(0.0, 0.0))[0].extra_body == told.model.extra_body
    assert loop_model(cfg, None, model=RunModel("openrouter", "a/b"), prices=(1.0, 2.0))[0].extra_body == []


def test_a_plugins_agent_task_runs_on_a_server_of_ones_own_as_an_app_does() -> None:
    llm = ServerConfig(engine="sglang", model="org/m", base_url=None, max_tokens=512, temperature=None, max_attempts=3, read_timeout=60.0)
    model = llm.runtime()
    assert (model.provider, model.model, model.base_url, model.api_key, model.max_retries) == ("sglang", "org/m", None, None, 2)
    assert (model.extra_body, model.input_price, model.output_price) == ([NO_THINKING], 0.0, 0.0)
    with pytest.raises(ValueError, match="Server engine must be vllm or sglang, got 'tgi'"):
        ServerConfig(engine="tgi", model="m", base_url=None, max_tokens=None, temperature=None, max_attempts=1, read_timeout=60.0)


def test_an_app_needs_a_server_that_parses_tool_calls(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _web(tmp_path, monkeypatch)
    _catalog(client.catalog, {"sglang": {"baseUrl": "http://gpu:30000/v1", "models": ["org/c"], "tools": False}})
    refused = client.post(f"/v1/workspaces/alice/installs/{client.sha}/runs", json={"input": "x", "model": {"provider": "sglang", "model": "org/c"}})
    assert refused.status_code == 400
    assert refused.json()["error"] == "The SGLang server at http://gpu:30000/v1 parses no tool calls, which apps need: start it with --tool-call-parser"
    # It still chats: PI calls no tools.
    assert _events(client.post("/v1/runs", json={"input": "x", "model": {"provider": "sglang", "model": "org/c"}}))[-1]["type"] == "done"


def test_an_app_runs_on_the_server_as_it_serves_now(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _web(tmp_path, monkeypatch)
    engine = Engine("sglang", "org/model-1b", key="engine-key")
    path = f"/v1/workspaces/alice/installs/{client.sha}/runs"
    run = {"input": "echo hi", "model": {"provider": "sglang", "model": engine.model}}
    served = {"baseUrl": engine.url, "models": [engine.model]}
    try:
        assert client.put("/v1/keys", json={"changes": {"SGLANG_BASE_URL": engine.url, "SGLANG_API_KEY": "engine-key"}}).status_code == 200
        # Listed while it parsed no tool calls, then started again with --tool-call-parser: the app runs.
        _catalog(client.catalog, {"sglang": {**served, "tools": False}})
        assert client.get("/v1/models").status_code == 200
        _catalog(client.catalog, {"sglang": {**served, "tools": True}})
        _app_turns(engine)
        assert _events(client.post(path, json=run))[-1]["type"] == "done"
        # Started again without it, or serving another model, which SGLang would answer the app's name with.
        _catalog(client.catalog, {"sglang": {**served, "tools": False}})
        assert "parses no tool calls" in client.post(path, json=run).json()["error"]
        _catalog(client.catalog, {"sglang": {**served, "models": ["org/other"], "tools": True}})
        refused = client.post(path, json=run)
        assert refused.status_code == 400
        assert refused.json()["error"] == f"The SGLang server at {engine.url} does not serve org/model-1b; it serves org/other"
    finally:
        engine.close()
    assert len(engine.requests) == 2


def test_an_app_moves_to_the_server_set_since(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _web(tmp_path, monkeypatch)
    first, second = Engine("vllm", "org/model-1b"), Engine("vllm", "org/model-1b")
    try:
        run = {"input": "echo hi", "model": {"provider": "vllm", "model": "org/model-1b"}}
        for engine in (first, second):
            assert client.put("/v1/keys", json={"changes": {"VLLM_BASE_URL": engine.url}}).status_code == 200
            _catalog(client.catalog, {"vllm": {"baseUrl": engine.url, "models": [engine.model]}})
            _app_turns(engine)
            assert _events(client.post(f"/v1/workspaces/alice/installs/{client.sha}/runs", json=run))[-1]["type"] == "done"
    finally:
        first.close()
        second.close()
    assert len(first.requests) == 2 and len(second.requests) == 2


def _live(kind: str) -> tuple[str, str | None, str]:
    """The real server ``NANOAGENT_TEST_<KIND>`` names, or a skip."""
    value = os.environ.get(f"NANOAGENT_TEST_{kind.upper()}")
    if not value:
        pytest.skip(f"NANOAGENT_TEST_{kind.upper()} names no {kind} server")
    url, key, model = value.split(",", 2)
    return url, key or None, model


@pytest.mark.parametrize("kind", ENGINES)
async def test_live_a_server_chats_streams_and_calls_tools(kind: str) -> None:
    url, key, model = _live(kind)
    backend = build_provider(LeanInferConfig(provider=kind, model=model, base_url=url, api_key=key, max_tokens=2000, max_retries=0))
    try:
        reply = await backend.generate([{"role": "user", "content": "What is 17 times 3? Answer with the number only."}])
        assert "51" in reply.text and reply.usage["completion_tokens"] > 0
        deltas: list[str] = []
        streamed = await backend.generate([{"role": "user", "content": "Count to three."}], on_delta=lambda kind, _text: deltas.append(kind))
        assert streamed.text and "content" in deltas and streamed.usage["total_tokens"] > 0
        for on_delta in (None, lambda *_: None):
            called = await backend.generate([{"role": "user", "content": "What is the weather in Paris? Use the tool."}], tools=[TOOL], on_delta=on_delta)
            [call] = called.tool_calls
            assert call.name == "get_weather" and json.loads(call.arguments)["city"] == "Paris"
    finally:
        await backend.aclose()


@pytest.mark.parametrize("kind", ENGINES)
async def test_live_a_wrong_key_is_refused(kind: str) -> None:
    url, key, model = _live(kind)
    if key is None:
        pytest.skip(f"the {kind} server takes any key")
    backend = build_provider(LeanInferConfig(provider=kind, model=model, base_url=url, api_key="not-its-key", max_retries=0))
    try:
        with pytest.raises(openai.AuthenticationError):
            await backend.generate([{"role": "user", "content": "hi"}])
    finally:
        await backend.aclose()
