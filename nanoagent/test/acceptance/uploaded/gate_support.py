"""Shared pieces of the acceptance gates: a worker for the probe-behaviors harness, benchmark publishing through step 1,
submitting through step 2 under either participant policy, and reading every member-visible response of a run."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from typing import Any

import support
from slimconfig import load_layout
from rush_server import worker_credential
from support import Cli, Worker

NANOAGENT = support.NANOAGENT
BEHAVIORS = Path(__file__).resolve().parent / "harnesses" / "probe_behaviors"
sys.path[:0] = [str(NANOAGENT / "examples" / "uploaded_benchmark"), str(NANOAGENT / "examples" / "benchmark")]

import step1_publish_benchmark  # noqa: E402
import step2_submit_run  # noqa: E402


def behaviors_source(destination: Path) -> Path:
    shutil.copytree(BEHAVIORS, destination)
    return support.stamp(destination)


def start_worker(name: str, base_url: str, cli: Cli, run_dir: Path, *, upstream: str, index: int, egress: bool = False, models: tuple[str, ...] = ()) -> Worker:
    """The real worker in the worker container, reaching the host's RUSH server, scripted upstream and (empty) dependency index."""
    config = run_dir / f"{name}.yaml"
    worker = Worker(name, config, cli.logs / f"{name}-worker.log", credential=worker_credential(cli.base_url, cli.token))
    config.write_text(
        support.worker_yaml(
            base_url=f"http://{support.HOST}:{base_url.rsplit(':', 1)[1]}",
            upstream=upstream.replace("127.0.0.1", support.HOST),
            index=f"http://{support.HOST}:{index}/simple",
            scratch=f"{worker.home}/scratch",
            egress=egress,
            models=models,
        )
    )
    worker.start()
    return worker


def cases_file(path: Path, plugin: str, answers: list[str], refusals: list[str], context: str = "Synthetic.", task: str = "probe") -> list[str]:
    """Write a step-1 cases file for the probe task (answers first, then refusals) and return the case ids in order."""
    arguments = lambda token: {"token": token, "wait_seconds": 0}  # noqa: E731
    path.write_text(
        json.dumps(
            {
                "_": "step2_single_run.Cases",
                "plugin": plugin,
                "task": task,
                "context": context,
                "answer": [arguments(token) for token in answers],
                "refuse": [{"arguments": arguments(token), "reference_error": "has no digest"} for token in refusals],
            }
        )
    )
    return [f"{plugin}-{number:02d}" for number in range(1, len(answers) + len(refusals) + 1)]


def publish_benchmark(cli: Cli, home: Path, *, check: bool = True, **options: Any) -> Any:
    """Step 1 as the member under ``options`` (see support.publish_args): the published benchmark's report (the CLI's benchmark.json),
    or the failed process when ``check`` is off."""
    done = cli.step("1", "publish_benchmark", home, *support.publish_args(**options), check=check)
    if not check:
        return done
    return load_layout(home, step1_publish_benchmark.PublishLayout).benchmark


def submit(cli: Cli, home: Path, benchmark: str, *, plugin: str, key: str, source: Path | None, check: bool = True, **options: Any) -> Any:
    """Step 2 (submit) of ``source`` to ``benchmark`` of ``plugin`` under ``options`` (see support.submit_args): the run's report, or
    the failed process when ``check`` is off."""
    done = cli.step("2", "submit_run", home, *support.submit_args(benchmark, plugin=plugin, key=key, source=source, **options), check=check)
    if not check:
        return done
    return load_layout(home, step2_submit_run.RunLayout).run
