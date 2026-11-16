"""Runs of the scripted-loop harness (`harnesses/metrics_loop`) against one scripted upstream, for the metrics, comparison and
reopen gates: one RUSH server, one worker in the worker container, and runs submitted one after the other through the CLI so each consumes
the next turns of the one scenario."""

from __future__ import annotations

import json
import shutil
import sys
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import support
from support import REFERENCE, Cli, Worker

NANOAGENT = support.NANOAGENT
sys.path[:0] = [
    str(NANOAGENT / "test" / "uploaded"),
    str(NANOAGENT / "test" / "acceptance" / "benchmark"),
    str(NANOAGENT / "examples" / "uploaded_benchmark"),
    str(NANOAGENT / "examples" / "benchmark"),
]

import step2_submit_run  # noqa: E402
import step3_trace  # noqa: E402
from mockllm import MockProvider, RunHandle, Scenario, Turn, Usage  # noqa: E402
from mockllm.engine import Generation, Stream  # noqa: E402
from rush_server import RushServer, worker_credential  # noqa: E402
from slimconfig import load_layout  # noqa: E402

LOOP = Path(__file__).resolve().parent / "harnesses" / "metrics_loop"
SOCKET = "/run/rush-gvisor/seccheck.sock"
DIALECTS = ("chat_completions", "responses", "anthropic_messages")
ANSWER = {"answer": {"digest": REFERENCE}}


def turn(*, act: Any = None, prompt: int = 100, completion: int = 10, cached: int = 0, cache_write: int = 0, reasoning: int = 0, ttfb: float = 0.05,
         chunks: int = 2, gap: float = 0.02, **fields: Any) -> Turn:
    """One scripted model turn; `usage` is the whole-call usage in the mock's vocabulary (prompt includes the cache parts)."""
    return Turn(ttfb=ttfb, stream=Stream(chunks=chunks, gap=gap), text="ok", act=act, usage=Usage(prompt, cached, completion, reasoning, cache_write), **fields)


def source(script: dict[str, Any], destination: Path) -> Path:
    """The loop harness with this `script.json`, declaring the script's dialect (the manifest's, not the run's) and the version of its content."""
    shutil.copytree(LOOP, destination)
    (destination / "script.json").write_text(json.dumps(script))
    return support.stamp(destination, dialects=[script["dialect"]])


@dataclass
class Session:
    rush: RushServer
    cli: Cli
    run_dir: Path
    handle: RunHandle
    worker: Worker
    suite: str
    provider: MockProvider
    index: int
    rate: float
    tolerance_ns: int
    upstream_open: bool = True

    def close_upstream(self) -> None:
        """Shut the scripted upstream down (nothing listens on its address afterwards); a second call does nothing."""
        if self.upstream_open:
            self.upstream_open = False
            self.provider.__exit__(None, None, None)

    def restart_worker(self, name: str) -> Worker:
        """Stop the worker and start a new one (a new home) against the same upstream address, which may be closed by now."""
        self.worker.stop()
        self.worker = start_worker(self.rush, self.cli, self.run_dir, name, upstream=self.handle.base_url, index=self.index, rate=self.rate, tolerance_ns=self.tolerance_ns)
        return self.worker

    def publish(self, name: str, **options: Any) -> str:
        """Step 1: the session's one-case benchmark under another name and run configuration (see support.publish_args); its name."""
        self.cli.step("1", "publish_benchmark", self.run_dir / f"step1-{name}", *support.publish_args(name=name, cases=self.run_dir / "cases.json", **options))
        return name

    def submit(self, name: str, script: dict[str, Any], *, follow: bool = True, benchmark: str | None = None) -> Any:
        """Step 2 with the loop harness under `script` and the task tools policy, on the session's benchmark unless ``benchmark`` is another;
        the run's report. The run's dialect is the script's, declared by the harness manifest."""
        folder = source(script, self.run_dir / f"source-{name}")
        home = self.run_dir / f"step2-{name}"
        self.cli.step(
            "2", "submit_run", home,
            *support.submit_args(benchmark or self.suite, plugin="acceptance-probe", key=f"{benchmark or self.suite}-{name}", source=folder, follow=follow, follow_timeout=900),
        )
        return load_layout(home, step2_submit_run.RunLayout).run

    def rerun(self, name: str, run: Any) -> Any:
        """Step 2 rerun: a new attempt of the run's case, with the run's own source and prompt."""
        home = self.run_dir / f"step2-{name}"
        self.cli.step("2", "submit_run", home, "action=rerun", f"run_id={run.run_id}", f"case_id={run.attempts[0].case_id}", "policy=task_tools", "follow=true", "follow_timeout=900")
        return load_layout(home, step2_submit_run.RunLayout).run

    def rush_run(self, run: Any) -> dict[str, Any]:
        """The member API's view of a run the CLI reported."""
        from nanoagent.uploaded.client import BenchmarkClient

        return BenchmarkClient(self.rush.base_url, self.rush.workspace_id, self.rush.token).run(run.run_id)

    def trace(self, attempt: str, name: str, *payloads: str, extra: tuple[str, ...] = ()) -> Any:
        home = self.run_dir / f"trace-{name}"
        self.cli.step("3", "trace", home, f"attempt_id={attempt}", *([f"payloads=[{','.join(payloads)}]"] if payloads else []), *extra)
        return load_layout(home, step3_trace.TraceLayout).trace


def worker_yaml(text: str, *, rate: float, tolerance_ns: int) -> str:
    for old, new in (
        ("reference_tokens_per_second: 100", f"reference_tokens_per_second: {rate}"),
        ("clock_tolerance_ns: 1000000", f"clock_tolerance_ns: {tolerance_ns}"),
    ):
        assert old in text, old
        text = text.replace(old, new)
    return text


def start_worker(
    rush: RushServer, cli: Cli, run_dir: Path, name: str, *, upstream: str, index: int, rate: float, tolerance_ns: int,
    entry: tuple[str, ...] = ("-m", "nanoagent.uploaded.worker"),
) -> Worker:
    """The real worker in the worker container, reaching the host's RUSH server, scripted upstream and dependency index as host.docker.internal."""
    config = run_dir / f"{name}.yaml"
    worker = Worker(name, config, cli.logs / f"{name}-worker.log", credential=worker_credential(cli.base_url, cli.token), entry=entry)
    config.write_text(
        worker_yaml(
            support.worker_yaml(
                base_url=f"http://{support.HOST}:{rush.base_url.rsplit(':', 1)[1]}",
                upstream=upstream.replace("127.0.0.1", support.HOST),
                index=f"http://{support.HOST}:{index}/simple",
                socket=SOCKET,
                scratch=f"{worker.home}/scratch",
            ),
            rate=rate,
            tolerance_ns=tolerance_ns,
        )
    )
    worker.start()
    return worker


@contextmanager
def session(
    rush: RushServer, name: str, turns: list[Turn], *, rate: float = 100, tolerance_ns: int = 100_000_000, run_dir: Path | None = None,
    generation: Generation | None = None, entry: tuple[str, ...] = ("-m", "nanoagent.uploaded.worker"),
) -> Iterator[Session]:
    """A worker (reference rate and clock tolerance from its YAML) serving a scripted upstream with `turns`, and the probe benchmark."""
    run_dir = run_dir or support.SCRATCH / f"{name}-{uuid.uuid4().hex[:8]}"
    run_dir.mkdir(parents=True, exist_ok=True)
    cli = Cli(rush.base_url, rush.workspace_id, rush.token, support.FINAL / "metrics-compare-reopen" / run_dir.name, rush.user_id)
    cases = json.loads((NANOAGENT / "test" / "acceptance" / "benchmark" / "cases" / "probe_cases.json").read_text())
    cases |= {"answer": cases["answer"][:1], "refuse": []}
    suite = f"loop-{name}"
    (run_dir / "cases.json").write_text(json.dumps(cases))
    cli.step("1", "publish_benchmark", run_dir / f"step1-{suite}", *support.publish_args(name=suite, cases=run_dir / "cases.json"))
    (run_dir / "registry").mkdir(exist_ok=True)
    with support.serve_directory(run_dir / "registry") as index:
        provider = MockProvider().__enter__()
        handle = provider.register(Scenario(name=name, turns=turns, **({} if generation is None else {"generation": generation})), harness="nanoagent", model=support.MODEL, refs={"reference": REFERENCE})
        worker = start_worker(rush, cli, run_dir, name, upstream=handle.base_url, index=index, rate=rate, tolerance_ns=tolerance_ns, entry=entry)
        sess = Session(rush, cli, run_dir, handle, worker, suite, provider, index, rate, tolerance_ns)
        try:
            yield sess
        finally:
            sess.worker.stop()
            sess.close_upstream()
