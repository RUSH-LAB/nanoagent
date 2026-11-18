"""The member's client of the RUSH benchmark API (docs/contracts/rush-benchmark-api.md).

One synchronous [BenchmarkClient] covers every member endpoint plus benchmark publishing. The workspace, base URL and the
name of the environment variable holding a Better Auth session token come from a [ServerConfig]. Every error the server
answers is a [BenchmarkError] carrying the server's `code`; `stale_preview` is a [StalePreview] with the parts that changed
and the current preview; `worker_unavailable` and the other setup rejections are plain [BenchmarkError]s. Event pages and
the SSE stream hand out each event once, ordered by cursor; the stream resumes from the last cursor it saw and ends with
the terminal `sealed` marker.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx
from omegaconf import MISSING
from slimconfig import Config

EVENT_PAGE = 1000
SOURCE_CONTENT_TYPE = "application/zip"


@dataclass
class ServerConfig(Config):
    # The RUSH server's origin, the workspace every request names, and the environment variable holding
    # a Better Auth session token (sent as `Authorization: Bearer`).
    base_url: str = MISSING
    workspace_id: str = MISSING
    token_env: str = MISSING

    def client(self) -> BenchmarkClient:
        token = os.environ.get(self.token_env)
        if not token:
            raise RuntimeError(f"environment variable {self.token_env} holds no Better Auth session token")
        return BenchmarkClient(self.base_url, self.workspace_id, token)


class BenchmarkError(Exception):
    """An error response: its HTTP status, the server's `code`, and the whole body."""

    def __init__(self, status: int, code: str | None, message: str, body: dict[str, Any]) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.body = body


class StalePreview(BenchmarkError):
    """`stale_preview`: the names of the parts that changed since the preview (`prompt`, `cases`, ...), and the preview the
    request resolves to now (without a `preview_id`)."""

    @property
    def stale(self) -> list[str]:
        return self.body.get("stale", [])

    @property
    def current(self) -> dict[str, Any]:
        return self.body.get("current", {})


class PayloadDigestMismatch(Exception):
    def __init__(self, attempt_id: str, expected: str, actual: str) -> None:
        super().__init__(f"payload {expected} of attempt {attempt_id} hashes to {actual}")
        self.expected = expected
        self.actual = actual


class StreamLost(Exception):
    """The event stream ended or broke more often than allowed before the attempt sealed."""


@dataclass(frozen=True)
class Payload:
    data: bytes
    content_type: str | None
    redaction: str | None


@dataclass(frozen=True)
class EventLog:
    events: list[dict[str, Any]]
    sealed: bool
    final_cursor: int | None
    high_water_cursor: int


def run_title(run: dict[str, Any]) -> str:
    """``harness@version on benchmark (plugin @ version)`` of a run's detail."""
    harness, plugin = run["harness"], run["case_set"]["plugin"]
    return f"{harness['name']}@{harness['version']} on {run['benchmark']['name']} ({plugin['id']} @ {plugin['version']})"


@dataclass(frozen=True)
class RunSubmission:
    replayed: bool
    run: dict[str, Any]


def sse_frames(lines: Iterable[str]) -> Iterator[tuple[str, str | None, str]]:
    """Server-sent frames as ``(event, id, data)``; comments (heartbeats) are skipped."""
    event, ident, data = "message", None, []
    for line in lines:
        if line == "":
            if data:
                yield event, ident, "\n".join(data)
            event, ident, data = "message", None, []
        elif line.startswith(":"):
            continue
        else:
            field, _, value = line.partition(":")
            value = value.removeprefix(" ")
            if field == "event":
                event = value
            elif field == "id":
                ident = value
            elif field == "data":
                data.append(value)


class BenchmarkClient:
    def __init__(
        self,
        base_url: str,
        workspace_id: str,
        token: str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 60.0,
        max_reconnects: int = 5,
    ) -> None:
        self.max_reconnects = max_reconnects
        self._prefix = f"/api/workspaces/{workspace_id}/benchmark"
        self._http = httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=httpx.Timeout(timeout, read=timeout),
            transport=transport,
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> BenchmarkClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ── plumbing ──

    @staticmethod
    def _error(response: httpx.Response) -> BenchmarkError:
        try:
            body = json.loads(response.read())
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        code = body.get("code")
        cls = StalePreview if code == "stale_preview" else BenchmarkError
        return cls(response.status_code, code, str(body.get("error", response.reason_phrase)), body)

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        response = self._http.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise self._error(response)
        return response

    @staticmethod
    def _params(**filters: Any) -> dict[str, Any]:
        return {name: value for name, value in filters.items() if value is not None}

    def _json(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        return self._request(method, path, **kwargs).json()

    # ── publishing ──

    def download_package(self, plugin_id: str) -> bytes:
        """The latest published package of one of the caller's plugins (`GET /api/market/{id}/package`)."""
        return self._request("GET", f"/api/market/{plugin_id}/package").content

    def publish_benchmark(self, publication: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        """``(created, benchmark)``: 201 stores a new benchmark, 200 is the same content again. ``publication`` is the body
        `nanoagent.uploaded.case_sets.derive_case_set` makes, private references included, plus the run configuration
        (`model`, `endpoint_profile`, `limits`, `coding_template`, `task_instructions`). 409 `benchmark_name_taken` is the
        name of this plugin version with other content."""
        response = self._request("POST", "/api/benchmark/benchmarks", json=publication)
        body = response.json()
        return body["created"], body["benchmark"]

    # ── defaults, benchmarks, previews, sources, runs ──

    def defaults(self) -> dict[str, Any]:
        """The default limits and coding template, and the endpoint labels a worker has advertised for."""
        return self._json("GET", f"{self._prefix}/defaults")

    def benchmarks(self, plugin_id: str | None = None, version: str | None = None) -> list[dict[str, Any]]:
        """Every published benchmark, newest first, optionally of one plugin and (with ``plugin_id``) one plugin version."""
        return self._json("GET", f"{self._prefix}/benchmarks", params=self._params(plugin_id=plugin_id, version=version))["benchmarks"]

    def benchmark(self, benchmark_id: str) -> dict[str, Any]:
        """One benchmark with its case set: the task, context and cases (never the private references)."""
        return self._json("GET", f"{self._prefix}/benchmarks/{quote(benchmark_id, safe='')}")["benchmark"]

    def find_benchmark(self, plugin_id: str, version: str, name: str) -> dict[str, Any]:
        """The summary of benchmark ``name`` of one plugin version."""
        for benchmark in self.benchmarks(plugin_id, version):
            if benchmark["name"] == name:
                return benchmark
        raise LookupError(f"{plugin_id} {version} has no benchmark named {name}")

    def benchmark_results(self, benchmark_id: str, limit: int = 50, before: str | None = None) -> list[dict[str, Any]]:
        """Run summaries of every member's runs of the benchmark, newest first."""
        return self._json("GET", f"{self._prefix}/benchmarks/{quote(benchmark_id, safe='')}/results", params=self._params(limit=limit, before=before))["runs"]

    def preview(self, benchmark_id: str, policy: str) -> dict[str, Any]:
        """The run of ``policy`` (`coding` or `task_tools`) on the benchmark as the server pins it: the rendered prompts, effective limits and cases."""
        return self._json("POST", f"{self._prefix}/previews", json={"benchmark_id": benchmark_id, "policy": policy})

    def upload_source(self, data: bytes) -> dict[str, Any]:
        """``{source_sha256, size, harness: {name, version, dialects}}``: the harness identity is the manifest's."""
        return self._json("POST", f"{self._prefix}/sources", content=data, headers={"Content-Type": SOURCE_CONTENT_TYPE})

    def upload_reference(self, name: str, data: bytes) -> dict[str, Any]:
        """``upload_source`` for the ZIP of reference harness ``name``: the only way a reference's name is taken."""
        return self._json("POST", f"{self._prefix}/sources/references/{name}", content=data, headers={"Content-Type": SOURCE_CONTENT_TYPE})

    def create_run(self, *, benchmark_id: str, policy: str, preview_id: str, source_sha256: str, idempotency_key: str) -> RunSubmission:
        """Queue the run the preview of ``benchmark_id`` and ``policy`` resolved."""
        body = {"benchmark_id": benchmark_id, "policy": policy, "preview_id": preview_id, "source_sha256": source_sha256, "idempotency_key": idempotency_key}
        response = self._request("POST", f"{self._prefix}/runs", json=body).json()
        return RunSubmission(replayed=response["replayed"], run=response["run"])

    def list_runs(self, limit: int = 50, before: str | None = None) -> list[dict[str, Any]]:
        """The caller's own runs in this workspace as run summaries, newest first."""
        return self._json("GET", f"{self._prefix}/runs", params=self._params(limit=limit, before=before))["runs"]

    def run(self, run_id: str) -> dict[str, Any]:
        return self._json("GET", f"{self._prefix}/runs/{run_id}")["run"]

    def rerun(self, run_id: str, case_id: str) -> dict[str, Any]:
        return self._json("POST", f"{self._prefix}/runs/{run_id}/cases/{case_id}/rerun", json={})

    def cancel(self, run_id: str) -> dict[str, Any]:
        return self._json("POST", f"{self._prefix}/runs/{run_id}/cancel")

    def compare_runs(self, a: str, b: str) -> dict[str, Any]:
        """Two runs of the same verifier (package and task) side by side; 409 `not_same_verifier` otherwise."""
        return self._json("GET", f"{self._prefix}/compare", params={"a": a, "b": b})

    def compare_attempts(self, a: str, b: str) -> dict[str, Any]:
        """Two sealed attempts of one pinned case, compared action by action: ``{header, rows, first_difference}``; 409
        `not_same_verifier` or `not_same_case` otherwise."""
        return self._json("GET", f"{self._prefix}/compare/attempts", params={"a": a, "b": b})

    # ── attempts and their evidence ──

    def attempt(self, attempt_id: str) -> dict[str, Any]:
        return self._json("GET", f"{self._prefix}/attempts/{attempt_id}")["attempt"]

    def events(self, attempt_id: str, after: int = 0) -> EventLog:
        """Every committed event after ``after``, read page by page."""
        events: list[dict[str, Any]] = []
        cursor = after
        while True:
            page = self._json("GET", f"{self._prefix}/attempts/{attempt_id}/events", params={"after": cursor, "limit": EVENT_PAGE})
            fresh = [event for event in page["events"] if event["cursor"] > cursor]
            events += fresh
            if fresh:
                cursor = fresh[-1]["cursor"]
            if not page["has_more"] or not fresh:
                return EventLog(events, page["sealed"], page["final_cursor"], page["high_water_cursor"])

    def stream(self, attempt_id: str, after: int = 0) -> Iterator[dict[str, Any]]:
        """Live events after ``after``, each cursor once, ending with ``{"sealed": True, "final_cursor": n}``.

        A stream that ends or breaks before `sealed` is reopened from the last cursor delivered; the server
        resends nothing it was not asked for, and anything it does resend is dropped by cursor.
        """
        last = after
        failures = 0
        while True:
            try:
                with self._http.stream(
                    "GET", f"{self._prefix}/attempts/{attempt_id}/stream", params={"after": last}, headers={"Accept": "text/event-stream"}
                ) as response:
                    if response.status_code >= 400:
                        raise self._error(response)
                    for kind, _, data in sse_frames(response.iter_lines()):
                        if kind == "sealed":
                            yield {"sealed": True, **json.loads(data)}
                            return
                        if kind != "event":
                            continue
                        event = json.loads(data)
                        if event["cursor"] > last:
                            last = event["cursor"]
                            failures = 0
                            yield event
            except httpx.TransportError:
                pass
            failures += 1
            if failures > self.max_reconnects:
                raise StreamLost(f"the stream of attempt {attempt_id} broke {failures} times before it sealed, after cursor {last}")

    def spans(
        self, attempt_id: str, *, kind: str | None = None, status: str | None = None, q: str | None = None, limit: int | None = None
    ) -> dict[str, Any]:
        return self._json("GET", f"{self._prefix}/attempts/{attempt_id}/spans", params=self._params(kind=kind, status=status, q=q, limit=limit))

    def payload(self, attempt_id: str, sha256: str) -> Payload:
        """The payload's bytes, which must hash to ``sha256``."""
        response = self._request("GET", f"{self._prefix}/attempts/{attempt_id}/payloads/{sha256}")
        actual = hashlib.sha256(response.content).hexdigest()
        if actual != sha256:
            raise PayloadDigestMismatch(attempt_id, sha256, actual)
        return Payload(response.content, response.headers.get("content-type"), response.headers.get("x-rush-redaction"))

    def accounting(self, attempt_id: str) -> dict[str, Any]:
        return self._json("GET", f"{self._prefix}/attempts/{attempt_id}/accounting")
