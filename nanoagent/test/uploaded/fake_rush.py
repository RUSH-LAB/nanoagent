"""An in-process fake of the RUSH member benchmark API (docs/contracts/rush-benchmark-api.md), served by uvicorn on a
free loopback port, with just the behavior the client and the CLI steps depend on: benchmark publishing under the naming rules
(identical republish, `benchmark_name_taken`), the member's own run summaries (never another member's), idempotent run creation by
harness name with one attempt per case, a paginated event log and an SSE stream that drops its first connection, payloads (one
corrupted), and accounting."""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import tarfile
import threading
import time
from typing import Any

import uvicorn
from rush_rules import CASE_FIELDS, REMOVED_FIELDS, Invalid, check_publication, check_run  # noqa: F401
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

WORKSPACE = "ws-1"
TOKEN = "fake-session-token"
ATTEMPT = "attempt-1"
PAYLOAD = b"payload bytes"
PAYLOAD_SHA = hashlib.sha256(PAYLOAD).hexdigest()
BAD_PAYLOAD_SHA = hashlib.sha256(b"what the digest names").hexdigest()
USER = {"id": "user-1", "name": "Una", "github": "una"}
DIGEST = "d" * 64



def fixtures_archive() -> dict[str, Any]:
    """A case's fixtures as a publication gives them: a gzipped tar of one file, with the digests the server checks."""
    data = b"id,name\n1,a\n"
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tar:
        info = tarfile.TarInfo("inputs/a.csv")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    archive = gzip.compress(buffer.getvalue(), mtime=0)
    return {"sha256": hashlib.sha256(archive).hexdigest(), "files": {"inputs/a.csv": hashlib.sha256(data).hexdigest()}, "archive": base64.b64encode(archive).decode()}


def publication(**changes: Any) -> dict[str, Any]:
    """The body of POST /api/benchmark/benchmarks as the server takes it (interfaces file, "Publish body"): the one every test publishes from."""
    return {
        "name": "probe",
        "plugin_id": "p",
        "plugin_name": "P",
        "version": "1.0.0",
        "package_sha256": "a" * 64,
        "task_id": "t",
        "task": {"kind": "agent", "description": "d", "input_schema": {}, "output_schema": {}, "tools": [], "egress_hosts": []},
        "cases": [{"case_id": "c1", "kind": "answer", "prompt": "p", "arguments": {}, "fixtures": fixtures_archive(), "expected_error": None}],
        "private": {"c1": None},
        "limits": {},
        **changes,
    }


# What the worker records beside the model call: the answer it read from the frozen workspace, then the workspace diff.
EVENT_DATA = {
    1: ("gateway", "model_call", {}),
    2: ("worker", "result.read", {"outcome": {"status": "answered", "answer": {"digest": "abc"}}}),
    3: ("worker", "snapshot.taken", {"diff": [{"path": "answer.json", "change": "added", "size": 20}], "diff_truncated": False}),
}


def events() -> list[dict[str, Any]]:
    return [
        {
            "cursor": cursor,
            "event_id": f"e{cursor}",
            "source": EVENT_DATA[cursor][0],
            "kind": EVENT_DATA[cursor][1],
            "sequence": cursor,
            "occurred_ns": "1700000000123456789",
            "data": EVENT_DATA[cursor][2],
            "payload_sha256s": [PAYLOAD_SHA],
            "received_at": "2026-01-01T00:00:00Z",
        }
        for cursor in (1, 2, 3)
    ]


def metric(total: int, missing: int = 0) -> dict[str, int]:
    return {"total": total, "missing_attempts": missing}


def make_attempt(run_id: str, case_id: str, attempt_id: str, verdict: str = "pass") -> dict[str, Any]:
    return {
        "attempt_id": attempt_id,
        "run_id": run_id,
        "case_id": case_id,
        "attempt_no": 1,
        "rerun_of": None,
        "state": "final",
        "execution": {"status": "answered", "reason": None},
        "verdict": verdict,
        "explanation": None if verdict == "pass" else "invalid_answer",
        "verifier_error": None,
        "checks": [{"name": "outcome_exists", "status": "passed"}, {"name": "values_match", "status": "passed" if verdict == "pass" else "failed"}],
        "coverage": {"status": "complete"},
        "metrics": {"total_tokens": 30, "elapsed_ms": 1500},
        "sealed": True,
        "final_cursor": 3,
        "high_water_cursor": 3,
    }


def make_run(
    run_id: str,
    benchmark: dict[str, Any] | None = None,
    harness: dict[str, Any] | None = None,
    attempts: dict[str, tuple[str, str]] | None = None,
) -> dict[str, Any]:
    """A finished run; ``attempts`` maps each case id it took to its attempt id and verdict (default: case c1, attempt-1, pass)."""
    attempts = attempts or {"c1": (ATTEMPT, "pass")}
    total = 30 * len(attempts)
    passed = sum(1 for _, verdict in attempts.values() if verdict == "pass")
    metrics = {
        "total_tokens": metric(total),
        "input_tokens": metric(20 * len(attempts), 1),
        "output_tokens": metric(10 * len(attempts)),
        "cache_read_tokens": metric(0),
        "cache_write_tokens": metric(0),
        "elapsed_ms": metric(1500 * len(attempts)),
    }
    benchmark = benchmark or {"benchmark_id": "bench-0", "name": "probe"}
    harness = harness or {"name": "claude"}  # a run names its harness by agent name alone
    return {
        "run_id": run_id,
        "status": "complete",
        "benchmark": {"benchmark_id": benchmark["benchmark_id"], "name": benchmark["name"]},
        "harness": harness,
        "model": "mock/model",
        "endpoint_profile": "mock",
        "case_set": {
            "case_set_id": "cs-1",
            "name": "probe",
            "digest": DIGEST,
            "publisher": {},
            "plugin": {"id": "p", "name": "P", "version": "1.0.0", "sha256": "pkg"},
            "task_id": "t",
            "task": {},
        },
        "limits": {"wall_time_ms": 600000, "max_model_calls": 50, "internet_access": True},
        "metrics": metrics,
        "score": {
            "value": passed / len(attempts),
            "passed": passed,
            "scored": len(attempts),
            "total": len(attempts),
            "unscored": 0,
            "verifier_errors": 0,
            "complete": True,
            "unavailable_reason": None,
        },  # fmt: skip
        "cases": [
            {"case_id": case, "kind": "answer", "content_digest": "cd1", "prompt": "u", "attempts": [make_attempt(run_id, case, attempt_id, verdict)]}
            for case, (attempt_id, verdict) in attempts.items()
        ],
    }


def summary(run: dict[str, Any], user: dict[str, Any] = USER) -> dict[str, Any]:
    """A run as `GET /runs` lists it: nothing but the run summary's fields."""
    plugin = run["case_set"]["plugin"]
    return {
        "run_id": run["run_id"],
        "harness": {"name": run["harness"]["name"]},
        "benchmark": {"name": run["benchmark"]["name"]},
        "plugin": {"id": plugin["id"], "name": plugin["name"], "version": plugin["version"]},
        "model": run["model"],
        "user": user,
        "metrics": {"total_tokens": run["metrics"]["total_tokens"], "elapsed_ms": run["metrics"]["elapsed_ms"]},
        "status": run["status"],
        "score": run["score"],
        "created_at": "2026-01-01T00:00:00Z",
    }


class FakeRush:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str]] = []
        self.bodies: list[Any] = []
        self.runs: dict[str, dict[str, Any]] = {}
        self.keys: dict[str, tuple[Any, str]] = {}
        self.compares: list[dict[str, str]] = []
        self.comparison: dict[str, Any] = {
            "config": [], "prompt_diff": {"text": [], "rendered": []}, "shared": [], "only_a": [], "only_b": [],
            "unverified_egress": {"a": False, "b": False},
        }  # fmt: skip
        self.attempt_comparison: dict[str, Any] = {}
        self.attempt_compares: list[dict[str, str]] = []
        self.connections = 0
        # (plugin_id, version, name) -> the publication and the benchmark summary the server made of it.
        self.publications: dict[tuple[str, str, str], tuple[dict[str, Any], dict[str, Any]]] = {}
        # The verdict each (harness, case) attempt gets from a run created through the API; pass otherwise.
        self.verdicts: dict[tuple[str, str], str] = {}
        # An attempt's settled cost by id; 0.25 otherwise.
        self.costs: dict[str, float | None] = {}
        # The calls of unknown cost each attempt's accounting reports (0 otherwise).
        self.uncertain: dict[str, int] = {}
        # Runs a member made before the test: an attempt's run, and the two runs a comparison names.
        self.stored: dict[str, dict[str, Any]] = {run_id: make_run(run_id) for run_id in ("run-seed", "run-a", "run-b")}
        self.port = 0
        self._server: uvicorn.Server | None = None

    # ── handlers ──

    @staticmethod
    def error(status: int, code: str, **extra: Any) -> JSONResponse:
        return JSONResponse({"error": code, "code": code, **extra}, status_code=status)

    async def handle(self, request: Request) -> Response:
        self.requests.append((request.method, request.url.path))
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return self.error(401, "unauthorized")
        prefix = f"/api/workspaces/{WORKSPACE}/benchmark"
        path = request.url.path.removeprefix(prefix)
        method = request.method
        if method == "GET" and path == "/defaults":
            return JSONResponse({"limits": {"wall_time_ms": 600000}, "endpoints": []})
        if method == "GET" and path == "/benchmarks":
            return self.list_benchmarks(request)
        if method == "GET" and path.startswith("/benchmarks/"):
            return self.benchmark(path.split("/")[2])
        if method == "GET" and path == "/runs":
            return JSONResponse({"runs": [summary(run) for run in reversed(self.runs.values())]})
        if method == "POST" and path == "/runs":
            body = await request.json()
            self.bodies.append(body)
            return self.create_run(body)
        if method == "GET" and path == "/compare/attempts":
            self.attempt_compares.append(dict(request.query_params))
            return self.compare_attempts(request)
        if method == "GET" and path == "/compare":
            self.compares.append(dict(request.query_params))
            return JSONResponse(self.comparison)
        if method == "GET" and path.startswith("/runs/"):
            run = {**self.stored, **self.runs}.get(path.split("/")[2])
            return JSONResponse({"run": run}) if run else self.error(404, "unknown_run")
        if method == "GET" and path.startswith("/attempts/"):
            attempt_id, _, part = path.removeprefix("/attempts/").partition("/")
            attempt = self.attempts().get(attempt_id)
            if attempt is None:
                return self.error(404, "unknown_attempt")
            return self.attempt_part(request, attempt, part)
        return self.error(404, "not_found")

    def attempts(self) -> dict[str, dict[str, Any]]:
        """Every attempt of the member's runs by id."""
        return {
            attempt["attempt_id"]: attempt for run in {**self.stored, **self.runs}.values() for case in run["cases"] for attempt in case["attempts"]
        }

    def attempt_part(self, request: Request, attempt: dict[str, Any], part: str) -> Response:
        if part == "":
            return JSONResponse({"attempt": attempt})
        if part == "events":
            return self.events_page(request)
        if part == "stream":
            return self.stream(request)
        if part == "spans":
            return JSONResponse({"spans": [{"id": "s1", "kind": request.query_params.get("kind", "tool"), "name": "n"}], "links": []})
        if part.startswith("payloads/"):
            digest = part.rsplit("/", 1)[1]
            if digest not in (PAYLOAD_SHA, BAD_PAYLOAD_SHA):
                return self.error(404, "unknown_payload")
            return Response(PAYLOAD, media_type="application/octet-stream", headers={"X-Rush-Redaction": "none"})
        if part == "accounting":
            return JSONResponse(
                {"attempt_id": attempt["attempt_id"], "calls": [], "totals": {"calls": 1, "settled_usd": self.costs.get(attempt["attempt_id"], 0.25), "uncertain_calls": self.uncertain.get(attempt["attempt_id"], 0)}}
            )
        return self.error(404, "not_found")

    def compare_attempts(self, request: Request) -> JSONResponse:
        return JSONResponse(self.attempt_comparison)

    def list_benchmarks(self, request: Request) -> JSONResponse:
        plugin, version = request.query_params.get("plugin_id"), request.query_params.get("version")
        if version is not None and plugin is None:
            return self.error(400, "invalid_request")
        found = [summary for (pid, ver, _), (_, summary) in self.publications.items() if plugin in (None, pid) and version in (None, ver)]
        return JSONResponse({"benchmarks": found[::-1]})

    def find(self, benchmark_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        return next((held for held in self.publications.values() if held[1]["benchmark_id"] == benchmark_id), None)

    def benchmark(self, benchmark_id: str) -> JSONResponse:
        held = self.find(benchmark_id)
        if held is None:
            return self.error(404, "unknown_benchmark")
        publication, benchmark = held
        view = {**benchmark, "task": publication["task"], "cases": [{**case, "position": n} for n, case in enumerate(publication["cases"])]}
        return JSONResponse({"benchmark": view})

    async def publish_benchmark(self, request: Request) -> Response:
        self.requests.append((request.method, request.url.path))
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return self.error(401, "unauthorized")
        body = await request.json()
        try:
            check_publication(body)  # the server's rules (rush_rules.py, from validate.js)
        except Invalid as error:
            return self.error(400, error.code, message=error.message)
        key = (body["plugin_id"], body["version"], body["name"])
        held = self.publications.get(key)
        if held is not None:
            if held[0] != body:
                return self.error(409, "benchmark_name_taken")
            return JSONResponse({"created": False, "benchmark": held[1]})
        benchmark = {
            "benchmark_id": f"00000000-0000-4000-8000-{len(self.publications) + 1:012d}",
            "name": body["name"],
            "plugin": {"id": body["plugin_id"], "name": body["plugin_name"], "version": body["version"], "sha256": body["package_sha256"]},
            "task_id": body["task_id"],
            "publisher": USER,
            "model": "mock/model",
            "endpoint_profile": "mock",
            "case_count": len(body["cases"]),
        }
        self.publications[key] = (body, benchmark)
        return JSONResponse({"created": True, "benchmark": benchmark}, status_code=201)

    def create_run(self, body: dict[str, Any]) -> JSONResponse:
        try:
            check_run(body)  # the server's rules (rush_rules.py, from validate.js)
        except Invalid as error:
            return self.error(400, error.code, message=error.message)
        known = self.keys.get(body["idempotency_key"])
        if known is not None:
            if known[0] != body:
                return self.error(409, "idempotency_conflict")
            return JSONResponse({"replayed": True, "run": self.runs[known[1]]})
        found = self.find(body["benchmark_id"])
        if found is None:
            return self.error(404, "unknown_benchmark")
        run_id = f"run-{len(self.runs) + 1}"
        attempts = {case["case_id"]: (f"{run_id}-{case['case_id']}", self.verdicts.get((body["harness"], case["case_id"]), "pass")) for case in found[0]["cases"]}
        self.runs[run_id] = make_run(run_id, found[1], {"name": body["harness"]}, attempts)
        self.keys[body["idempotency_key"]] = (body, run_id)
        return JSONResponse({"replayed": False, "run": self.runs[run_id]}, status_code=201)

    def events_page(self, request: Request) -> JSONResponse:
        after = int(request.query_params.get("after", 0))
        limit = int(request.query_params.get("limit", 200))
        rest = [event for event in events() if event["cursor"] > after]
        page = rest[:limit]
        return JSONResponse({"events": page, "has_more": len(rest) > len(page), "sealed": True, "final_cursor": 3, "high_water_cursor": 3})

    def stream(self, request: Request) -> StreamingResponse:
        self.connections += 1
        after = int(request.query_params.get("after", 0))
        first = self.connections == 1

        def frames() -> Any:
            for event in events():
                if first and event["cursor"] > 2:
                    return  # the connection drops before `sealed`
                # A reconnect resends cursor 2, which the client has and must drop.
                if event["cursor"] > after or (not first and event["cursor"] == 2):
                    yield f"id: {event['cursor']}\nevent: event\ndata: {json.dumps(event)}\n\n"
            yield ": heartbeat\n\n"
            yield 'event: sealed\ndata: {"final_cursor": 3}\n\n'

        return StreamingResponse(frames(), media_type="text/event-stream")

    # ── lifecycle ──

    def __enter__(self) -> FakeRush:
        app = Starlette(
            routes=[
                Route("/api/workspaces/{rest:path}", self.handle, methods=["GET", "POST"]),
                Route("/api/benchmark/benchmarks", self.publish_benchmark, methods=["POST"]),
            ],
        )
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
        threading.Thread(target=server.run, daemon=True).start()
        deadline = time.monotonic() + 10
        while not server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("the fake RUSH server did not start")
            time.sleep(0.01)
        self.port = server.servers[0].sockets[0].getsockname()[1]
        self._server = server
        return self

    def __exit__(self, *exc: object) -> None:
        assert self._server is not None
        self._server.should_exit = True

    def client_of(self) -> Any:
        """The fake's member client, for a test's own set-up calls."""
        from nanoagent.uploaded.client import BenchmarkClient

        return BenchmarkClient(self.url, WORKSPACE, TOKEN)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"
