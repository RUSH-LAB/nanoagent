"""Step 2: a batch of step 1's single runs, every harness on every case, side by side.

Each run is step 1 in a process of its own, started from step 1's config with its case and harness
(and any overrides) set, in its own folder, <case>/<harness>, its output in <case>/<harness>.log.
The runs share the machine fairly: each gets `cpus_per_run` cores, so as many run at once as the
machine has cores for and the rest wait for a free place; where the OS pins processes to cores
(Linux), each run is held to its own. Each run records the CPU time it used (step 1's cpu_seconds),
which shows whether runs still competed. The npx packages the runs start are fetched once before
them, so no run times a download and no two runs download one package at once.

A run that fails keeps its result and counts as wrong; a run that writes no result fails the batch."""

import os
import queue
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run, Workspace

from step1_coding_environment import coding_environment, fetch_npm, npm_package_cache
from step1_single_run import Cases, Harness, logged

SINGLE_RUN = Path(__file__).with_name("step1_single_run.py")


@dataclass
class BatchConfig(Config):
    # Step 1's config, which every run starts from, and overrides of it for every run (e.g. model=...).
    single_run: str = MISSING
    overrides: list[str] = MISSING
    cases: Cases = MISSING
    # How many of the cases to answer, and of those to refuse, from the first, are run.
    answer: int = MISSING
    refuse: int = MISSING
    harnesses: list[Harness] = MISSING
    # Cores each run gets.
    cpus_per_run: int = MISSING
    # npx packages the runs start (as the harnesses table names them), fetched once before the runs.
    packages: list[str] = MISSING


@dataclass
class BatchRun(Output):
    case: str
    harness: str
    # Step 1's exit status (0 when the harness neither failed nor erred), and the run's seconds.
    status: int
    seconds: float


@dataclass
class Batch(Output):
    # How many runs ran at once, and each run.
    side_by_side: int
    runs: list[BatchRun]


@dataclass
class BatchLayout(Layout):
    batch: Batch
    # Each run's folder, <case>/<harness>, and its output, <case>/<harness>.log.
    runs: Workspace


def case_ids(config: BatchConfig) -> list[str]:
    cases = config.cases
    for kind, inputs, count in (("answer", cases.answer, config.answer), ("refuse", cases.refuse, config.refuse)):
        if not 0 <= count <= len(inputs):
            raise ValueError(f"{cases.plugin} has {len(inputs)} cases to {kind}: {kind} must be 0 to {len(inputs)}, not {count}")
    numbers = [*range(1, config.answer + 1), *range(len(cases.answer) + 1, len(cases.answer) + config.refuse + 1)]
    return [f"{cases.plugin}-{number:02d}" for number in numbers]


class BatchRuns(Run):
    """Run every harness on every case, side by side."""

    config: BatchConfig
    layout: BatchLayout

    def main(self) -> None:
        with logged():
            self.work()

    def work(self) -> None:
        config = self.config
        pinned = hasattr(os, "sched_getaffinity") and hasattr(os, "sched_setaffinity")
        allowed_cpus = sorted(os.sched_getaffinity(0)) if pinned else list(range(os.cpu_count() or 1))
        cores = len(allowed_cpus)
        if not 1 <= config.cpus_per_run <= cores:
            raise ValueError(f"cpus_per_run must be 1 to this machine's {cores} cores, not {config.cpus_per_run}")
        jobs = [(case, harness) for case in case_ids(config) for harness in config.harnesses]
        if not jobs:
            raise ValueError("the batch has no runs: no cases or no harnesses")
        folder = Path(self.layout.runs).resolve()
        for package in config.packages:
            cache = npm_package_cache(folder, package)
            cache.mkdir(parents=True)
            with coding_environment(cache, credential_names=set()) as (prefix, env):
                env["npm_config_cache"] = str(cache)
                fetch_npm(package, prefix, env, cwd=cache)
        side_by_side = min(len(jobs), cores // config.cpus_per_run)
        # Each place a run can take: its cores.
        places: queue.Queue[set[int]] = queue.Queue()
        for place in range(side_by_side):
            start = place * config.cpus_per_run
            places.put(set(allowed_cpus[start : start + config.cpus_per_run]))
        print(
            f"{len(jobs)} runs, {side_by_side} at once, {config.cpus_per_run} cores each{'' if pinned else ' (this OS does not pin processes to cores)'}"
        )

        def run(job: tuple[str, Harness]) -> BatchRun:
            case, harness = job
            home = folder / case / harness.value
            home.parent.mkdir(parents=True, exist_ok=True)
            place = places.get()
            started = time.monotonic()
            try:
                with open(home.parent / f"{harness.value}.log", "w", encoding="utf-8") as log:
                    done = subprocess.run(
                        [
                            sys.executable,
                            str(SINGLE_RUN),
                            f"config={config.single_run}",
                            f"home={home}",
                            "--",
                            f"case={case}",
                            f"harness={harness.value}",
                            *config.overrides,
                            f"batch_runs={folder.resolve()}",
                        ],
                        stdout=log,
                        stderr=subprocess.STDOUT,
                        preexec_fn=(lambda: os.sched_setaffinity(0, place)) if pinned else None,
                    )
            finally:
                places.put(place)
            seconds = time.monotonic() - started
            print(f"{harness.value} · {case}: {'done' if done.returncode == 0 else f'status {done.returncode}'} in {seconds:.0f}s")
            return BatchRun(case=case, harness=harness.value, status=done.returncode, seconds=seconds)

        with ThreadPoolExecutor(side_by_side) as pool:
            runs = list(pool.map(run, jobs))
        self.layout.batch = Batch(side_by_side=side_by_side, runs=runs)
        missing = [f"{run.case}/{run.harness}" for run in runs if not (folder / run.case / run.harness / "result.json").is_file()]
        if missing:
            raise RuntimeError(f"no result from {', '.join(missing)}: see each run's .log in {folder}")


if __name__ == "__main__":
    BatchRuns().run()
