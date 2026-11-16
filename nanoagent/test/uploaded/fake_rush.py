"""An in-process fake of the RUSH member benchmark API (docs/contracts/rush-benchmark-api.md), served by uvicorn on a
free loopback port, with just the behavior the client and the CLI steps depend on: benchmark publishing under the naming rules
(identical republish, `benchmark_name_taken`), a source upload that reads the harness manifest (and refuses another ZIP under a
used `name@version`), run summaries, results of a benchmark, idempotent run creation, a stale preview, a paginated event log and an
SSE stream that drops its first connection, payloads (one corrupted)."""

from __future__ import annotations

import hashlib
import json
import threading
import time
import zipfile
from io import BytesIO
from typing import Any

import uvicorn
import yaml
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from nanoagent.uploaded.reference import NAMES as REFERENCE_HARNESSES

WORKSPACE = "ws-1"
TOKEN = "fake-session-token"
ATTEMPT = "attempt-1"
PAYLOAD = b"payload bytes"
PAYLOAD_SHA = hashlib.sha256(PAYLOAD).hexdigest()
BAD_PAYLOAD_SHA = hashlib.sha256(b"what the digest names").hexdigest()
USER = {"id": "user-1", "name": "Una", "github": "una"}
DIGEST = "d" * 64


def events() -> list[dict[str, Any]]:
    return [
        {
            "cursor": cursor,
            "event_id": f"e{cursor}",
            "source": "gateway",
            "kind": "model_call",
            "sequence": cursor,
            "occurred_ns": "1700000000123456789",
            "data": {},
            "payload_sha256s": [PAYLOAD_SHA],
            "received_at": "2026-01-01T00:00:00Z",
        }
        for cursor in (1, 2, 3)
    ]


def metric(total: int, missing: int = 0) -> dict[str, int]:
    return {"total": total, "missing_attempts": missing}


def make_run(run_id: str, benchmark: dict[str, Any] | None = None, harness: dict[str, Any] | None = None, policy: str = "coding") -> dict[str, Any]:
    attempt = {
        "attempt_id": ATTEMPT,
        "run_id": run_id,
        "case_id": "c1",
        "attempt_no": 1,
        "rerun_of": None,
        "state": "final",
        "execution": {"status": "answered", "reason": None},
        "verdict": "pass",
        "explanation": None,
        "verifier_error": None,
        "coverage": {"status": "complete"},
        "metrics": {"total_tokens": 30, "elapsed_ms": 1500},
        "sealed": True,
        "final_cursor": 3,
        "high_water_cursor": 3,
    }
    metrics = {
        "total_tokens": metric(30),
        "input_tokens": metric(20, 1),
        "output_tokens": metric(10),
        "cache_read_tokens": metric(0),
        "cache_write_tokens": metric(0),
        "elapsed_ms": metric(1500),
    }
    benchmark = benchmark or {"benchmark_id": "bench-0", "name": "probe"}
    harness = harness or {"name": "h", "version": "1", "dialects": ["chat_completions"]}
    return {
        "run_id": run_id,
        "preview_id": "preview-1",
        "status": "complete",
        "benchmark": {"benchmark_id": benchmark["benchmark_id"], "name": benchmark["name"]},
        "harness": harness,
        "model": "mock/model",
        "endpoint_profile": "mock",
        "dialects": harness["dialects"],
        "case_set": {
            "case_set_id": "cs-1", "name": "probe", "digest": DIGEST, "publisher": {},
            "plugin": {"id": "p", "name": "P", "version": "1.0.0", "sha256": "pkg"}, "task_id": "t", "task": {}, "context": "",
        },
        "policy": policy,
        "prompt": {"source": "default", "text": "Solve {description}"},
        "limits": {"wall_time_ms": 600000, "max_model_calls": 50, "internet_access": True},
        "metrics": metrics,
        "score": {"value": 1, "passed": 1, "scored": 1, "total": 1, "unscored": 0, "verifier_errors": 0, "complete": True, "unavailable_reason": None},
        "cases": [{"case_id": "c1", "kind": "answer", "content_digest": "cd1", "prompt": {"system": None, "user": "u"}, "attempts": [attempt]}],
    }


def summary(run: dict[str, Any], user: dict[str, Any] = USER) -> dict[str, Any]:
    """A run as `GET /runs` and `GET /benchmarks/{id}/results` list it: nothing but the run summary's fields."""
    plugin = run["case_set"]["plugin"]
    return {
        "run_id": run["run_id"],
        "harness": {"name": run["harness"]["name"], "version": run["harness"]["version"]},
        "benchmark": {"name": run["benchmark"]["name"]},
        "plugin": {"id": plugin["id"], "name": plugin["name"], "version": plugin["version"]},
        "model": run["model"],
        "policy": run["policy"],
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
        self.stale = False
        self.compares: list[dict[str, str]] = []
        self.comparison: dict[str, Any] = {
            "config": [], "prompt_diff": {"text": [], "rendered": []}, "shared": [], "only_a": [], "only_b": [],
            "unverified_egress": {"a": False, "b": False},
        }  # fmt: skip
        self.attempt_comparison: dict[str, Any] = {}
        self.attempt_compares: list[dict[str, str]] = []
        self.previews = 0
        self.connections = 0
        # (plugin_id, version, name) -> the publication and the benchmark summary the server made of it.
        self.publications: dict[tuple[str, str, str], tuple[dict[str, Any], dict[str, Any]]] = {}
        # Pinned sha256 of each (name, version) of a harness, and the runs of other members that a benchmark's results list.
        self.harnesses: dict[tuple[str, str], str] = {}
        self.other_runs: list[dict[str, Any]] = []
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
        if method == "POST" and path == "/sources":
            return self.upload_source(await request.body())
        if method == "POST" and path.startswith("/sources/references/"):
            return self.upload_source(await request.body(), reference=path.rsplit("/", 1)[1])
        if method == "GET" and path == "/defaults":
            return JSONResponse({"limits": {"wall_time_ms": 600000}, "coding_template": "t", "endpoints": []})
        if method == "GET" and path == "/benchmarks":
            return self.list_benchmarks(request)
        if method == "GET" and path.startswith("/benchmarks/"):
            return self.benchmark(path.split("/")[2], results=path.endswith("/results"))
        if method == "GET" and path == "/runs":
            return JSONResponse({"runs": [summary(run) for run in reversed(self.runs.values())]})
        if method == "POST" and path == "/previews":
            body = await request.json()
            self.bodies.append(body)
            return self.preview(body)
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
        if method == "GET" and path == f"/attempts/{ATTEMPT}":
            return JSONResponse({"attempt": {"attempt_id": ATTEMPT, "run_id": "run-seed", "state": "final", "sealed": True}})
        if method == "GET" and path == f"/attempts/{ATTEMPT}/events":
            return self.events_page(request)
        if method == "GET" and path == f"/attempts/{ATTEMPT}/stream":
            return self.stream(request)
        if method == "GET" and path == f"/attempts/{ATTEMPT}/spans":
            return JSONResponse({"spans": [{"id": "s1", "kind": request.query_params.get("kind", "tool"), "name": "n"}], "links": []})
        if method == "GET" and path.startswith(f"/attempts/{ATTEMPT}/payloads/"):
            digest = path.rsplit("/", 1)[1]
            if digest not in (PAYLOAD_SHA, BAD_PAYLOAD_SHA):
                return self.error(404, "unknown_payload")
            return Response(PAYLOAD, media_type="application/octet-stream", headers={"X-Rush-Redaction": "none"})
        if method == "GET" and path == f"/attempts/{ATTEMPT}/accounting":
            return JSONResponse({"attempt_id": ATTEMPT, "calls": [], "totals": {"calls": 0}})
        return self.error(404, "not_found")

    def compare_attempts(self, request: Request) -> JSONResponse:
        return JSONResponse(self.attempt_comparison)

    def upload_source(self, data: bytes, reference: str | None = None) -> JSONResponse:
        """The member's source as the server takes it: `harness.yaml` read from the ZIP, and `name@version` pinned to the first ZIP.
        A reference harness's name is taken only by its own `reference` upload, whose manifest must name it."""
        try:
            manifest = yaml.safe_load(zipfile.ZipFile(BytesIO(data)).read("harness.yaml"))
        except (zipfile.BadZipFile, KeyError):
            return self.error(400, "missing_manifest")
        if not isinstance(manifest, dict) or not all(key in manifest for key in ("name", "version", "dialects")):
            return self.error(400, "invalid_manifest")
        if reference is None and manifest["name"] in REFERENCE_HARNESSES:
            return self.error(400, "reserved_harness_name")
        if reference is not None and manifest["name"] != reference:
            return self.error(400, "reference_name_mismatch")
        harness = {"name": manifest["name"], "version": str(manifest["version"]), "dialects": manifest["dialects"]}
        sha256 = hashlib.sha256(data).hexdigest()
        pinned = self.harnesses.setdefault((harness["name"], harness["version"]), sha256)
        if pinned != sha256:
            return self.error(409, "harness_version_taken", harness={"name": harness["name"], "version": harness["version"]}, pinned_sha256=pinned)
        return JSONResponse({"source_sha256": sha256, "size": len(data), "harness": harness}, status_code=201)

    def list_benchmarks(self, request: Request) -> JSONResponse:
        plugin, version = request.query_params.get("plugin_id"), request.query_params.get("version")
        if version is not None and plugin is None:
            return self.error(400, "invalid_request")
        found = [summary for (pid, ver, _), (_, summary) in self.publications.items() if plugin in (None, pid) and version in (None, ver)]
        return JSONResponse({"benchmarks": found[::-1]})

    def find(self, benchmark_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        return next((held for held in self.publications.values() if held[1]["benchmark_id"] == benchmark_id), None)

    def benchmark(self, benchmark_id: str, *, results: bool) -> JSONResponse:
        held = self.find(benchmark_id)
        if held is None:
            return self.error(404, "unknown_benchmark")
        publication, benchmark = held
        if results:
            own = [summary(run) for run in self.runs.values() if run["benchmark"]["benchmark_id"] == benchmark_id]
            return JSONResponse({"runs": [*own, *(run for run in self.other_runs if run["benchmark"]["name"] == benchmark["name"])]})
        view = {**benchmark, "task": publication["task"], "context": publication["context"], "cases": [{**case, "position": n} for n, case in enumerate(publication["cases"])]}
        return JSONResponse({"benchmark": view})

    def preview(self, body: dict[str, Any]) -> JSONResponse:
        if set(body) != {"benchmark_id", "policy"}:
            return self.error(400, "invalid_request")
        held = self.find(body["benchmark_id"])
        if held is None:
            return self.error(404, "unknown_benchmark")
        publication, benchmark = held
        self.previews += 1
        limits = {"wall_time_ms": 600000, "internet_access": True, **publication["limits"]}
        return JSONResponse(
            {
                "preview_id": f"preview-{self.previews}",
                "benchmark": benchmark,
                "policy": body["policy"],
                "prompt": {"source": "benchmark", "text": "t"},
                "limits": {"effective": limits, "capabilities": {}},
                "cases": [{"case_id": case["case_id"], "kind": case["kind"], "content_digest": "cd1", "prompt": {"system": None, "user": "u"}} for case in publication["cases"]],
            }
        )

    async def publish_benchmark(self, request: Request) -> Response:
        self.requests.append((request.method, request.url.path))
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return self.error(401, "unauthorized")
        body = await request.json()
        key = (body["plugin_id"], body["version"], body["name"])
        held = self.publications.get(key)
        if held is not None:
            if held[0] != body:
                return self.error(409, "benchmark_name_taken")
            return JSONResponse({"created": False, "benchmark": held[1]})
        benchmark = {
            "benchmark_id": f"bench-{len(self.publications) + 1}",
            "name": body["name"],
            "plugin": {"id": body["plugin_id"], "name": body["plugin_name"], "version": body["version"], "sha256": body["package_sha256"]},
            "task_id": body["task_id"],
            "publisher": USER,
            "model": body["model"],
            "endpoint_profile": body["endpoint_profile"],
            "case_count": len(body["cases"]),
            "run_count": 0,
            "runner_count": 0,
        }
        self.publications[key] = (body, benchmark)
        return JSONResponse({"created": True, "benchmark": benchmark}, status_code=201)

    def create_run(self, body: dict[str, Any]) -> JSONResponse:
        if set(body) != {"benchmark_id", "policy", "preview_id", "source_sha256", "idempotency_key"}:
            return self.error(400, "invalid_request")
        known = self.keys.get(body["idempotency_key"])
        if known is not None:
            if known[0] != body:
                return self.error(409, "idempotency_conflict")
            return JSONResponse({"replayed": True, "run": self.runs[known[1]]})
        if self.stale:
            return self.error(
                409,
                "stale_preview",
                stale=["prompt", "cases"],
                current={
                    "benchmark": {"benchmark_id": "bench-2", "name": "probe"}, "policy": "coding", "prompt": {"source": "benchmark", "text": "t"},
                    "limits": {"effective": {"wall_time_ms": 1}}, "cases": [{"case_id": "c1"}],
                },
            )
        found = self.find(body["benchmark_id"])
        if found is None:
            return self.error(404, "unknown_benchmark")
        # A source the test never uploaded gets make_run's harness.
        harness = next(
            ({"name": name, "version": version, "dialects": ["chat_completions"]} for (name, version), sha in self.harnesses.items() if sha == body["source_sha256"]),
            None,
        )
        run_id = f"run-{len(self.runs) + 1}"
        self.runs[run_id] = make_run(run_id, found[1], harness, body["policy"])
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

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"
