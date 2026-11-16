"""Pieces of the uploaded-harness CLI acceptance tests: the pinned NanoAgent source, the mocked dependency registry, the
CLI steps as subprocesses and the real worker running in the Linux VM.

Hosts and ports: the RUSH server, the scripted OpenRouter upstream and the dependency index all listen on the macOS host's
loopback; the VM reaches them as `host.lima.internal`. The worker, its gVisor sandboxes and the process collector run in the
VM (`limactl shell gvisor-dev`). The checkout, and so everything under `build/`, is mounted read-only at the same path there.
"""

from __future__ import annotations

import hashlib
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any

from packaging.utils import canonicalize_name

NANOAGENT = Path(__file__).resolve().parents[3]
FIXTURE = Path(__file__).resolve().parent / "harnesses" / "nanoagent_core"
SCENARIOS = Path(__file__).resolve().parent / "scenarios"
SCRATCH = NANOAGENT / "build" / "uploaded_acceptance"
OUTPUTS = NANOAGENT / "outputs" / "uploaded_acceptance"
# Everything a run of this suite keeps (logs, step outputs, traces, comparisons, worker logs): one folder per module, never emptied.
FINAL = OUTPUTS / "final"
VM = "gvisor-dev"
HOST = "host.lima.internal"
MODEL = "test/model"
# What the plugin's reference tool and the scripted answer both compute for the probe's first case.
TOKEN = "alpha"
REFERENCE = hashlib.sha256(TOKEN.encode()).hexdigest()[:12]
# The vendored part of NanoAgent: the stdlib-only core agent loop and its profiler.
VENDORED = ("src/nanoagent/__init__.py", "src/nanoagent/core", "src/nanoagent/profiler")


def git(*args: str) -> bytes:
    return subprocess.run(["git", *args], cwd=NANOAGENT, check=True, capture_output=True).stdout


def pinned_revision() -> str:
    return git("rev-parse", "HEAD").decode().strip()


def build_source(destination: Path) -> str:
    """The uploaded project: the fixture plus NanoAgent's core as committed at HEAD (never the working tree). Returns the revision."""
    revision = pinned_revision()
    shutil.copytree(FIXTURE, destination)
    for name in git("ls-tree", "-r", "--name-only", revision, "--", *VENDORED).decode().split():
        target = destination / "nanoagent" / Path(name).relative_to("src/nanoagent")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git("show", f"{revision}:./{name}"))
    (destination / "NANOAGENT_REVISION").write_text(revision + "\n")
    return revision


# -- the mocked dependency registry ---------------------------------------------------------------------------------


def wheelhouse(requirements: Path, root: Path) -> Path:
    """A PEP 503 simple index under ``root`` holding exactly the wheels ``requirements`` pins (fetched once from PyPI, each checked
    against its pinned sha256). Returns the index root."""
    cache = SCRATCH / "wheel-cache"
    cache.mkdir(parents=True, exist_ok=True)
    (root / "files").mkdir(parents=True, exist_ok=True)
    for line in requirements.read_text().splitlines():
        match = re.match(r"^([A-Za-z0-9._-]+)==(\S+) --hash=sha256:([0-9a-f]{64})$", line.strip())
        if match is None:
            continue
        name, version, digest = match.groups()
        with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=60) as response:
            files = json.load(response)["urls"]
        wheel = next(f for f in files if f["digests"]["sha256"] == digest and f["filename"].endswith(".whl"))
        cached = cache / wheel["filename"]
        if not cached.exists() or hashlib.sha256(cached.read_bytes()).hexdigest() != digest:
            with urllib.request.urlopen(wheel["url"], timeout=120) as response:
                cached.write_bytes(response.read())
        assert hashlib.sha256(cached.read_bytes()).hexdigest() == digest, wheel["filename"]
        shutil.copyfile(cached, root / "files" / cached.name)
        page = root / "simple" / canonicalize_name(name)
        page.mkdir(parents=True, exist_ok=True)
        (page / "index.html").write_text(f'<html><body><a href="../../files/{cached.name}#sha256={digest}">{cached.name}</a></body></html>\n')
    return root


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args: Any) -> None:
        pass


@contextmanager
def serve_directory(root: Path) -> Iterator[int]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


# -- the CLI steps ----------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Cli:
    base_url: str
    workspace_id: str
    token: str
    logs: Path
    user_id: str = ""

    def step(self, number: str, name: str, home: Path, *overrides: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        """Run examples/uploaded_benchmark/step<number>_<name>.py with its YAML config in a process of its own."""
        done = subprocess.run(
            [
                str(NANOAGENT / ".venv" / "bin" / "python"),
                f"examples/uploaded_benchmark/step{number}_{name}.py",
                f"config=examples/uploaded_benchmark/configs/step{number}_{name}.yaml",
                f"home={home}",
                "--",
                f"server.base_url={self.base_url}",
                f"server.workspace_id={self.workspace_id}",
                *overrides,
            ],
            cwd=NANOAGENT,
            env={**os.environ, "RUSH_SESSION_TOKEN": self.token},
            capture_output=True,
            text=True,
            timeout=1800,
        )
        self.logs.mkdir(parents=True, exist_ok=True)
        (self.logs / f"{home.name}.log").write_text(f"$ step{number}_{name} {' '.join(overrides)}\n{done.stdout}\n--- stderr\n{done.stderr}")
        # Keep what the step wrote (run.json, case_set.json, trace.json, comparison.json, payloads) beside its log: build/ is scratch.
        if home.is_dir():
            shutil.copytree(home, self.logs / home.name, dirs_exist_ok=True)
        if check:
            assert done.returncode == 0, done.stdout + done.stderr
        return done


# -- the worker in the VM -----------------------------------------------------------------------------------------------


def vm(*command: str, timeout: float = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["limactl", "shell", VM, "--", *command], capture_output=True, text=True, timeout=timeout)


def vm_available() -> str | None:
    if shutil.which("limactl") is None:
        return "limactl is not installed"
    done = vm("true", timeout=60)
    return None if done.returncode == 0 else f"the Lima VM {VM} is not running: {done.stderr.strip()}"


def worker_yaml(*, base_url: str, upstream: str, index: str, socket: str, scratch: str, egress: bool = False, models: tuple[str, ...] = ()) -> str:
    """deploy/gvisor/worker.mock.yaml with this run's endpoints; ``egress`` turns on internet access for harnesses (the worker then
    advertises it and proves the host filter of deploy/gvisor/egress.sh at startup); ``models`` are priced beside ``test/model``, at its
    rates (the worker advertises every model it prices, and the server refuses a benchmark for any other)."""
    text = (NANOAGENT / "deploy" / "gvisor" / "worker.mock.yaml").read_text()
    for old, new in (
        ("scratch: /home/worker/rush-worker/scratch/attempts", f"scratch: {scratch}"),
        ("base_url: http://127.0.0.1:3000", f"base_url: {base_url}"),
        ("upstream_base_url: http://openrouter-mock:8080/api/v1", f"upstream_base_url: {upstream}"),
        ("mock_hosts: [openrouter-mock]", f"mock_hosts: [{HOST}]"),
        ("socket: /run/rush-gvisor/seccheck.sock", f"socket: {socket}"),
        ("python-3: /home/worker/rush-worker/wheels", f"python-3: {index}"),
        ("  test/model:\n    input: 0.000001\n    output: 0.000004\n", "".join(f"  {model}:\n    input: 0.000001\n    output: 0.000004\n" for model in (MODEL, *models))),
    ):
        assert old in text, old
        text = text.replace(old, new)
    return text + ("\negress > nanoagent.uploaded.worker.EgressConfig:\n  enabled: true\n" if egress else "")


class VmWorker:
    """`python -m nanoagent.uploaded.worker` (or a launcher) in the VM, its log streamed to ``log`` on the host."""

    def __init__(self, name: str, config: Path, log: Path, *, entry: tuple[str, ...] = ("-m", "nanoagent.uploaded.worker"), env: dict[str, str] | None = None) -> None:
        self.name, self.config, self.log, self.entry = name, config, log, entry
        self.env = {"BENCHMARK_WORKER_TOKEN": "worker-acceptance-token", "RUSH_BENCHMARK_MOCK_API_KEY": "synthetic-acceptance-key", **(env or {})}
        home = vm("bash", "-c", "echo /home/$(id -un).guest/rush-worker").stdout.strip()
        self.vm_home = f"{home}/acceptance/{name}"
        self.pidfile = f"{self.vm_home}/worker.pid"
        self.process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        assert vm("bash", "-c", f"rm -rf {self.vm_home} && mkdir -p {self.vm_home}").returncode == 0
        self.log.parent.mkdir(parents=True, exist_ok=True)
        env = " ".join(f"{key}={value}" for key, value in {**self.env, "RUSH_WORKER_PIDFILE": self.pidfile}.items())
        script = NANOAGENT / "deploy" / "gvisor" / "vm-worker.sh"
        self.process = subprocess.Popen(
            ["limactl", "shell", VM, "--", "env", *env.split(), "bash", str(script), *self.entry, f"config={self.config}", f"home={self.vm_home}/run"],
            stdout=self.log.open("wb"),
            stderr=subprocess.STDOUT,
        )

    def text(self) -> str:
        return self.log.read_text(errors="replace")

    def wait_for(self, needle: str, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while needle not in self.text():
            assert self.process is not None
            if self.process.poll() is not None and needle not in self.text():
                raise AssertionError(f"the worker exited ({self.process.returncode}) before logging {needle!r}:\n{self.text()}")
            assert time.monotonic() < deadline, f"no {needle!r} in the worker log after {timeout:g}s:\n{self.text()}"
            time.sleep(0.5)

    def stop(self) -> int | None:
        """Ctrl-C the worker (so it stops its collector), wait for it to exit and return its status."""
        if self.process is None:
            return None
        if self.process.poll() is None:
            vm("bash", "-c", f"kill -INT $(cat {self.pidfile}) 2>/dev/null || true")
            try:
                self.process.wait(timeout=90)
            except subprocess.TimeoutExpired:
                vm("bash", "-c", f"kill -KILL $(cat {self.pidfile}) 2>/dev/null || true")
                self.process.kill()
                self.process.wait()
        return self.process.returncode

    def exit_code(self, timeout: float) -> int:
        assert self.process is not None
        return self.process.wait(timeout=timeout)


def json_of(path: Path) -> Any:
    return json.loads(path.read_text())


def python() -> str:
    return sys.executable


# -- the benchmark and the run through steps 1 and 2 -----------------------------------------------------------------


def stamp(folder: Path, *, dialects: list[str] | None = None) -> Path:
    """Make the harness version of the copied ``folder`` name its content (a version names one ZIP: another ZIP under it is refused),
    and set the dialects its manifest declares when given. Returns ``folder``."""
    manifest = folder / "harness.yaml"
    text = manifest.read_text()
    if dialects is not None:
        text = re.sub(r"^dialects:.*$", f"dialects: [{', '.join(dialects)}]", text, count=1, flags=re.MULTILINE)
    manifest.write_text(re.sub(r"^version:.*$", "version: stamp", text, count=1, flags=re.MULTILINE))
    content = hashlib.sha256()
    for path in sorted(entry for entry in folder.rglob("*") if entry.is_file()):
        content.update(path.relative_to(folder).as_posix().encode() + b"\0" + path.read_bytes())
    manifest.write_text(manifest.read_text().replace("version: stamp", f'version: "{content.hexdigest()[:12]}"'))
    return folder


def publish_args(
    *,
    name: str,
    cases: Path,
    plugin_version: str = "0.1.0",
    model: str = MODEL,
    endpoint: str = "mock",
    limits: dict[str, Any] | None = None,
    template: str | None = None,
    instructions: str | None = None,
) -> list[str]:
    """The step 1 overrides of a benchmark. Internet access is off unless ``limits`` says otherwise (the plain acceptance worker has
    no egress; a benchmark asking for it is refused as exceeding the worker)."""
    args = [f"cases={cases}", f"name={name}", f"plugin_version={plugin_version}", f"model={model}", f"endpoint_profile={endpoint}"]
    for limit, value in {"internet_access": False, **(limits or {})}.items():
        args.append(f"limits.{limit}={json.dumps(value)}")
    if template is not None:
        args.append(f"coding_template={json.dumps(template)}")
    if instructions is not None:
        args.append(f"task_instructions={json.dumps(instructions)}")
    return args


def submit_args(
    benchmark: str,
    *,
    plugin: str,
    key: str,
    source: Path | None = None,
    reference: str | None = None,
    plugin_version: str = "0.1.0",
    policy: str = "task_tools",
    follow: bool = True,
    follow_timeout: int = 1200,
    preview_id: str | None = None,
) -> list[str]:
    """The step 2 overrides of a submit of ``source`` to benchmark ``benchmark`` of ``plugin``: the benchmark fixes the rest."""
    args = [
        f"plugin={plugin}",
        f"plugin_version={plugin_version}",
        f"benchmark={benchmark}",
        f"policy={policy}",
        f"idempotency_key={key}",
        f"follow={'true' if follow else 'false'}",
        f"follow_timeout={follow_timeout}",
    ]
    if source is not None:
        args.append(f"source={source}")
    if reference is not None:
        args.append(f"reference={reference}")
    if preview_id is not None:
        args.append(f"preview_id={preview_id}")
    return args
