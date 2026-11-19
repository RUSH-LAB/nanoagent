"""Pieces of the recovery-and-access acceptance test: members and workspaces on a scratch RUSH server, the worker API as a
direct client (for the faults only a hand-driven worker can inject), server-sent events read by hand, and the worker on this machine
with signals and cleanup."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import time
from dataclasses import dataclass
from typing import Any

import httpx
from microsandbox import Sandbox

from nanoagent.uploaded.client import sse_frames
from rush_server import RushServer, psql, sign_in
from support import HOST, Worker

# What a hand-driven worker offers: the defaults of a run's limits, with no internet access.
CAPABILITIES = {
    "wall_time_ms": 600_000, "max_model_calls": 50, "max_output_tokens_per_call": 4096, "max_cost_usd": 1.5, "cpus": 1, "memory_mb": 1024,
    "pids": 256, "workspace_bytes": 268_435_456, "workspace_files": 20_000, "tmp_bytes": 67_108_864, "build_wall_ms": 600_000, "build_memory_mb": 3072,
    "build_output_bytes": 1 << 30, "build_files": 100_000, "build_tmp_bytes": 512 << 20, "internet_access": False,
    "models": ["test/model"],
}  # fmt: skip


def db(rush: RushServer, sql: str) -> str:
    """One statement as the system: the benchmark tables are under forced row-level security, which the owner passes only as the system."""
    return psql(rush.database, f"begin;\nselect set_config('app.benchmark_system', 'on', true) as system \\gset\n{sql};\ncommit;")


@dataclass(frozen=True)
class Member:
    """A signed-in member of a workspace."""

    name: str
    user_id: str
    token: str
    workspace_id: str
    base_url: str

    def get(self, path: str, **kwargs: Any) -> httpx.Response:
        return httpx.get(f"{self.base_url}/api/workspaces/{self.workspace_id}/benchmark{path}", headers={"Authorization": f"Bearer {self.token}"}, timeout=60, **kwargs)

    def post(self, path: str, body: Any = None) -> httpx.Response:
        return httpx.post(f"{self.base_url}/api/workspaces/{self.workspace_id}/benchmark{path}", headers={"Authorization": f"Bearer {self.token}"}, json=body, timeout=60)

    def elsewhere(self, workspace_id: str) -> Member:
        """The same member addressing another workspace."""
        return Member(self.name, self.user_id, self.token, workspace_id, self.base_url)


def alice(rush: RushServer) -> Member:
    return Member("alice", rush.user_id, rush.token, rush.workspace_id, rush.base_url)


def session_user(base_url: str, token: str) -> str:
    response = httpx.get(f"{base_url}/api/auth/get-session", headers={"Authorization": f"Bearer {token}", "origin": base_url}, timeout=30)
    response.raise_for_status()
    return response.json()["user"]["id"]


def join_workspace(rush: RushServer, name: str, workspace_id: str, plugin_ids: list[str]) -> Member:
    """A new member of ``workspace_id`` (the fake GitHub answers any login) who has installed ``plugin_ids``."""
    token = sign_in(rush.base_url, f"{name}-{rush.database.removeprefix('bench_smoke_')}")
    user_id = session_user(rush.base_url, token)
    psql(rush.database, f"insert into workspace_member (id, workspace_id, user_id, role) values (gen_random_uuid()::text, '{workspace_id}', '{user_id}', 'viewer')")
    for plugin_id in plugin_ids:
        psql(rush.database, f"insert into user_plugin (user_id, plugin_id, source) values ('{user_id}', '{plugin_id}', 'upload')")
    return Member(name, user_id, token, workspace_id, rush.base_url)


def new_workspace(rush: RushServer, owner: Member, slug: str) -> str:
    created = httpx.post(
        f"{rush.base_url}/api/workspaces", json={"name": slug, "slug": f"{slug}-{rush.database[-6:]}"},
        headers={"Authorization": f"Bearer {owner.token}", "origin": rush.base_url, "x-real-ip": "203.0.113.7"}, timeout=30,
    )
    created.raise_for_status()
    return created.json()["workspace"]["id"]


class WorkerApi:
    """The worker API as a hand-driven worker: every call returns the response, so tests assert status and code."""

    def __init__(self, base_url: str, token: str) -> None:
        self.token = token
        self.http = httpx.Client(base_url=base_url, headers={"Authorization": f"Bearer {token}"}, timeout=60)

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        return self.http.request(method, f"/api/benchmark-worker{path}", **kwargs)

    def claim(self, label: str) -> dict[str, Any] | None:
        response = self.request("POST", "/claim", json={"worker_id": "hand-worker", "endpoint_profile": {"label": label, "mode": "mock"}, "capabilities": CAPABILITIES, "interactive": False})
        assert response.status_code in (200, 204), response.text
        return None if response.status_code == 204 else response.json()

    def admit(self, attempt: str, fence: int, call_id: str, reserve_usd: float) -> httpx.Response:
        return self.request("POST", f"/attempts/{attempt}/admissions", json={"fence": fence, "call_id": call_id, "reserve_usd": reserve_usd})

    def settle(self, attempt: str, call_id: str, outcome: str, cost_usd: float | None = None) -> httpx.Response:
        body: dict[str, Any] = {"fence": 0, "outcome": outcome, "provenance": {"source": "test"}}
        if cost_usd is not None:
            body["cost_usd"] = cost_usd
        return self.request("POST", f"/attempts/{attempt}/admissions/{call_id}/settle", json=body)

    def events(self, attempt: str, fence: int, events: list[dict[str, Any]]) -> httpx.Response:
        return self.request("POST", f"/attempts/{attempt}/events", json={"fence": fence, "events": events})

    def stale_calls(self, attempt: str, fence: int) -> dict[str, httpx.Response]:
        """Every fenced worker route with ``fence``."""
        data = b"stale"
        digest = hashlib.sha256(data).hexdigest()
        return {
            "renew": self.request("POST", f"/attempts/{attempt}/renew", json={"fence": fence}),
            "source": self.request("GET", f"/attempts/{attempt}/source", headers={"X-Rush-Fence": str(fence)}),
            "package": self.request("GET", f"/attempts/{attempt}/package", headers={"X-Rush-Fence": str(fence)}),
            "admit": self.admit(attempt, fence, "stale-call", 0.001),
            "events": self.events(attempt, fence, [{"event_id": "stale-1", "source": "gateway", "kind": "model_call.admitted", "sequence": 1, "data": {}}]),
            "payload": self.request("PUT", f"/attempts/{attempt}/payloads/{digest}", content=data, headers={"X-Rush-Fence": str(fence), "X-Rush-Redaction": "none"}),
            "spans": self.request("POST", f"/attempts/{attempt}/spans", json={"fence": fence, "spans": [], "links": []}),
            "finalize": self.request(
                "POST", f"/attempts/{attempt}/finalize",
                json={"fence": fence, "execution": {"status": "canceled", "reason": None}, "coverage": {}, "metrics": {}, "final_cursor_expected": 0},
            ),
        }


def read_stream(member: Member, attempt: str, after: int, *, stop_after: int | None = None, until_cursor: int | None = None, timeout: float = 180) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Events from ``after`` over server-sent events until ``stop_after`` events, the event at ``until_cursor``, or the seal:
    ``(events, the sealed notice or None)``. The SSE id of each event must be its cursor."""
    got: list[dict[str, Any]] = []
    sealed = None
    url = f"{member.base_url}/api/workspaces/{member.workspace_id}/benchmark/attempts/{attempt}/stream"
    with httpx.Client(headers={"Authorization": f"Bearer {member.token}"}, timeout=httpx.Timeout(30, read=timeout)) as client:
        with client.stream("GET", url, params={"after": after}) as response:
            assert response.status_code == 200, response.read()
            for kind, ident, data in sse_frames(response.iter_lines()):
                if kind == "event":
                    event = json.loads(data)
                    assert ident == str(event["cursor"])
                    got.append(event)
                    if (stop_after is not None and len(got) >= stop_after) or (until_cursor is not None and event["cursor"] >= until_cursor):
                        break
                elif kind == "sealed":
                    sealed = json.loads(data)
                    break
    return got, sealed


def signal_worker(worker: Worker, name: str) -> None:
    """Send ``name`` (STOP, CONT, KILL) to the worker process."""
    os.kill(worker.pid, getattr(signal, f"SIG{name}"))


def remove_attempt_leftovers(attempt: str) -> None:
    """What a killed worker leaves for ``attempt``: its sandboxes."""

    async def remove() -> None:
        for handle in (await Sandbox.list()).sandboxes:
            if attempt in handle.name:
                await handle.kill()
                await Sandbox.remove(handle.name)

    asyncio.run(remove())


def attempt_containers(attempt: str) -> list[str]:
    async def names() -> list[str]:
        return [handle.name for handle in (await Sandbox.list_with(labels={"rush.attempt": attempt})).sandboxes]

    return asyncio.run(names())


def wait_until(check: Any, what: str, timeout: float, interval: float = 0.5) -> Any:
    deadline = time.monotonic() + timeout
    while True:
        value = check()
        if value:
            return value
        assert time.monotonic() < deadline, f"timed out after {timeout:g}s waiting for {what}"
        time.sleep(interval)


def host_url(rush: RushServer) -> str:
    return f"http://{HOST}:{rush.base_url.rsplit(':', 1)[1]}"
