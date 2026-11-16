"""A real RUSH server on a scratch database, for acceptance tests that drive the CLI against it.

    with rush_server() as rush:
        rush.base_url, rush.workspace_id, rush.token       # alice's Better Auth session, a member of the workspace
        rush.seed_plugin(package)                           # publish `package` to the marketplace as alice and install it

It does what helpinghands/tests/integration/postgres/benchmark-acceptance.mjs does: a throwaway database in the local
cluster (helpinghands' `npm run db:setup`, port 55432; never `mochi`), the server (`node src/server/index.js`, which
migrates it) with GitHub replaced by tests/integration/postgres/_fake-github.mjs, and a stub NanoAgent service.
The server and the database are removed on exit."""

from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import subprocess
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from nanoagent.plugin.package import inspect_package
from nanoagent.uploaded.compare_view import compare_attempts

NANOAGENT = Path(__file__).resolve().parents[2]
HELPINGHANDS = NANOAGENT.parent / "helpinghands"
PORT = 55432
OWNER = "neondb_owner"
RUNTIME = "mochi_runtime"
FAKE_GITHUB = HELPINGHANDS / "tests" / "integration" / "postgres" / "_fake-github.mjs"


def postgres_bin() -> Path | None:
    """Homebrew's PostgreSQL 18 programs, found as helpinghands' scripts/db/local.mjs finds them: /opt/homebrew on Apple silicon,
    /usr/local on Intel. None when they are not installed."""
    brew = shutil.which("brew")
    if brew is None:
        return None
    prefix = subprocess.run([brew, "--prefix", "postgresql@18"], capture_output=True, text=True)
    folder = Path(prefix.stdout.strip()) / "bin"
    return folder if prefix.returncode == 0 and (folder / "psql").is_file() else None


POSTGRES = postgres_bin()


def unavailable() -> str | None:
    """Why the real server cannot run here, or None."""
    if shutil.which("node") is None:
        return "node is not installed"
    if POSTGRES is None:
        return "PostgreSQL 18 from Homebrew is not installed (brew install postgresql@18)"
    if not (HELPINGHANDS / "src" / "server" / "index.js").is_file() or not FAKE_GITHUB.is_file():
        return f"helpinghands is not at {HELPINGHANDS}"
    if not (HELPINGHANDS / "node_modules").is_dir():
        return "helpinghands has no node_modules (npm ci)"
    ready = subprocess.run([str(POSTGRES / "pg_isready"), "-h", "127.0.0.1", "-p", str(PORT)], capture_output=True)
    return None if ready.returncode == 0 else f"the local PostgreSQL cluster is not accepting connections on port {PORT} (npm run db:setup)"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def psql(database: str, sql: str) -> str:
    done = subprocess.run(
        [str(POSTGRES / "psql"), "-h", "127.0.0.1", "-p", str(PORT), "-U", OWNER, "-d", database, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"],
        input=sql,
        capture_output=True,
        text=True,
    )
    if done.returncode != 0:
        raise RuntimeError(f"psql failed on {database}: {done.stderr.strip()}")
    return done.stdout.strip()


class StubNanoAgent(BaseHTTPRequestHandler):
    """NanoAgent's package service as the server needs it: no built-in plugins, the real attempt comparison, `{}` for anything else."""

    def do_GET(self) -> None:
        body = json.dumps({"packages": []} if self.path == "/v1/packages" else {}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        """`/v1/benchmark/compare` is NanoAgent's real comparison of two attempts' posted evidence (what the member's web app does);
        anything else is answered `{}`."""
        if self.path != "/v1/benchmark/compare":
            self.do_GET()
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        try:
            status, answer = 200, compare_attempts(body.get("a"), body.get("b"))
        except ValueError as error:
            status, answer = 400, {"error": str(error)}
        data = json.dumps(answer).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args: Any) -> None:
        pass


def worker_credential(origin: str, session_token: str) -> str:
    """A worker credential minted through the server for the member whose Better Auth session is ``session_token``: the bearer a worker
    (RUSH_WORKER_TOKEN) claims that member's runs with, and no one else's."""
    response = httpx.post(
        f"{origin}/api/benchmark/worker-credentials",
        json={"name": "acceptance"},
        headers={"authorization": f"Bearer {session_token}", "origin": origin, "x-real-ip": "203.0.113.7"},
    )
    response.raise_for_status()
    return response.json()["token"]


@dataclass
class RushServer:
    base_url: str
    workspace_id: str
    token: str
    user_id: str
    database: str
    logs: list[str]
    worker_token: str

    def advertise(self, label: str, internet_access: bool = True, models: tuple[str, ...] = ("test/model",), *, credential: str | None = None) -> None:
        """Tell the server a worker serves endpoint profile ``label`` with the capabilities of its defaults and prices for ``models``, as a claim does (nothing is queued, so it answers 204).
        It is the capability of the member ``credential`` was minted for (alice, the workspace's creator, unless given): a member's runs are previewed only against their own worker's."""
        capabilities = {
            "wall_time_ms": 600_000, "max_model_calls": 50, "max_output_tokens_per_call": 4096, "max_cost_usd": 1.5, "concurrency": 4, "cpus": 1,
            "memory_mb": 1024, "pids": 256, "workspace_bytes": 268_435_456, "workspace_files": 20_000, "tmp_bytes": 67_108_864, "build_wall_ms": 600_000,
            "build_memory_mb": 3072, "build_output_bytes": 1 << 30, "build_files": 100_000, "build_tmp_bytes": 512 << 20, "internet_access": internet_access, "models": list(models),
        }  # fmt: skip
        body = {"worker_id": "smoke", "endpoint_profile": {"label": label, "mode": "mock"}, "capabilities": capabilities}
        httpx.post(f"{self.base_url}/api/benchmark-worker/claim", json=body, headers={"authorization": f"Bearer {credential or self.worker_token}"}).raise_for_status()

    def seed_plugin(self, package: bytes) -> dict[str, Any]:
        """Publish ``package`` to the marketplace as the member and install it for them; its catalog entry."""
        entry = inspect_package(package)
        plugin_id, version, sha256 = entry["id"], entry["version"], entry["sha256"]
        document = json.dumps(entry).replace("'", "''")
        psql(
            self.database,
            f"""begin;
insert into market_plugin (id, owner_id, version) values ('{plugin_id}', '{self.user_id}', '{version}');
insert into market_plugin_version (plugin_id, version, entry, package, sha256, size)
  values ('{plugin_id}', '{version}', '{document}', decode('{package.hex()}', 'hex'), '{sha256}', {len(package)});
insert into user_plugin (user_id, plugin_id, source) values ('{self.user_id}', '{plugin_id}', 'upload');
commit;""",
        )
        return entry


def sign_in(origin: str, login: str) -> str:
    """The session token of GitHub user ``login`` (the fake GitHub answers every login), as _github.mjs signs in."""
    headers = {"x-real-ip": "203.0.113.7", "origin": origin}

    def cookies(response: httpx.Response) -> list[str]:
        return [value.split(";", 1)[0] for value in response.headers.get_list("set-cookie")]

    with httpx.Client(base_url=origin, headers=headers, follow_redirects=False) as http:
        started = http.post("/api/auth/sign-in/social", json={"provider": "github", "callbackURL": "/"})
        started.raise_for_status()
        state = started.json()["url"].split("state=", 1)[1].split("&", 1)[0]
        callback = http.get(f"/api/auth/callback/github?code={quote(login)}&state={state}", headers={"cookie": "; ".join(cookies(started))})
    session = next((pair for pair in cookies(callback) if pair.startswith("better-auth.session_token=")), None)
    if session is None:
        raise RuntimeError(f"the sign-in callback set no session cookie (HTTP {callback.status_code}, {callback.headers.get('location')})")
    return session.split("=", 1)[1]


@contextmanager
def rush_server(extra_users: tuple[str, ...] = ()) -> Iterator[RushServer]:
    """``extra_users`` are more members the fake GitHub knows: they sign in as ``<name>-<database suffix>``."""
    reason = unavailable()
    if reason:
        raise RuntimeError(reason)
    suffix = secrets.token_hex(6)
    database = f"bench_smoke_{suffix}"
    port = free_port()
    origin = f"http://127.0.0.1:{port}"
    login = f"alice-{suffix}"
    github_id = 2_300_000_000 + int(suffix[:5], 16)
    users = [
        {"id": github_id + offset, "login": name, "name": name, "email": f"{name}@bench-{suffix}.invalid", "verified": True}
        for offset, name in enumerate((login, f"root-{suffix}", *(f"{extra}-{suffix}" for extra in extra_users)))
    ]
    stub = HTTPServer(("127.0.0.1", 0), StubNanoAgent)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    psql("postgres", f"create database {database}")
    server: subprocess.Popen[str] | None = None
    logs: list[str] = []
    try:
        env = {
            **{name: value for name, value in os.environ.items() if not name.startswith(("DATABASE_", "PG"))},
            "DATABASE_URL": f"postgres://{RUNTIME}@127.0.0.1:{PORT}/{database}",
            "DATABASE_MIGRATION_URL": f"postgres://{OWNER}@127.0.0.1:{PORT}/{database}",
            "NODE_ENV": "test",
            "OPENROUTER_MANAGEMENT_KEY": "acceptance-unused",
            "NODE_OPTIONS": f"--import={FAKE_GITHUB}",
            "FAKE_GITHUB_USERS": json.dumps(users),
            "GITHUB_CLIENT_ID": "acceptance-client",
            "GITHUB_CLIENT_SECRET": "acceptance-secret",
            "ROOT_GITHUB_LOGIN": f"root-{suffix}",
            "NANOAGENT_URL": f"http://127.0.0.1:{stub.server_address[1]}",
            "EDITOR_PORT": str(port),
            "BETTER_AUTH_URL": origin,
            "BETTER_AUTH_SECRET": f"bench-{suffix}".ljust(48, "x"),
        }
        server = subprocess.Popen(
            [shutil.which("node") or "node", "src/server/index.js"],
            cwd=HELPINGHANDS,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        threading.Thread(target=lambda: logs.extend(server.stdout or []), daemon=True).start()
        deadline = time.monotonic() + 60
        while True:
            if server.poll() is not None:
                raise RuntimeError("the server exited before it was ready:\n" + "".join(logs))
            try:
                if httpx.get(f"{origin}/api/health").status_code == 200:
                    break
            except httpx.TransportError:
                pass
            if time.monotonic() > deadline:
                raise RuntimeError("the server was not ready within 60 seconds:\n" + "".join(logs))
            time.sleep(0.2)
        psql(database, "update platform_policy set signup_mode = 'open', max_workspaces_per_user = 5")
        token = sign_in(origin, login)
        user_id = psql(database, f"select user_id from auth_account where provider_id = 'github' and account_id = '{github_id}'")
        with httpx.Client(base_url=origin, headers={"authorization": f"Bearer {token}", "origin": origin, "x-real-ip": "203.0.113.7"}) as http:
            created = http.post("/api/workspaces", json={"name": "Smoke", "slug": f"smoke-{suffix}"})
            created.raise_for_status()
        rush = RushServer(origin, created.json()["workspace"]["id"], token, user_id, database, logs, worker_credential(origin, token))
        # A worker serving the acceptance endpoint label has advertised before any member previews; real workers refresh it at each claim.
        for label in ("mock", "mock-a", "mock-b"):
            rush.advertise(label, internet_access=False)
        yield rush
    finally:
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
        stub.shutdown()
        psql("postgres", f"drop database if exists {database} with (force)")
