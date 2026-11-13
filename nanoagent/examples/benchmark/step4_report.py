"""Step 4: the report, from the run folders step 3 wrote (each <plugin>/<task>/<case>/<harness>, step
2's layout): by harness, how many cases it got right and RUSH's dashboard figures averaged over its
runs; the same for every plugin task; and every run's own line. Runs of a plugin step 1 marked as having
a bug are left out. It writes them to report.json, and to page/, a static web app (index.html, its data in data/)
that browses every run: the tables, filterable and sortable, and for each plugin its case and each
harness's answer, verdict, figures and trajectory; it also lists, for review, every plugin task each
coding harness that ran got wrong, and the plugins step 1 marked as having a bug."""

import os
import shutil
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Folder, Layout, Output, Run, load_layout, load_output, plain_output, write_output

from step1_make_cases import PluginBugs
from step2_single_run import SingleRunLayout, logged

# The harness with the plugin's tools; every other harness is a coding harness.
PLUGIN_HARNESS = "nanoagent"
# The web app's page, copied into the run's page folder.
APP = Path(__file__).with_name("step4_report.html")
# A plugin file's strings are cut to this many characters, and the file must stay under MOST_BYTES.
LONGEST = 20_000
MOST_BYTES = 2_000_000
# What a plugin file leaves out of each result.json.
DROPPED = ("profile", "timeline")
FIGURES = ("latency_seconds", "model_seconds", "tools_seconds", "overhead_seconds", "input_tokens", "output_tokens", "cost", "cpu_seconds")


@dataclass
class ReportConfig(Config):
    # Step 3's folder of runs.
    runs: str = MISSING
    # Step 1's bugs file: the plugins marked as having a bug, with their reasons.
    bugs: str = MISSING


@dataclass
class RunLine(Output):
    plugin: str
    task: str
    case: str
    harness: str
    correct: bool
    verdict: str
    # Whether the harness failed to finish (timed out or erred) rather than answered.
    failed: bool
    latency_seconds: float
    model_seconds: float
    tools_seconds: float
    overhead_seconds: float
    input_tokens: int
    output_tokens: int
    cost: float
    cpu_seconds: float


@dataclass
class HarnessLine(Output):
    harness: str
    runs: int
    correct: int
    # The runs the harness failed to finish (timed out or erred), all wrong.
    errors: int
    # Each figure averaged over the harness's runs.
    latency_seconds: float
    model_seconds: float
    tools_seconds: float
    overhead_seconds: float
    input_tokens: float
    output_tokens: float
    cost: float
    cpu_seconds: float


@dataclass
class TaskLine(Output):
    # One plugin task, and its runs by harness.
    plugin: str
    task: str
    harnesses: list[HarnessLine]


@dataclass
class Report(Output):
    harnesses: list[HarnessLine]
    tasks: list[TaskLine]
    runs: list[RunLine]


@dataclass
class Summary(Output):
    # page/data/summary.json: the report with each verdict cut to 300 characters, and step 1's bugs.
    report: Report
    bugs: list[Any]


@dataclass
class PluginRun(Output):
    # One run: its result.json but its profile and timeline (the trajectory shows those steps), and its
    # messages.json, as JSON, long strings cut (see clipped).
    result: Any
    messages: Any


@dataclass
class PluginFile(Output):
    # page/data/plugins/<plugin>.json: every run of the plugin, opened by the app when it shows the plugin.
    plugin: str
    runs: list[PluginRun]


@dataclass
class ReportLayout(Layout):
    report: Report
    # The web app: index.html, which reads data/summary.json and data/plugins/<plugin>.json.
    page: Folder


def by_harness(runs: list[RunLine]) -> list[HarnessLine]:
    lines = []
    for harness in sorted({run.harness for run in runs}):
        own = [run for run in runs if run.harness == harness]
        means = {name: sum(getattr(run, name) for run in own) / len(own) for name in FIGURES}
        lines.append(HarnessLine(harness=harness, runs=len(own), correct=sum(run.correct for run in own), errors=sum(run.failed for run in own), **means))
    return lines


def coding_failed(runs: list[RunLine]) -> dict[tuple[str, str], list[RunLine]]:
    """Each plugin task that coding harnesses ran and every such run got wrong, with those runs."""
    coding: dict[tuple[str, str], list[RunLine]] = {}
    for run in runs:
        if run.harness != PLUGIN_HARNESS:
            coding.setdefault((run.plugin, run.task), []).append(run)
    return {key: own for key, own in sorted(coding.items()) if not any(run.correct for run in own)}


def clipped(value: Any) -> Any:
    """A JSON value with every string longer than LONGEST cut short, marked with how much was cut."""
    if isinstance(value, str) and len(value) > LONGEST:
        return f"{value[:LONGEST]}… [{len(value) - LONGEST:,} more characters cut]"
    if isinstance(value, dict):
        return {key: clipped(item) for key, item in value.items()}
    if isinstance(value, list):
        return [clipped(item) for item in value]
    return value


class GetReport(Run):
    """Read every run and sum it up by harness, overall and for every plugin task."""

    config: ReportConfig
    layout: ReportLayout

    def main(self) -> None:
        with logged():
            self.work()

    def work(self) -> None:
        folders = sorted(path.parent for path in Path(self.config.runs).glob("*/*/*/*/result.json"))
        if not folders:
            raise RuntimeError(f"{self.config.runs} holds no runs of step 2")
        bugs = load_output(self.config.bugs, PluginBugs)
        buggy = {bug["plugin"] for bug in bugs.plugins}
        runs = []
        plugin_runs: dict[str, list[PluginRun]] = {}
        for folder in folders:
            run_layout = load_layout(folder, SingleRunLayout)
            result = run_layout.result
            if result.plugin in buggy:
                continue
            plugin_runs.setdefault(result.plugin, []).append(
                PluginRun(
                    result=clipped({key: value for key, value in plain_output(result).items() if key not in DROPPED}),
                    messages=clipped(plain_output(run_layout.messages)),
                )
            )
            runs.append(
                RunLine(
                    plugin=result.plugin,
                    task=result.task,
                    case=result.case,
                    harness=result.harness,
                    correct=result.correct,
                    verdict=result.verdict,
                    failed=result.stop_reason in {"timeout", "error"},
                    **{name: getattr(result, name) for name in FIGURES},
                )
            )
        harnesses = by_harness(runs)
        tasks = [
            TaskLine(plugin=plugin, task=task, harnesses=by_harness([run for run in runs if (run.plugin, run.task) == (plugin, task)]))
            for plugin, task in sorted({(run.plugin, run.task) for run in runs})
        ]
        self.layout.report = Report(harnesses=harnesses, tasks=tasks, runs=runs)
        data = Path(self.layout.page) / "data"
        (data / "plugins").mkdir(parents=True)
        shown = [replace(run, verdict=run.verdict[:300]) for run in runs]
        write_output(str(data / "summary.json"), Summary(report=replace(self.layout.report, runs=shown), bugs=bugs.plugins))
        for plugin, own in plugin_runs.items():
            path = data / "plugins" / f"{plugin}.json"
            write_output(str(path), PluginFile(plugin=plugin, runs=own))
            if os.path.getsize(path) >= MOST_BYTES:
                raise RuntimeError(f"{path} is {os.path.getsize(path):,} bytes, over the {MOST_BYTES:,} a plugin file may hold")
        index = Path(self.layout.page) / "index.html"
        shutil.copyfile(APP, index)
        print(
            f"{'harness':<10} {'right':>6} {'errors':>6} {'latency':>8} {'model':>7} {'tools':>7} {'overhead':>8} {'input':>9} {'output':>7} {'cost':>8} {'cpu':>6}"
        )
        for line in harnesses:
            print(
                f"{line.harness:<10} {f'{line.correct}/{line.runs}':>6} {line.errors:>6} {line.latency_seconds:>7.1f}s {line.model_seconds:>6.1f}s"
                f" {line.tools_seconds:>6.1f}s {line.overhead_seconds:>7.1f}s {line.input_tokens:>9,.0f} {line.output_tokens:>7,.0f}"
                f" ${line.cost:>7.4f} {line.cpu_seconds:>5.1f}s"
            )
        for line in tasks:
            print(f"{line.plugin} · {line.task}: " + ", ".join(f"{own.harness} {own.correct}/{own.runs}" for own in line.harnesses))
        for run in runs:
            if not run.correct:
                print(f"{run.harness} · {run.task} · {run.case}: wrong · {run.verdict}")
        for (plugin, task), own in coding_failed(runs).items():
            print(f"every coding harness failed · {plugin} · {task}: " + "; ".join(f"{run.harness}: {run.verdict[:200]}" for run in own))
        print(f"{len(plugin_runs)} plugin files; the app: {index.resolve()}")


if __name__ == "__main__":
    GetReport().run()
