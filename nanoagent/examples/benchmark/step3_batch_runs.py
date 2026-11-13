"""Step 3: a batch of step 2's single runs, every harness on every case of every plugin task, side by side.

The cases are every cases file (step1_<name>_cases.json) in the `cases` folder, one plugin task each.
Each run is step 2 in a process of its own, started from step 2's config with its cases file, case
and harness (and any overrides) set, in its own folder, <plugin>/<task>/<case>/<harness>, its output
in <plugin>/<task>/<case>/<harness>.log. The runs share the machine fairly: each gets `cpus_per_run`
cores, and as many run at once as the machine has cores for, up to `max_parallel` (so the plugins'
data sources are not asked too much at once); the rest wait for a free place. The runs go round-robin
by plugin, so those going at once are of different plugins. `plugins` limits the batch to some plugins. Where the OS pins
processes to cores (Linux), each run is held to its own. Each run records the CPU time it used (step 2's cpu_seconds),
which shows whether runs still competed. The npx packages the runs start are fetched once before
them, so no run times a download and no two runs download one package at once.

A batch resumes: run again into the same folder, it skips every run whose folder holds a result and
starts again, from an empty folder, every run that has none. A run that fails keeps its result and
counts as wrong; a run that writes no result fails the batch, once every other run has ended."""

import os
import queue
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run, Workspace, load_output

from step2_coding_environment import coding_environment, fetch_npm, npm_package_cache
from step2_single_run import Cases, Harness, logged

SINGLE_RUN = Path(__file__).with_name("step2_single_run.py")


@dataclass
class BatchConfig(Config):
    # Step 2's config, which every run starts from, and overrides of it for every run (e.g. model=...).
    single_run: str = MISSING
    overrides: list[str] = MISSING
    # The folder of cases files: every step1_<name>_cases.json in it is one plugin task of the batch.
    cases: str = MISSING
    # How many of each task's cases to answer, and of those to refuse, from the first, are run.
    answer: int = MISSING
    refuse: int = MISSING
    harnesses: list[Harness] = MISSING
    # The plugins to run, each with a cases file in `cases` (for a trial); empty runs every plugin.
    plugins: list[str] = MISSING
    # Cores each run gets.
    cpus_per_run: int = MISSING
    # The most runs that go at once.
    max_parallel: int = MISSING
    # npx packages the runs start (as the harnesses table names them), fetched once before the runs.
    packages: list[str] = MISSING


@dataclass
class BatchRun(Output):
    plugin: str
    task: str
    case: str
    harness: str
    # Step 2's exit status (0 when the harness neither failed nor erred), and the run's seconds.
    status: int
    seconds: float


@dataclass
class Batch(Output):
    # How many runs ran at once, how many were skipped as a former batch had finished them, and each
    # run this batch started.
    side_by_side: int
    skipped: int
    runs: list[BatchRun]


@dataclass
class BatchLayout(Layout):
    batch: Batch
    # Each run's folder, <plugin>/<task>/<case>/<harness>, and its output, <plugin>/<task>/<case>/<harness>.log.
    runs: Workspace


def case_ids(config: BatchConfig, cases: Cases) -> list[str]:
    for kind, inputs, count in (("answer", cases.answer, config.answer), ("refuse", cases.refuse, config.refuse)):
        if not 0 <= count <= len(inputs):
            raise ValueError(f"{cases.plugin} has {len(inputs)} cases to {kind}: {kind} must be 0 to {len(inputs)}, not {count}")
    numbers = [*range(1, config.answer + 1), *range(len(cases.answer) + 1, len(cases.answer) + config.refuse + 1)]
    return [f"{cases.plugin}-{number:02d}" for number in numbers]


def interleaved(jobs: list[tuple[Path, Cases, str, Harness]]) -> list[tuple[Path, Cases, str, Harness]]:
    """The jobs round-robin by plugin, so the runs going at once are of different plugins and no
    plugin's data source is asked by all its runs together."""
    by_plugin: dict[str, list] = {}
    for job in jobs:
        by_plugin.setdefault(job[1].plugin, []).append(job)
    rounds = max((len(own) for own in by_plugin.values()), default=0)
    return [own[i] for i in range(rounds) for own in by_plugin.values() if i < len(own)]


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
        if config.max_parallel < 1:
            raise ValueError(f"max_parallel must be at least 1, not {config.max_parallel}")
        tasks: dict[tuple[str, str], Path] = {}
        jobs = []
        for path in sorted(Path(config.cases).glob("step1_*_cases.json")):
            cases = load_output(str(path), Cases)
            if config.plugins and cases.plugin not in config.plugins:
                continue
            if (cases.plugin, cases.task) in tasks:
                raise ValueError(f"{path} and {tasks[cases.plugin, cases.task]} are both {cases.plugin}'s task {cases.task}")
            tasks[cases.plugin, cases.task] = path
            jobs += [(path, cases, case, harness) for case in case_ids(config, cases) for harness in config.harnesses]
        unknown = set(config.plugins) - {plugin for plugin, _ in tasks}
        if unknown:
            raise ValueError(f"no cases file in {config.cases} for {', '.join(sorted(unknown))}")
        if not jobs:
            raise ValueError(f"the batch has no runs: no cases files in {config.cases}, no cases or no harnesses")
        folder = Path(self.layout.runs).resolve()
        left = [job for job in jobs if not (folder / job[1].plugin / job[1].task / job[2] / job[3].value / "result.json").is_file()]
        skipped, jobs = len(jobs) - len(left), interleaved(left)
        for package in config.packages:
            cache = npm_package_cache(folder, package)
            cache.mkdir(parents=True, exist_ok=True)
            with coding_environment(cache, credential_names=set()) as (prefix, env):
                env["npm_config_cache"] = str(cache)
                fetch_npm(package, prefix, env, cwd=cache)
        side_by_side = max(1, min(len(jobs), cores // config.cpus_per_run, config.max_parallel))
        # Each place a run can take: its cores.
        places: queue.Queue[set[int]] = queue.Queue()
        for place in range(side_by_side):
            start = place * config.cpus_per_run
            places.put(set(allowed_cpus[start : start + config.cpus_per_run]))
        print(
            f"{len(jobs)} runs ({skipped} finished before), {side_by_side} at once, {config.cpus_per_run} cores each{'' if pinned else ' (this OS does not pin processes to cores)'}"
        )

        def run(job: tuple[Path, Cases, str, Harness]) -> BatchRun:
            path, cases, case, harness = job
            home = folder / cases.plugin / cases.task / case / harness.value
            # A run that wrote no result starts again from an empty folder.
            shutil.rmtree(home, ignore_errors=True)
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
                            f"cases={path.resolve()}",
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
            print(f"{harness.value} · {cases.task} · {case}: {'done' if done.returncode == 0 else f'status {done.returncode}'} in {seconds:.0f}s")
            return BatchRun(plugin=cases.plugin, task=cases.task, case=case, harness=harness.value, status=done.returncode, seconds=seconds)

        with ThreadPoolExecutor(side_by_side) as pool:
            runs = list(pool.map(run, jobs))
        self.layout.batch = Batch(side_by_side=side_by_side, skipped=skipped, runs=runs)
        missing = [
            f"{run.plugin}/{run.task}/{run.case}/{run.harness}"
            for run in runs
            if not (folder / run.plugin / run.task / run.case / run.harness / "result.json").is_file()
        ]
        if missing:
            raise RuntimeError(f"no result from {', '.join(missing)}: see each run's .log in {folder}")


if __name__ == "__main__":
    BatchRuns().run()
