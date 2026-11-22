"""The CLI acceptance stack: a real RUSH server on a scratch PostgreSQL with the acceptance-probe plugin installed, the real worker
on this machine (microsandbox VMs, gateway, process recorder), the scripted OpenRouter upstream behind ONE URL (`mockllm`'s `Router`)
and the CLIs' mocked npm and PyPI. Tests drive the CLI steps as subprocesses (`support.Cli`) and read what RUSH recorded.

    with stack("test_case_session") as s:
        s.script(KEY, "nanoagent", scenario)                 # what the agent is told by the model for the case holding KEY
        benchmark = s.publish("probe", PROBE_CASES)           # step 1
        runs = s.submit("probe", ["nanoagent"], "run-1")      # step 2
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import io
import json
import os
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import support
import zstandard
from microsandbox import Sandbox
from registries import shell_registry
from support import FINAL, HOST, MODEL, SCRATCH, Cli, Worker

NANOAGENT = support.NANOAGENT
sys.path[:0] = [
    str(NANOAGENT / "test" / "uploaded"),
    str(NANOAGENT / "test" / "acceptance" / "benchmark"),
    str(NANOAGENT / "examples" / "uploaded_benchmark"),
]

from mockllm import MockProvider, Scenario, Turn, Usage  # noqa: E402
from mockllm.engine import Generation, Run  # noqa: E402
from mockllm.server import Router  # noqa: E402
from rush_server import HELPINGHANDS, RushServer, free_port, psql, rush_server, sign_in, unavailable, worker_credential  # noqa: E402

from nanoagent.plugin.package import pack  # noqa: E402
from nanoagent.uploaded.client import BenchmarkClient  # noqa: E402

PROBE = NANOAGENT / "test" / "plugins" / "acceptance-probe"
CASES = NANOAGENT / "test" / "acceptance" / "benchmark" / "cases"
PROBE_CASES = CASES / "probe_cases.yaml"
AB_CASES = CASES / "ab_report_cases.yaml"
# One case each of AB_CASES (a run is always a whole suite, so a test that needs one case publishes a benchmark of only it): the B-wins case,
# the A-wins case and the refusal case. Each case file numbers its own case acceptance-probe-01.
AB_B_CASES = CASES / "ab_b_wins_cases.yaml"
AB_A_CASES = CASES / "ab_a_wins_cases.yaml"
AB_REFUSAL_CASES = CASES / "ab_refusal_cases.yaml"
PLUGIN = "acceptance-probe"
# One worker scratch for every test module: the CLIs it installs (from the mocked registries, the first time) are kept, as a member's
# worker keeps them, so a module does not rebuild what the one before it did.
WORKER_SCRATCH = SCRATCH / "shared-scratch"
REGISTRY = SCRATCH / "shell-registry"
HARNESSES = ("claude", "codex", "pi", "dsh", "hermes", "nanoagent")
# The endpoint profile of the worker RUSH Lab runs (helpinghands' routes/benchmark.js SESSION_ENDPOINT), which a Terminal session runs on.
SESSION_ENDPOINT = "openrouter"
# The one model a real OpenRouter call may use.
OPENROUTER_MODEL = "deepseek/deepseek-v4-flash-0731"


def skip_reason() -> str | None:
    return unavailable() or support.container_unavailable()


@dataclass
class Stack:
    rush: RushServer
    cli: Cli
    client: BenchmarkClient
    mock: MockProvider
    router: Router
    worker: Worker
    run_dir: Path
    logs: Path
    model: str = MODEL

    def script(self, key: str, harness: str, scenario: Scenario, refs: dict[str, Any] | None = None) -> Run:
        """The run of ``harness`` on the case whose prompt holds ``key``: its scenario, with its own ledger (`.ledger`)."""
        return self.router.set(key, harness, scenario, refs)

    def home(self, name: str) -> Path:
        path = self.run_dir / f"{name}-{uuid.uuid4().hex[:6]}"
        return path

    def publish(self, name: str, cases: Path, *, version: str = "0.1.0", limits: dict[str, Any] | None = None, plugin: str = PLUGIN, check: bool = True) -> Any:
        """Step 1: the benchmark ``name`` of the case file ``cases``, with these limit overrides (internet access off: the acceptance worker has
        none). The step's benchmark.json (`created`, `benchmark`, `publication`), or the failed process when ``check`` is off."""
        overrides = [f"cases={cases}", f"name={name}", f"plugin_version={version}"]
        for limit, value in {"internet_access": False, **(limits or {})}.items():
            overrides.append(f"limits.{limit}={json.dumps(value)}")
        home = self.home(f"step1-{name}")
        done = self.cli.step("1", "publish_benchmark", home, *overrides, check=check)
        return support.json_of(home / "benchmark.json") if check else done

    def submit(self, benchmark: str, harnesses: list[str], key: str, *, plugin: str = PLUGIN, version: str = "0.1.0",
               follow_timeout: int = 2400, check: bool = True, cli: Cli | None = None, follow: bool = True) -> Any:
        """Step 2: one run per harness on the benchmark, followed to the end. Its runs.json (`runs`), or the failed process."""
        overrides = [f"plugin={plugin}", f"plugin_version={version}", f"benchmark={benchmark}", f"harnesses=[{','.join(harnesses)}]",
                     f"idempotency_key={key}", f"follow={json.dumps(follow)}", f"follow_timeout={follow_timeout}"]  # fmt: skip
        home = self.home(f"step2-{key}")
        done = (cli or self.cli).step("2", "submit_run", home, *overrides, check=check)
        return support.json_of(home / "runs.json")["runs"] if check else done

    def trace(self, attempt_id: str, *overrides: str) -> dict[str, Any]:
        """Step 3's trace.json of the attempt."""
        home = self.home("step3")
        self.cli.step("3", "trace", home, f"attempt_id={attempt_id}", *overrides)
        return support.json_of(home / "trace.json")

    def table(self, benchmark: str, *, plugin: str = PLUGIN, version: str = "0.1.0", as_json: bool = False, cli: Cli | None = None) -> tuple[Any, dict[str, Any]]:
        """Step 5's table of the member's own runs: what it printed (its text, or with ``as_json`` the parsed JSON), and the table.json it kept."""
        home = self.home("step5")
        done = (cli or self.cli).step("5", "results", home, f"plugin={plugin}", f"plugin_version={version}", f"benchmark={benchmark}", f"as_json={json.dumps(as_json)}")
        return (json.loads(done.stdout) if as_json else done.stdout), support.json_of(home / "table.json")

    def compare(self, benchmark: str, a: str, b: str, *, case: str | None = None, plugin: str = PLUGIN, version: str = "0.1.0", cli: Cli | None = None) -> dict[str, Any]:
        """Step 4's comparison.json of two harnesses (and their attempts at ``case``)."""
        home = self.home("step4")
        overrides = [f"plugin={plugin}", f"plugin_version={version}", f"benchmark={benchmark}", f"harness_a={a}", f"harness_b={b}"]
        if case is not None:
            overrides.append(f"case={case}")
        (cli or self.cli).step("4", "compare", home, *overrides)
        return support.json_of(home / "comparison.json")

    def attempt(self, attempt_id: str) -> dict[str, Any]:
        return self.client.attempt(attempt_id)

    def events(self, attempt_id: str) -> list[dict[str, Any]]:
        return self.client.events(attempt_id).events

    def get(self, path: str) -> httpx.Response:
        """A member API read the CLI client has no method for: ``path`` under the workspace's benchmark prefix."""
        return httpx.get(
            f"{self.rush.base_url}/api/workspaces/{self.rush.workspace_id}/benchmark/{path}",
            headers={"authorization": f"Bearer {self.rush.token}"}, timeout=60,
        )  # fmt: skip

    def recording(self, attempt_id: str) -> str:
        """What the attempt's first terminal wrote (the member's terminal recording, `GET /attempts/{id}/recording`), as text."""
        response = self.get(f"attempts/{attempt_id}/recording")
        assert response.status_code == 200, response.text
        [terminal] = [each for each in response.json()["terminals"] if each["terminal"] == 0]
        return base64.b64decode(terminal["data"]).decode(errors="replace")

    def workspace(self, attempt_id: str) -> dict[str, bytes]:
        """The files the worker uploaded for the attempt (its `workspace` archive, a tar.zst RUSH streams to its member), by path."""
        shown = self.attempt(attempt_id)["workspace"]
        assert shown is not None and "error" not in shown, shown
        response = httpx.get(f"{self.rush.base_url}/api/traces/workspaces/{attempt_id}", headers={"authorization": f"Bearer {self.rush.token}"}, timeout=120)
        assert response.status_code == 200, response.text
        assert len(response.content) == shown["bytes"], (len(response.content), shown)
        with tarfile.open(fileobj=io.BytesIO(zstandard.ZstdDecompressor().stream_reader(io.BytesIO(response.content)).read()), mode="r:") as tar:
            return {member.name.removeprefix("./"): tar.extractfile(member).read() for member in tar if member.isfile()}  # type: ignore[union-attr]

    def row(self, sql: str) -> str:
        """One value of this server's scratch database, for what no API returns (the stored `chats`, `workspace`)."""
        return psql(self.rush.database, f"begin;\nselect set_config('app.benchmark_system', 'on', true) as system \\gset\n{sql};\ncommit;")


def openrouter_key() -> str | None:
    """OPENROUTER_API_KEY from NanoAgent's .env (never printed), or None when it holds none."""
    env = NANOAGENT / ".env"
    if not env.is_file():
        return None
    for line in env.read_text().splitlines():
        name, _, value = line.strip().removeprefix("export ").partition("=")
        if name.strip() == "OPENROUTER_API_KEY" and value.strip().strip("'\""):
            return value.strip().strip("'\"")
    return None


def openrouter_skip_reason() -> str | None:
    """Why the real OpenRouter run is skipped, or None: it runs only with RUSH_ACCEPTANCE_OPENROUTER=1 and a key in NanoAgent's .env."""
    if os.environ.get("RUSH_ACCEPTANCE_OPENROUTER") != "1":
        return "the real OpenRouter run is opt-in: RUSH_ACCEPTANCE_OPENROUTER=1"
    if openrouter_key() is None:
        return f"no OPENROUTER_API_KEY in {NANOAGENT / '.env'}"
    return skip_reason()


@contextmanager
def computer(rush: RushServer, folder: Path, logs: Path) -> Iterator[None]:
    """The member's computer connected to RUSH as RUSH Lab connects it (helpinghands' runner/lab.mjs startConnection): NanoAgent's web
    app on loopback behind a bearer token (lab.mjs nanoagentCommand), and the relay beside it (runner/relay.mjs) signed in with the
    member's session token, dialing the server's /api/runner. Yields once RUSH says the computer is connected."""
    folder.mkdir(parents=True)
    (folder / "files").mkdir()
    credentials = folder / "runner-credentials.json"
    credentials.write_text(json.dumps({"site": rush.base_url, "token": rush.token}) + "\n")
    credentials.chmod(0o600)
    token, port = secrets.token_hex(32), free_port()
    python = str(NANOAGENT / ".venv" / "bin" / "python")
    system = {name: os.environ[name] for name in ("HOME", "PATH", "TMPDIR", "LANG", "USER") if name in os.environ}
    nanoagent = subprocess.Popen(
        [python, "-I", "-m", "nanoagent", "web", "web_cfg=deploy/railway/nanoagent.yaml", "host=127.0.0.1", f"port={port}",
         f"sandbox={'seatbelt' if sys.platform == 'darwin' else 'bwrap'}", "run_models=true", "include_reasoning=true",
         f"workspaces={json.dumps(str(folder / 'agent-workspaces'))}", f"installs={json.dumps(str(folder / 'nanoagent-installs'))}",
         f"uv_cache={json.dumps(str(SCRATCH / 'nanoagent-uv-cache'))}", f"plugin_python={json.dumps(python)}"],
        cwd=NANOAGENT, env={**system, "NANOAGENT_API_TOKEN": token}, stdout=(logs / "nanoagent.log").open("wb"), stderr=subprocess.STDOUT,
    )  # fmt: skip
    relay: subprocess.Popen[bytes] | None = None
    try:

        def nanoagent_up() -> bool:
            assert nanoagent.poll() is None, f"NanoAgent exited ({nanoagent.returncode}):\n{(logs / 'nanoagent.log').read_text()[-3000:]}"
            try:
                return httpx.get(f"http://127.0.0.1:{port}/health", headers={"authorization": f"Bearer {token}"}, timeout=5).status_code == 200
            except httpx.TransportError:
                return False

        wait_until(nanoagent_up, "NanoAgent's web app", 120)
        relay = subprocess.Popen(
            [shutil.which("node") or "node", "relay.mjs"], cwd=HELPINGHANDS / "src" / "runner",
            env={**system, "MOCHI_SITE_URL": rush.base_url, "NANOAGENT_URL": f"http://127.0.0.1:{port}", "NANOAGENT_API_TOKEN": token,
                 "RUNNER_CREDENTIALS": str(credentials), "RUNNER_DEVICE": "acceptance", "RUNNER_KEYS": "[]", "RUNNER_FILES": str(folder / "files")},
            stdin=subprocess.PIPE, stdout=(logs / "relay.log").open("wb"), stderr=subprocess.STDOUT,
        )  # fmt: skip

        def connected() -> bool:
            assert relay is not None and relay.poll() is None, f"the relay exited:\n{(logs / 'relay.log').read_text()[-3000:]}"
            status = httpx.get(f"{rush.base_url}/api/runner/status", headers={"authorization": f"Bearer {rush.token}", "origin": rush.base_url}, timeout=10)
            return status.status_code == 200 and status.json()["connected"]

        wait_until(connected, "the member's computer to connect", 60)
        yield
    finally:
        for process in (relay, nanoagent):
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


@contextmanager
def stack(module: str, *, concurrency: int | None = None, extra_users: tuple[str, ...] = (), model: str = MODEL, worker: bool = True,
          entry: tuple[str, ...] = ("-m", "nanoagent.uploaded.worker"), member_computer: bool = False, openrouter: bool = False) -> Iterator[Stack]:
    """The whole stack for one test module; everything it keeps goes under ``outputs/uploaded_acceptance/final/<module>/``. Without
    ``worker`` there is no worker (the module only publishes and reads). With ``member_computer`` the member's computer is connected
    (`computer`), as RUSH Lab connects it, which a Terminal session needs, and the worker and every benchmark are on RUSH Lab's endpoint
    label (SESSION_ENDPOINT), which a session runs on. With ``openrouter`` the worker calls real OpenRouter (worker.openrouter.yaml's
    endpoint, the key in NanoAgent's .env) on OPENROUTER_MODEL alone, and the scripted upstream goes unused."""
    if openrouter:
        model = OPENROUTER_MODEL
    label = SESSION_ENDPOINT if member_computer else "mock"
    logs = FINAL / module
    logs.mkdir(parents=True, exist_ok=True)
    run_dir = SCRATCH / f"{module}-{uuid.uuid4().hex[:8]}"
    run_dir.mkdir(parents=True)
    if worker:
        shell_registry(REGISTRY)
        WORKER_SCRATCH.mkdir(parents=True, exist_ok=True)
    with (
        rush_server(extra_users, endpoint=label, model=model) as rush,
        support.serve_directory(REGISTRY if worker else run_dir) as registry_port,
        MockProvider() as mock,
    ):
        rush.seed_plugin(pack(PROBE))
        cli = Cli(rush.base_url, rush.workspace_id, rush.token, logs, rush.user_id)
        upstream, router = mock.register_router(model)
        config = run_dir / "worker.yaml"
        key = {"OPENROUTER_API_KEY": openrouter_key() or ""} if openrouter else None
        process = Worker(module, config, logs / "worker.log", credential=worker_credential(rush.base_url, rush.token), entry=entry, env=key)
        config.write_text(
            support.worker_yaml(
                base_url=f"http://{HOST}:{rush.base_url.rsplit(':', 1)[1]}",
                upstream=upstream.replace("127.0.0.1", HOST),
                index=f"http://{HOST}:{registry_port}/pypi/simple",
                npm=f"http://{HOST}:{registry_port}/npm",
                scratch=str(WORKER_SCRATCH),
                concurrency=concurrency,
                label=label,
                openrouter=openrouter,
                terminal=member_computer,
            )
        )
        if worker:
            process.start()
        if worker and member_computer:
            # The server took the label's capabilities from a stand-in claim (rush_server); a session needs the worker's own.
            wait_until(lambda: psql(rush.database, f"select exists(select 1 from benchmark_worker_capability where endpoint_label = '{label}' and worker_id <> 'smoke')") == "t",
                       f"the worker's claim on {label}", 600)  # fmt: skip
        client = BenchmarkClient(rush.base_url, rush.workspace_id, rush.token)
        with computer(rush, run_dir / "computer", logs) if member_computer else contextlib.nullcontext():
            try:
                yield Stack(rush, cli, client, mock, router, process, run_dir, logs, model)
            finally:
                if worker:
                    process.stop()
                violations = mock.violations + [v for run in router.members.values() for v in run.ledger.violations]
                (logs / "mock-violations.json").write_text(json.dumps(violations, indent=1))


def attempt_containers(attempt: str) -> list[str]:
    """The names of the sandboxes still labelled as ``attempt``'s."""

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


def join_workspace(rush: RushServer, name: str) -> Cli:
    """A second member (``name`` is one of the server's ``extra_users``) of alice's workspace, with the probe plugin installed: its CLI."""
    token = sign_in(rush.base_url, f"{name}-{rush.database.removeprefix('bench_smoke_')}")
    response = httpx.get(f"{rush.base_url}/api/auth/get-session", headers={"Authorization": f"Bearer {token}", "origin": rush.base_url}, timeout=30)
    response.raise_for_status()
    user_id = response.json()["user"]["id"]
    psql(rush.database, f"insert into workspace_member (id, workspace_id, user_id, role) values (gen_random_uuid()::text, '{rush.workspace_id}', '{user_id}', 'viewer')")
    psql(rush.database, f"insert into user_plugin (user_id, plugin_id, source) values ('{user_id}', '{PLUGIN}', 'upload')")
    return Cli(rush.base_url, rush.workspace_id, token, FINAL / "members" / name, user_id)


# -- scripted scenarios ---------------------------------------------------------------------------------------------------

PROMPT_TOKENS, COMPLETION_TOKENS = 100, 10
# The acceptance worker's prices (support.worker_yaml): USD per token.
INPUT_PRICE, OUTPUT_PRICE = 0.000001, 0.000004
# A fragment of each case's prompt that no other case's request holds: what the router tells the cases apart by.
B_WINS, A_WINS, MISSING = "inputs/ab_Beauty.csv", "inputs/ab_Clothing.csv", "inputs/ab_Missing.csv"
ALPHA, BETA, REFUSE_ME = "token alpha:", "token beta:", "token refuse-me:"
BUCKET, LOG_ENTRY = "promo-assets-for-b", "AB_Test_Concluded: winner A, no change"
FIXTURES = {"b_wins": CASES / "fixtures" / "b_wins", "a_wins": CASES / "fixtures" / "a_wins"}


# What the gateway settles for a call (OpenRouter's generation record): every scripted call, main or side, uses the same tokens, so every
# call costs what the worker's prices make of them.
CALL_COST = PROMPT_TOKENS * INPUT_PRICE + COMPLETION_TOKENS * OUTPUT_PRICE


def scenario(*turns: Turn, name: str = "scripted", generation: Generation | None = None) -> Scenario:
    return Scenario(
        name=name, turns=list(turns), side_usage=Usage(prompt=PROMPT_TOKENS, completion=COMPLETION_TOKENS),
        generation=generation or Generation(lookup=True, cost=CALL_COST),
    )  # fmt: skip


def turn(act: Any = None, *, text: str = "", repeat: int = 1, status: int | None = None) -> Turn:
    return Turn(act=act, text=text, repeat=repeat, status=status, usage=Usage(prompt=PROMPT_TOKENS, completion=COMPLETION_TOKENS))


def script_of(*acts: Any, generation: Generation | None = None) -> Scenario:
    """One turn of these acts (the agent's tool calls), then the closing text every agent ends on."""
    return scenario(turn(list(acts)), turn(text="done", repeat=0), generation=generation)


def ab_oracle(fixture: str) -> dict[str, Any]:
    """This test's own ground truth for an `ab-report` case, computed from the fixture's CSV files with `csv` alone: each scenario that has
    rows with its rates, the winner and the cloud state before."""
    import csv

    folder = FIXTURES[fixture] / "inputs"
    rates, empty = [], []
    for path in sorted(folder.glob("ab_*.csv")):
        rows = list(csv.DictReader(path.open()))
        name = path.stem.removeprefix("ab_")
        if not rows:
            empty.append(name)
            continue
        total = {column: sum(int(row[column]) for row in rows) for column in ("A_visits", "A_conversions", "B_visits", "B_conversions")}
        rates.append({"scenario": name, "a_percent": 100 * total["A_conversions"] / total["A_visits"], "b_percent": 100 * total["B_conversions"] / total["B_visits"]})
    mean_a, mean_b = (sum(rate[key] for rate in rates) / len(rates) for key in ("a_percent", "b_percent"))
    return {"rates": rates, "empty": empty, "winner": "B" if mean_b > mean_a else "A", "cloud": json.loads((folder / "cloud.json").read_text())}


def ab_acts(fixture: str, *, record: bool | str = True, shift: float = 0.0, trap: bool = False, cloud: str = "right", edit_csv: str | None = None,
            extra_file: str | None = None, answer: Any = "record") -> list[Any]:
    """The acts of an agent that works an `ab-report` case: write `record.json`, change `inputs/cloud.json`, and write `answer.json`.
    Each argument spoils one thing: ``record`` False leaves the file out, a string is its text; ``shift`` moves every A rate; ``trap`` also
    reports the empty scenario; ``cloud`` is `right` or `wrong` (the other winner's rule) or `untouched`; ``edit_csv`` appends a row to that
    fixture file, ``extra_file`` writes one more file; ``answer`` is `record` (the answer) or a refusal reason."""
    truth = ab_oracle(fixture)
    acts: list[Any] = []
    if record:
        scenarios = [{**rate, "a_percent": rate["a_percent"] + shift} for rate in truth["rates"]]
        scenarios += [{"scenario": name, "a_percent": 0, "b_percent": 0} for name in truth["empty"] if trap]
        text = record if isinstance(record, str) else json.dumps({"scenarios": scenarios, "winner": truth["winner"]})
        acts.append({"write": {"path": "record.json", "text": text}})
    if cloud != "untouched":
        bucket_rule = (truth["winner"] == "B") == (cloud == "right")  # B's rule adds a bucket; the other appends the log entry
        state = {"buckets": list(truth["cloud"]["buckets"]), "logs": list(truth["cloud"]["logs"])}
        state["buckets" if bucket_rule else "logs"].append(f"{BUCKET}-acceptance" if bucket_rule else LOG_ENTRY)
        acts.append({"write": {"path": "inputs/cloud.json", "text": json.dumps(state)}})
    if edit_csv:
        acts.append({"append": {"path": edit_csv, "text": "7/29 09:00-09:59,1,1,1,1\n"}})
    if extra_file:
        acts.append({"write": {"path": extra_file, "text": "extra"}})
    acts.append({"write": {"path": "answer.json", "text": json.dumps({"record": "record.json"} if answer == "record" else {"refused": answer})}})
    return acts


def user_texts(request: Any) -> list[str]:
    """Every text block of the request's user messages, in order (a CLI may put its own reminders in blocks beside the prompt)."""
    texts: list[str] = []
    for message in request.messages:
        if isinstance(message, dict) and message.get("role") == "user":
            content = message["content"]
            texts += [content] if isinstance(content, str) else [block["text"] for block in content if isinstance(block, dict) and "text" in block]
    return texts


def digest_acts(token: str) -> list[Any]:
    """The acts of an agent that answers a `probe` case: the token's digest in `answer.json`."""

    return [{"answer": {"digest": hashlib.sha256(token.encode()).hexdigest()[:12]}}]
