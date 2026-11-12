"""Step 4: the report, from the run folders step 3 wrote (each <plugin>/<task>/<case>/<harness>, step
2's layout): by harness, how many cases it got right and RUSH's dashboard figures averaged over its
runs; the same for every plugin task; and every run's own line. It writes them to report.json, and to
page/report.html, one static page that also lists the plugins step 1 marked as having a bug."""

import html
from dataclasses import dataclass
from pathlib import Path

from omegaconf import MISSING
from slimconfig import Config, Folder, Layout, Output, Run, load_layout, load_output

from step1_make_cases import PluginBugs
from step2_single_run import SingleRunLayout, logged

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
    # report.html, the report as one static page.
    page: Folder


def by_harness(runs: list[RunLine]) -> list[HarnessLine]:
    lines = []
    for harness in sorted({run.harness for run in runs}):
        own = [run for run in runs if run.harness == harness]
        means = {name: sum(getattr(run, name) for run in own) / len(own) for name in FIGURES}
        lines.append(HarnessLine(harness=harness, runs=len(own), correct=sum(run.correct for run in own), **means))
    return lines


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness benchmark</title>
<style>
:root {{ color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #e3e3e6; --right: #1a7f37; --wrong: #c62828; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg: #161618; --fg: #ececee; --muted: #9a9aa0; --line: #2e2e33; --right: #4ac26b; --wrong: #ff7b72; }} }}
body {{ background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; max-width: 1100px; margin: 0 auto; padding: 24px 16px; }}
h1 {{ font-size: 1.5rem; margin: 0 0 4px; }}
h2 {{ font-size: 1.15rem; margin: 32px 0 8px; }}
p {{ color: var(--muted); margin: 0 0 8px; }}
.scroll {{ overflow-x: auto; }}
table {{ border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }}
th, td {{ padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }}
th:first-child, td:first-child {{ text-align: left; }}
th {{ color: var(--muted); font-weight: 600; }}
td.reason {{ text-align: left; white-space: normal; color: var(--muted); }}
.right {{ color: var(--right); }}
.wrong {{ color: var(--wrong); }}
</style>
</head>
<body>
<h1>Harness benchmark</h1>
<p>{runs} runs over {tasks} plugin tasks. Figures are means per run.</p>
<h2>By harness</h2>
<div class="scroll"><table>
<tr><th>Harness</th><th>Right</th><th>Latency</th><th>Model</th><th>Tools</th><th>Overhead</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th><th>CPU</th></tr>
{harness_rows}
</table></div>
<h2>By plugin</h2>
<div class="scroll"><table>
<tr><th>Plugin · task</th>{harness_heads}</tr>
{task_rows}
</table></div>
<h2>Plugins with a bug ({bug_count})</h2>
<div class="scroll"><table>
<tr><th>Plugin · task</th><th style="text-align:left">Reason</th></tr>
{bug_rows}
</table></div>
</body>
</html>
"""


def page(report: Report, bugs: PluginBugs) -> str:
    names = [line.harness for line in report.harnesses]
    harness_rows = "\n".join(
        f"<tr><td>{html.escape(line.harness)}</td><td>{line.correct}/{line.runs}</td><td>{line.latency_seconds:.1f}s</td>"
        f"<td>{line.model_seconds:.1f}s</td><td>{line.tools_seconds:.1f}s</td><td>{line.overhead_seconds:.1f}s</td>"
        f"<td>{line.input_tokens:,.0f}</td><td>{line.output_tokens:,.0f}</td><td>${line.cost:.4f}</td><td>{line.cpu_seconds:.1f}s</td></tr>"
        for line in report.harnesses
    )

    def cell(task: TaskLine, name: str) -> str:
        own = next((line for line in task.harnesses if line.harness == name), None)
        if own is None:
            return "<td></td>"
        word = "right" if own.correct == own.runs else "wrong"
        return f'<td class="{word}">{word if own.runs == 1 else f"{own.correct}/{own.runs}"}</td>'

    task_rows = "\n".join(
        f"<tr><td>{html.escape(f'{task.plugin} · {task.task}')}</td>{''.join(cell(task, name) for name in names)}</tr>" for task in report.tasks
    )
    bug_rows = "\n".join(
        f'<tr><td>{html.escape(f"{bug['plugin']} · {bug['task']}")}</td><td class="reason">{html.escape(bug["reason"])}</td></tr>'
        for bug in bugs.plugins
    )
    return PAGE.format(
        runs=len(report.runs),
        tasks=len(report.tasks),
        harness_rows=harness_rows,
        harness_heads="".join(f"<th>{html.escape(name)}</th>" for name in names),
        task_rows=task_rows,
        bug_count=len(bugs.plugins),
        bug_rows=bug_rows,
    )


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
        report_page = Path(self.layout.page) / "report.html"
        report_page.write_text(page(self.layout.report, load_output(self.config.bugs, PluginBugs)), encoding="utf-8")
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
        print(f"report.html: {report_page.resolve()}")


if __name__ == "__main__":
    GetReport().run()
