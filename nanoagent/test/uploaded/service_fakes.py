"""In-memory doubles and builders for the attempt-scoped service tests."""

from __future__ import annotations

import json
import threading
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

import anyio
import httpx

from nanoagent.uploaded.attempt import AttemptPolicy, ToolPolicy
from nanoagent.uploaded.broker import ToolError
from nanoagent.uploaded.endpoint import EndpointProfile
from nanoagent.uploaded.evidence import EvidenceEvent, sha256_hex
from nanoagent.uploaded.app import AttemptServices
from nanoagent.uploaded.gateway import AdmissionDenied, UpstreamError, UpstreamRequest

TOKEN = "attempt-token-0123456789"
UPSTREAM_KEY = "sk-upstream-secret-42"
MODEL = "test/model"
PROMPT = "Task\nsum the numbers\n"
ORDER: list[str] = []


class FakeJournal:
    def __init__(self) -> None:
        self.events: list[EvidenceEvent] = []
        self.payloads: dict[str, tuple[bytes, str]] = {}
        self._lock = threading.Lock()

    async def append(self, event: EvidenceEvent) -> None:
        self.events.append(event)

    async def put_payload(self, data: bytes, redaction: str) -> str:
        sha = sha256_hex(data)
        self.payloads[sha] = (data, redaction)
        return sha

    def of(self, kind: str) -> list[EvidenceEvent]:
        return [event for event in self.events if event.kind == kind]

    def kinds(self) -> list[str]:
        return [event.kind for event in self.events]

    def body(self, sha: str) -> bytes:
        return self.payloads[sha][0]


class FakeAdmission:
    def __init__(self, deny: str | None = None) -> None:
        self.deny = deny
        self.reserved: dict[str, Decimal] = {}
        self.settled: dict[str, tuple[Decimal | None, str]] = {}
        self.uncertain: list[str] = []

    async def reserve(self, call_id: str, bound_usd: Decimal) -> None:
        if self.deny:
            raise AdmissionDenied(self.deny)
        ORDER.append(f"reserve:{call_id}")
        self.reserved[call_id] = bound_usd

    async def settle(self, call_id: str, cost_usd: Decimal | None, provenance: str) -> None:
        self.settled[call_id] = (cost_usd, provenance)

    async def mark_uncertain(self, call_id: str) -> None:
        self.uncertain.append(call_id)


@dataclass
class Scripted:
    status: int = 200
    headers: Mapping[str, str] = field(default_factory=lambda: {"content-type": "application/json"})
    chunks: Sequence[bytes] = ()
    send_error: UpstreamError | None = None
    cut: UpstreamError | None = None  # raised after the chunks
    hold: anyio.Event | None = None  # the stream waits for this before its last chunk


class _Response:
    def __init__(self, script: Scripted) -> None:
        self.script = script
        self.status = script.status
        self.headers = {name.lower(): value for name, value in script.headers.items()}
        self.closed = False

    async def chunks(self) -> AsyncIterator[bytes]:
        chunks = list(self.script.chunks)
        for index, chunk in enumerate(chunks):
            if self.script.hold is not None and index == len(chunks) - 1:
                await self.script.hold.wait()
            yield chunk
        if self.script.cut is not None:
            raise self.script.cut

    async def aclose(self) -> None:
        self.closed = True


class ScriptedTransport:
    """Serves queued scripts in order and keeps every request it was sent."""

    def __init__(self, *scripts: Scripted) -> None:
        self.scripts = list(scripts)
        self.requests: list[UpstreamRequest] = []
        self.responses: list[_Response] = []

    async def send(self, request: UpstreamRequest) -> _Response:
        ORDER.append("dispatch")
        self.requests.append(request)
        script = self.scripts.pop(0)
        if script.send_error:
            raise script.send_error
        response = _Response(script)
        self.responses.append(response)
        return response

    def body(self, index: int = -1) -> dict[str, Any]:
        return json.loads(self.requests[index].body)


class FakeToolRunner:
    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay
        self.active_writers = 0
        self.active_readers = 0
        self.max_readers = 0
        self.overlaps = 0
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail: ToolError | None = None
        self.output: dict[str, Any] | None = None

    async def run(self, name: str, arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
        self.calls.append((name, arguments))
        writer = name == "write"
        if writer and (self.active_writers or self.active_readers) or (not writer and self.active_writers):
            self.overlaps += 1
        if writer:
            self.active_writers += 1
        else:
            self.active_readers += 1
            self.max_readers = max(self.max_readers, self.active_readers)
        try:
            await anyio.sleep(self.delay)
        finally:
            if writer:
                self.active_writers -= 1
            else:
                self.active_readers -= 1
        if self.fail:
            raise self.fail
        return self.output if self.output is not None else {"ok": True, "echo": arguments}


class FakeCommandRunner:
    def __init__(self) -> None:
        self.calls: list[tuple[list[str], str, int, str | None]] = []
        self.result: dict[str, Any] = {"termination": {"status": "exited", "exit_code": 0}, "stdout": {"base64": "aGk=", "truncated": False}, "stderr": {"base64": "", "truncated": False}}
        self.launch_id = "launch-1"
        self.error: Exception | None = None

    async def exec(self, argv: Sequence[str], cwd: str, timeout_ms: int, span_id: str | None) -> tuple[dict[str, Any], str]:
        self.calls.append((list(argv), cwd, timeout_ms, span_id))
        if self.error:
            raise self.error
        return self.result, self.launch_id


TOOLS = (
    ToolPolicy("read", False, {"type": "object", "properties": {"n": {"type": "number"}}, "required": ["n"], "additionalProperties": False}, {"type": "object", "required": ["ok"]}, "Read the n-th entry."),
    ToolPolicy("write", True, {"type": "object"}, {"type": "object", "required": ["ok"]}, "Write the workspace."),
)


def make_policy(**overrides: Any) -> AttemptPolicy:
    fields: dict[str, Any] = {
        "attempt_id": "11111111-1111-4111-8111-111111111111",
        "token": TOKEN,
        "model": MODEL,
        "dialects": ("chat_completions", "responses", "anthropic_messages"),
        "prompt_user": PROMPT,
        "prompt_system": None,
        "max_model_calls": 10,
        "max_output_tokens_per_call": 1000,
        "input_price_bound": Decimal("0.000001"),
        "output_price_bound": Decimal("0.000004"),
        "provider": {"order": ["fixed-provider"]},
        "tools": TOOLS,
    }
    fields.update(overrides)
    return AttemptPolicy(**fields)


def make_endpoint(base_url: str = "http://mock.test/api/v1", label: str = "mock-a") -> EndpointProfile:
    return EndpointProfile(label, "mock", base_url, "MOCK_KEY", ("mock.test", "127.0.0.1"), UPSTREAM_KEY)


class _FlushedTransport(httpx.AsyncBaseTransport):
    """The services' ASGI app, with the evidence a request recorded written to the journal before its response is returned.

    The recorder journals in the background (never on a request's path); a test that reads the journal right after a
    response needs everything that response's request recorded to be there."""

    def __init__(self, services: AttemptServices) -> None:
        self._services = services
        self._asgi = httpx.ASGITransport(app=services.app)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self._asgi.handle_async_request(request)
        await self._services.flush()
        return response


@dataclass
class Rig:
    services: AttemptServices
    journal: FakeJournal
    admission: FakeAdmission
    transport: Any
    tools: FakeToolRunner
    commands: FakeCommandRunner
    workspace: Path
    clock: list[int]

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=_FlushedTransport(self.services), base_url="http://svc.test", headers={"authorization": f"Bearer {TOKEN}"})


def make_rig(tmp_path: Path, transport: Any = None, *, policy: AttemptPolicy | None = None, admission: FakeAdmission | None = None, endpoint: EndpointProfile | None = None, **kwargs: Any) -> Rig:
    journal, admission = FakeJournal(), admission or FakeAdmission()
    tools, commands = FakeToolRunner(), FakeCommandRunner()
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    clock = [0]

    def tick() -> int:
        clock[0] += 1000
        return clock[0]

    services = AttemptServices(
        policy=policy or make_policy(),
        endpoint=endpoint or make_endpoint(),
        admission=admission,
        journal=journal,
        tool_runner=tools,
        command_runner=commands,
        workspace=workspace,
        transport=transport,
        clock_ns=tick,
        **kwargs,
    )
    return Rig(services, journal, admission, transport, tools, commands, workspace, clock)


# ---- wire builders ---------------------------------------------------------------------------------------------------


def chat_request(prompt: str = PROMPT, **extra: Any) -> dict[str, Any]:
    return {"model": MODEL, "messages": [{"role": "user", "content": prompt}], **extra}


def responses_request(prompt: str = PROMPT, **extra: Any) -> dict[str, Any]:
    return {"model": MODEL, "input": prompt, **extra}


def anthropic_request(prompt: str = PROMPT, **extra: Any) -> dict[str, Any]:
    return {"model": MODEL, "max_tokens": 100, "messages": [{"role": "user", "content": prompt}], **extra}


REQUESTS = {"chat_completions": chat_request, "responses": responses_request, "anthropic_messages": anthropic_request}
PATHS = {"chat_completions": "/api/v1/chat/completions", "responses": "/api/v1/responses", "anthropic_messages": "/api/v1/messages"}


def chat_body(tool_calls: Sequence[tuple[str, str, dict[str, Any]]] = (), *, cost: float | None = 0.0001, status: str = "stop") -> bytes:
    calls = [{"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}} for call_id, name, args in tool_calls]
    usage: dict[str, Any] = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    if cost is not None:
        usage["cost"] = cost
    message: dict[str, Any] = {"role": "assistant", "content": "hi", **({"tool_calls": calls} if calls else {})}
    return json.dumps({"id": "gen-abc", "model": MODEL, "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if calls else status}], "usage": usage}).encode()


def chat_ok(*tool_calls: tuple[str, str, dict[str, Any]], cost: float | None = 0.0001) -> Scripted:
    return Scripted(chunks=[chat_body(tool_calls, cost=cost)], headers={"content-type": "application/json", "x-generation-id": "gen-abc"})


def sse(data: Any) -> bytes:
    return f"data: {data if isinstance(data, str) else json.dumps(data)}\n\n".encode()


def chat_stream_chunks(*, cost: float | None = 0.0002, with_done: bool = True) -> list[bytes]:
    def chunk(delta: dict[str, Any], finish: str | None = None) -> bytes:
        return sse({"id": "gen-s", "model": MODEL, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})

    frames = [
        chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": "call_a", "type": "function", "function": {"name": "read", "arguments": ""}}]}),
        chunk({"tool_calls": [{"index": 0, "function": {"arguments": '{"n":'}}]}),
        chunk({"tool_calls": [{"index": 0, "function": {"arguments": " 1}"}}]}, "tool_calls"),
        sse({"id": "gen-s", "model": MODEL, "choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 5, **({"cost": cost} if cost is not None else {})}}),
    ]
    return frames + ([sse("[DONE]")] if with_done else [])


def stream_script(chunks: Sequence[bytes] | None = None, **kwargs: Any) -> Scripted:
    return Scripted(headers={"content-type": "text/event-stream", "x-generation-id": "gen-s"}, chunks=chunks or chat_stream_chunks(), **kwargs)


async def propose(client: httpx.AsyncClient, rig: Rig, tool: str, arguments: dict[str, Any], call_id: str = "call_1") -> tuple[str, str]:
    """Run a non-streaming chat call whose response proposes ``tool``; returns (model_call_id, tool_call_id)."""
    rig.transport.scripts.append(chat_ok((call_id, tool, arguments)))
    response = await client.post(PATHS["chat_completions"], json=chat_request())
    assert response.status_code == 200, response.text
    return response.headers["x-rush-call-id"], call_id


# ---- a real server over loopback -------------------------------------------------------------------------------------


class LoopbackServer:
    """Runs an ASGI app under uvicorn in a thread on a free loopback port."""

    def __init__(self, app: Any) -> None:
        import uvicorn

        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="on"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self) -> LoopbackServer:
        import time

        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started:
            assert time.monotonic() < deadline, "uvicorn did not start"
            time.sleep(0.01)
        self.port = self.server.servers[0].sockets[0].getsockname()[1]
        return self

    def __exit__(self, *exc: object) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"
