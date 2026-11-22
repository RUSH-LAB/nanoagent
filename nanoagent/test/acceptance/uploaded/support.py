"""Pieces of the CLI acceptance tests: the CLI steps as subprocesses and the real worker running on this machine.

Hosts and ports: the RUSH server, the scripted OpenRouter upstream and the dependency registry all listen on this machine's
loopback, where the worker reaches them. Each worker is this Python running `nanoagent.uploaded.worker`; its sandboxes are
microVMs (microsandbox), so the machine needs what microsandbox needs: Apple silicon, or Linux with /dev/kvm.
"""

from __future__ import annotations

import http.server
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any


NANOAGENT = Path(__file__).resolve().parents[3]
SCRATCH = NANOAGENT / "build" / "uploaded_acceptance"
OUTPUTS = NANOAGENT / "outputs" / "uploaded_acceptance"
# Everything a run of this suite keeps (logs, step outputs, traces, comparisons, worker logs): one folder per module, never emptied.
FINAL = OUTPUTS / "final"
WORKER_HOME = SCRATCH / "workers"
# The worker's guest tools (static strace, uv), built once and kept between runs.
GUEST_TOOLS = NANOAGENT / "build" / "guest-tools"
HOST = "127.0.0.1"
MODEL = "test/model"


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


# -- the worker in the container --------------------------------------------------------------------------------------


def container_unavailable() -> str | None:
    """Why the worker's sandboxes cannot run here, or None: microsandbox boots microVMs with Apple's Hypervisor framework
    (Apple silicon) or KVM (Linux)."""
    if sys.platform == "darwin":
        return None if platform.machine() == "arm64" else "microsandbox needs a Mac with Apple silicon"
    if sys.platform.startswith("linux"):
        return None if os.access("/dev/kvm", os.R_OK | os.W_OK) else "microsandbox needs /dev/kvm"
    return f"the acceptance suite does not run on {sys.platform}"


def worker_yaml(
    *, base_url: str, upstream: str, index: str, scratch: str, npm: str | None = None, concurrency: int | None = None, egress: bool = False,
    models: tuple[str, ...] = (), label: str = "mock", openrouter: bool = False, terminal: bool = False,
) -> str:
    """deploy/worker/worker.mock.yaml with this run's endpoints; ``egress`` turns on internet access for harnesses (the worker then
    advertises it and proves its fence at startup); ``models`` are priced beside ``test/model``, at its rates (the worker advertises
    every model it prices, and the server refuses a benchmark for any other); ``index`` and ``npm`` are the registries `python-3` and
    `javascript-22` installs read (``npm`` keeps the YAML's own when omitted); ``concurrency`` replaces the YAML's. ``label`` is the
    endpoint profile it claims on; ``openrouter`` takes the endpoint and prices of deploy/worker/worker.openrouter.yaml instead (real
    OpenRouter with OPENROUTER_API_KEY, its one priced model), ``upstream`` and ``models`` then unused. ``terminal`` gives what a
    Terminal session's limits ask (helpinghands' TERMINAL_LIMITS): the builds' time and output of worker.openrouter.yaml, and egress."""
    text = (NANOAGENT / "deploy" / "worker" / "worker.mock.yaml").read_text()
    for old, new in (
        ("scratch: ???", f"scratch: {scratch}"),
        ("base_url: http://127.0.0.1:3000", f"base_url: {base_url}"),
        ("upstream_base_url: http://127.0.0.1:8080/api/v1", f"upstream_base_url: {upstream}"),
        ("mock_hosts: [127.0.0.1]", f"mock_hosts: [{HOST}]"),
        ("  index_urls:\n", f"  index_urls:\n    python-3: {index}\n"),
        *((("javascript-22: https://registry.npmjs.org", f"javascript-22: {npm}"),) if npm else ()),
        *((("  concurrency: 4", f"  concurrency: {concurrency}"),) if concurrency else ()),
        *((("  build_wall_s: 600\n", "  build_wall_s: 1800\n  build_output_bytes: 4294967296\n"),) if terminal else ()),
        ("  test/model:\n    input: 0.000001\n    output: 0.000004\n", "".join(f"  {model}:\n    input: 0.000001\n    output: 0.000004\n" for model in (MODEL, *models))),
    ):
        assert old in text, old
        text = text.replace(old, new)
    text = text.replace("  label: mock\n", f"  label: {label}\n")
    if openrouter:
        real = (NANOAGENT / "deploy" / "worker" / "worker.openrouter.yaml").read_text()
        endpoint = real[real.index("openrouter > ") : real.index("timing > ")]
        text = text[: text.index("openrouter > ")] + endpoint.replace("  label: openrouter\n", f"  label: {label}\n") + text[text.index("timing > ") :]
    return text + ("\negress > nanoagent.uploaded.worker.EgressConfig:\n  enabled: true\n  model_hosts: [api.openai.com]\n" if egress or terminal else "")


class Worker:
    """`python -m nanoagent.uploaded.worker` (or a launcher) on this machine, its log streamed to ``log``. It claims for the member
    ``credential`` was minted for (rush_server.worker_credential). Its scratch, and so its guest tools, are its own unless the
    YAML points them elsewhere; the guest tools are linked in from GUEST_TOOLS so they are built once."""

    def __init__(
        self, name: str, config: Path, log: Path, *, credential: str, entry: tuple[str, ...] = ("-m", "nanoagent.uploaded.worker"), env: dict[str, str] | None = None,
        tools: Path = GUEST_TOOLS,
    ) -> None:
        self.name, self.config, self.log, self.entry, self.tools = name, config, log, entry, tools
        self.env = {"RUSH_WORKER_TOKEN": credential, "OPENROUTER_API_KEY": "synthetic-acceptance-key", **(env or {})}
        self.home = str(WORKER_HOME / name)
        self.process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        shutil.rmtree(self.home, ignore_errors=True)
        (Path(self.home) / "scratch").mkdir(parents=True)
        self.tools.mkdir(parents=True, exist_ok=True)
        (Path(self.home) / "scratch" / "guest-tools").symlink_to(self.tools, target_is_directory=True)
        self.log.parent.mkdir(parents=True, exist_ok=True)
        # Values reach the process through its environment, never its command line.
        self.process = subprocess.Popen(
            [sys.executable, *self.entry, f"config={self.config}", f"home={self.home}/run"],
            cwd=NANOAGENT, env={**os.environ, **self.env}, stdout=self.log.open("wb"), stderr=subprocess.STDOUT,
        )

    @property
    def pid(self) -> int:
        assert self.process is not None
        return self.process.pid

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
        """Ctrl-C the worker, wait for it to exit and return its status."""
        if self.process is None:
            return None
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGINT)
            try:
                self.process.wait(timeout=90)
            except subprocess.TimeoutExpired:
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
