"""Step 3: the report, from the run folders step 2 wrote (each <plugin>/<task>/<case>/<harness>, step
1's layout): by harness, how many cases it got right and RUSH's dashboard figures averaged over its
runs; the same for every plugin task; and every run's own line."""

from dataclasses import dataclass
from pathlib import Path

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run, load_layout

from step1_single_run import SingleRunLayout, logged

FIGURES = ("latency_seconds", "model_seconds", "tools_seconds", "overhead_seconds", "input_tokens", "output_tokens", "cost", "cpu_seconds")


@dataclass
class ReportConfig(Config):
    # Step 2's folder of runs.
    runs: str = MISSING


@dataclass
class RunLine(Output):
    plugin: str
    task: str
    case: str
    harness: str
    correct: bool
    verdict: str
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
class ReportLayout(Layout):
    report: Report


def by_harness(runs: list[RunLine]) -> list[HarnessLine]:
    lines = []
    for harness in sorted({run.harness for run in runs}):
        own = [run for run in runs if run.harness == harness]
        means = {name: sum(getattr(run, name) for run in own) / len(own) for name in FIGURES}
        lines.append(HarnessLine(harness=harness, runs=len(own), correct=sum(run.correct for run in own), **means))
    return lines


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
            raise RuntimeError(f"{self.config.runs} holds no runs of step 1")
        runs = []
        for folder in folders:
            result = load_layout(folder, SingleRunLayout).result
            runs.append(
                RunLine(
                    plugin=result.plugin,
                    task=result.task,
                    case=result.case,
                    harness=result.harness,
                    correct=result.correct,
                    verdict=result.verdict,
                    **{name: getattr(result, name) for name in FIGURES},
                )
            )
        harnesses = by_harness(runs)
        tasks = [
            TaskLine(plugin=plugin, task=task, harnesses=by_harness([run for run in runs if (run.plugin, run.task) == (plugin, task)]))
            for plugin, task in sorted({(run.plugin, run.task) for run in runs})
        ]
        self.layout.report = Report(harnesses=harnesses, tasks=tasks, runs=runs)
        print(
            f"{'harness':<10} {'right':>6} {'latency':>8} {'model':>7} {'tools':>7} {'overhead':>8} {'input':>9} {'output':>7} {'cost':>8} {'cpu':>6}"
        )
        for line in harnesses:
            print(
                f"{line.harness:<10} {f'{line.correct}/{line.runs}':>6} {line.latency_seconds:>7.1f}s {line.model_seconds:>6.1f}s"
                f" {line.tools_seconds:>6.1f}s {line.overhead_seconds:>7.1f}s {line.input_tokens:>9,.0f} {line.output_tokens:>7,.0f}"
                f" ${line.cost:>7.4f} {line.cpu_seconds:>5.1f}s"
            )
        for line in tasks:
            print(f"{line.plugin} · {line.task}: " + ", ".join(f"{own.harness} {own.correct}/{own.runs}" for own in line.harnesses))
        for run in runs:
            if not run.correct:
                print(f"{run.harness} · {run.task} · {run.case}: wrong · {run.verdict}")


if __name__ == "__main__":
    GetReport().run()
