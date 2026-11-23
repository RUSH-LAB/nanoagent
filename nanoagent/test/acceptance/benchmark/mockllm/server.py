"""The HTTP side: a loopback ThreadingHTTPServer routing ``/r/<token>/api/v1/<endpoint>`` to a run's engine.

Strict by design: an unknown path, token or method, a script with no turns left, or an action the harness
has no tool for answers HTTP 599 and is logged as a protocol violation on the run's ledger (or on
``MockProvider.violations`` when no run is known).
"""

from __future__ import annotations

import json
import secrets
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import TracebackType
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .dialects import Dialect, Frames, all_dialects
from .engine import Call, Ledger, Lookup, ParsedRequest, Plan, Run, Scenario
from .harness import RENDERERS, dialect_of, harness_of

API = "api/v1"
MAX_COMPLETION_TOKENS = 64_000


@dataclass(frozen=True)
class RunHandle:
    token: str
    base_url: str  # OpenRouter's API root for this run: what `openrouter.base_url` is set to
    anthropic_base_url: str  # the same root without /v1: what Claude Code's ANTHROPIC_BASE_URL is set to
    ledger: Ledger
    scenario: Scenario


class Pool:
    """Several runs behind ONE base URL, for a batch that gives every run the same override. A request goes
    to the member whose ``key`` appears in its body: every request of a run replays the case's arguments, so
    the key (a case's token) is in all of them. A request matching no member, or several, is a violation."""

    def __init__(self, members: dict[str, Run]) -> None:
        self.members = members
        self.ledger = Ledger()  # unroutable requests (GET and the like) land here

    def select(self, raw: bytes) -> tuple[Run | None, str]:
        text = raw.decode("utf-8", errors="replace")
        matching = [key for key in self.members if key in text]
        if len(matching) != 1:
            return None, f"request matches pool members {matching}"
        return self.members[matching[0]], ""


class Router(Pool):
    """Every attempt of one worker behind ONE base URL, for a worker whose upstream is a single URL. A run is registered per
    ``(key, harness)``: ``key`` is a fragment of the case's prompt that no other case's request holds, ``harness`` the agent's name. A
    request goes to the run whose key its body holds and whose harness `harness_of` recognises in it; registering the pair again replaces
    its run (a new attempt of the same case with the same agent, after the previous one finished). A request that is no run's is a
    violation. A request with no tools (a side call: a title, a summary) has nothing to recognise the harness by, so it goes to the
    first run of the key whose harness speaks its dialect, and is answered as a side call."""

    def __init__(self, model: str, *models: str) -> None:
        super().__init__({})
        self.model = model
        self.models = [model, *models]  # what its `GET /models` lists

    def set(self, key: str, harness: str, scenario: Scenario, refs: dict[str, Any] | None = None) -> Run:
        run = Run(scenario, RENDERERS.get(harness, harness), self.model, refs)
        self.members[(key, harness)] = run  # type: ignore[index]
        return run

    def select_request(self, raw: bytes, request: ParsedRequest) -> tuple[Run | None, str]:
        text = raw.decode("utf-8", errors="replace")
        keyed = {harness: run for (key, harness), run in self.members.items() if key in text}  # type: ignore[misc]
        if not keyed:
            return None, "request holds no registered case key"
        if not request.tools:
            same = [harness for harness in keyed if dialect_of(harness) == request.dialect]
            return (keyed[same[0]], "") if same else (None, f"a side call in {request.dialect} matches no registered harness {sorted(keyed)}")
        harness = harness_of(request)
        if harness not in keyed:
            return None, f"request is {harness!r}'s, registered for this case: {sorted(keyed)}"
        return keyed[harness], ""


class MockProvider:
    def __init__(self) -> None:
        self._runs: dict[str, Run] = {}
        self._lock = threading.Lock()
        self.violations: list[str] = []
        self._dialects = all_dialects()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(self))
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def root(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def __enter__(self) -> MockProvider:
        self._thread.start()
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join()

    def register(self, scenario: Scenario, *, harness: str, model: str, refs: dict[str, Any] | None = None) -> RunHandle:
        """Start a run: ``refs`` fills the scenario's ``"@name"`` strings (e.g. the oracle's answer)."""
        token = secrets.token_hex(6)
        run = Run(scenario, harness, model, refs)
        with self._lock:
            self._runs[token] = run
        base = f"{self.root}/r/{token}/{API}"
        return RunHandle(token, base, f"{self.root}/r/{token}/api", run.ledger, scenario)

    def register_pool(self, members: dict[str, tuple[Scenario, dict[str, Any]]], *, harness: str, model: str) -> tuple[str, dict[str, RunHandle]]:
        """One base URL for several runs, told apart by ``key`` (see `Pool`): returns the base URL and each
        member's handle (its own ledger and scenario)."""
        token = secrets.token_hex(6)
        runs = {key: Run(scenario, harness, model, refs) for key, (scenario, refs) in members.items()}
        with self._lock:
            self._runs[token] = Pool(runs)  # type: ignore[assignment]
        base = f"{self.root}/r/{token}/{API}"
        return base, {key: RunHandle(token, base, f"{self.root}/r/{token}/api", run.ledger, run.scenario) for key, run in runs.items()}

    def register_router(self, model: str, *models: str) -> tuple[str, Router]:
        """One base URL for every attempt of a worker (see `Router`): its base URL and the router to `set` runs on."""
        token = secrets.token_hex(6)
        router = Router(model, *models)
        with self._lock:
            self._runs[token] = router  # type: ignore[assignment]
        return f"{self.root}/r/{token}/{API}", router

    def generation_route(self, path: str) -> tuple[Run | Pool | None, str]:
        """(run or pool, why not) for ``GET <root>/r/<token>/api/v1/generation``."""
        parts = path.split("/", 3)
        if len(parts) != 4 or parts[1] != "r" or parts[3] != f"{API}/generation":
            return None, f"unexpected GET {path}"
        with self._lock:
            run = self._runs.get(parts[2])
        return (run, "") if run is not None else (None, f"unknown run token in {path}")

    def _route(self, path: str) -> tuple[Run | None, Dialect | None, str]:
        """(run, dialect, why not) for a request path (query already stripped)."""
        parts = path.split("/", 3)  # ["", "r", token, rest]
        if len(parts) != 4 or parts[1] != "r":
            return None, None, f"unknown endpoint {path}"
        with self._lock:
            run = self._runs.get(parts[2])
        if run is None:
            return None, None, f"unknown run token in {path}"
        for suffix, dialect in self._dialects.items():
            if parts[3] == API + suffix:
                return run, dialect, ""
        return run, None, f"unknown endpoint {path}"


def without_usage(value: Any) -> Any:
    """``value`` (a response or stream event) with every ``usage`` member removed, as a provider that reports none sends it."""
    if isinstance(value, dict):
        return {key: without_usage(item) for key, item in value.items() if key != "usage"}
    if isinstance(value, list):
        return [without_usage(item) for item in value]
    return value


def without_usage_frame(frame: bytes) -> bytes:
    """One SSE frame without usage; a frame that is not JSON data (`[DONE]`) is kept."""
    lines = []
    for line in frame.decode().split("\n"):
        if line.startswith("data: ") and line != "data: [DONE]":
            line = "data: " + json.dumps(without_usage(json.loads(line[6:])))
        lines.append(line)
    return "\n".join(lines).encode()


def _handler(provider: MockProvider) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        # HTTP/1.0: a streamed body is delimited by closing the connection, so no chunked framing is needed.
        protocol_version = "HTTP/1.0"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass

        def do_GET(self) -> None:
            split = urlsplit(self.path)
            if self._models(split.path):
                return
            target, why = provider.generation_route(split.path)
            if target is None:
                run, _, _ = provider._route(split.path)
                self._violation(why if split.path.startswith("/r/") else f"unexpected {self.command} {self.path}", run)
                return
            self._generation(target, split)

        def _models(self, path: str) -> bool:
            """OpenRouter's model list (`GET /models`), which a worker reads at start for each priced model's own maximum output: the
            models of the run or router the URL names, each with ``MAX_COMPLETION_TOKENS``."""
            parts = path.split("/", 3)
            if len(parts) != 4 or parts[1] != "r" or parts[3] != f"{API}/models":
                return False
            with provider._lock:
                target = provider._runs.get(parts[2])
            if target is None:
                return False
            models = target.models if isinstance(target, Router) else [target.model]
            self._send_json(200, {"data": [{"id": model, "top_provider": {"max_completion_tokens": MAX_COMPLETION_TOKENS}} for model in models]})
            return True

        def do_PUT(self) -> None:
            run, _, _ = provider._route(self.path.split("?", 1)[0])
            self._violation(f"unexpected {self.command} {self.path}", run)

        do_DELETE = do_PATCH = do_PUT

        def _generation(self, target: Run | Pool, split: Any) -> None:
            """OpenRouter's generation lookup: 404 until the generation exists and its delay after completion has passed."""
            ids = parse_qs(split.query).get("id", [])
            runs = list(target.members.values()) if isinstance(target, Pool) else [target]
            if len(ids) != 1 or not self.headers.get("Authorization", "").startswith("Bearer "):
                self._violation(f"a generation lookup needs one id and a bearer key: {self.path}", runs[0])
                return
            data = next((found for run in runs if (found := run.generation(ids[0])) is not None), None)
            ledger = next((run.ledger for run in runs if ids[0] in run._generations), runs[0].ledger)
            status = 200 if data is not None else 404
            ledger.add_lookup(Lookup(ids[0], status, time.perf_counter()))
            self._send_json(status, {"data": data} if data is not None else {"error": {"message": f"Generation {ids[0]} not found", "code": 404}})

        def _send_json(self, status: int, payload: dict[str, Any], call: Call | None = None, generation_id: str | None = None) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            if generation_id is not None:
                self.send_header("x-generation-id", generation_id)
            self.end_headers()
            self.wfile.write(data)
            if call is not None:
                call.first_byte = call.last_byte = time.perf_counter()
                call.status = status

        def _violation(self, message: str, run: Run | None = None, call: Call | None = None) -> None:
            (run.ledger.violations if run else provider.violations).append(message)
            if call is not None:
                call.kind, call.status = "violation", 599
                call.first_byte = call.last_byte = time.perf_counter()
            try:
                body = json.dumps({"error": {"message": message, "type": "mock_protocol_violation"}}).encode()
                self.send_response(599)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except OSError:
                pass

        def do_POST(self) -> None:
            arrival = time.perf_counter()
            path = self.path.split("?", 1)[0]
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length)
            run, dialect, why = provider._route(path)
            if isinstance(run, Router):
                router, run = run, None
                try:
                    run, why = router.select_request(raw, dialect.parse(path, json.loads(raw), self.headers)) if dialect else (None, why)
                except (ValueError, KeyError, TypeError) as error:
                    run, why = None, f"unparseable request: {error!r}"
                if run is None:
                    self._violation(why, None)
                    return
            elif isinstance(run, Pool):
                pool, run = run, None
                run, why = pool.select(raw)
                if run is None:
                    self._violation(why)
                    return
            if run is None or dialect is None:
                self._violation(why, run)
                return
            call = Call(dialect.name, path, arrival)
            run.ledger.add(call)
            try:
                body = json.loads(raw)
                request = dialect.parse(path, body, self.headers)
            except (ValueError, KeyError, TypeError) as error:
                self._violation(f"unparseable {dialect.name} request: {error!r}", run, call)
                return
            call.request = request
            plan = run.plan(request)
            call.kind, call.turn_index = plan.kind, plan.turn_index
            try:
                self._answer(run, dialect, request, plan, call)
            except (BrokenPipeError, ConnectionResetError):
                call.aborted = True
                call.last_byte = time.perf_counter()

        def _answer(self, run: Run, dialect: Dialect, request: Any, plan: Plan, call: Call) -> None:
            if plan.kind == "violation":
                self._violation(plan.message, run, call)
                return
            if plan.kind == "error":
                assert plan.turn is not None
                time.sleep(plan.turn.ttfb)
                self._send_json(plan.status, dialect.error_body(plan.status, plan.message), call)
                return
            assert plan.reply is not None and plan.usage is not None
            turn = plan.turn
            reported = turn is None or turn.report_usage
            call.usage = dialect.normalized(plan.usage) if reported else None
            if turn is not None:
                time.sleep(turn.ttfb)
            generation_id = run.start_generation(request, plan.usage)
            if not request.stream:
                self._send_json(200, dialect.full(plan.reply, request.model, plan.usage) if reported else without_usage(dialect.full(plan.reply, request.model, plan.usage)), call, generation_id)
                if generation_id is not None:
                    run.finish_generation(generation_id)
                return
            chunks = max(turn.stream.chunks, 1) if turn else 1
            gap = turn.stream.gap if turn else 0.0
            frames = dialect.frames(plan.reply, request.model, plan.usage, chunks)
            if not reported:
                frames = Frames(*([without_usage_frame(frame) for frame in part] for part in (frames.head, frames.body, frames.tail)))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            if generation_id is not None:
                self.send_header("x-generation-id", generation_id)
            self.end_headers()
            self.wfile.write(b"".join(frames.head))
            self.wfile.flush()
            call.status = 200
            call.first_byte = time.perf_counter()
            size = -(-len(frames.body) // chunks) if frames.body else 1
            for n in range(chunks):
                time.sleep(gap)
                self.wfile.write(b"".join(frames.body[n * size : (n + 1) * size]))
                self.wfile.flush()
                if turn is not None and turn.cut is not None and n + 1 >= turn.cut:
                    call.last_byte = time.perf_counter()
                    if generation_id is not None:
                        run.finish_generation(generation_id)
                    return
            self.wfile.write(b"".join(frames.tail))
            self.wfile.flush()
            call.last_byte = time.perf_counter()
            if generation_id is not None:
                run.finish_generation(generation_id)

    return Handler
