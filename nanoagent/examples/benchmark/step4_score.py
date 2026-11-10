"""Step 4: every run of step 3 scored as the plugin scores its own runs, by its verifier against step
2's pinned answer, and the runs summed up by harness in RUSH's dashboard figures.

A run of a case to answer is correct when the verifier finds its output valid. A run of a case to
refuse is correct when the harness refused it. A run that failed (no answer, no refusal) is wrong."""

import tempfile
from dataclasses import dataclass
from pathlib import Path

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run, load_layout

from nanoagent.plugin import load_manifest
from nanoagent.plugin.verifier import verify_task
from step2_cases import Case, Cases
from step3_profile import ProfileLayout, StandardProfile


@dataclass
class ScoreConfig(Config):
    cases: Cases = MISSING
    # Step 3's outputs: one run folder per case and harness, <case>/<harness>.
    runs: str = MISSING


@dataclass
class Score(Output):
    case: str
    harness: str
    # answer, or refuse: what the right outcome of the case is.
    expected: str
    correct: bool
    message: str


@dataclass
class Summary(Output):
    harness: str
    runs: int
    correct: int
    # Each of RUSH's dashboard figures, averaged over the harness's runs.
    latency_seconds: float
    model_seconds: float
    tools_seconds: float
    overhead_seconds: float
    input_tokens: float
    output_tokens: float
    cost: float


@dataclass
class Scores(Output):
    scores: list[Score]
    summaries: list[Summary]


@dataclass
class ScoreLayout(Layout):
    scores: Scores


def score(case: Case, run: StandardProfile, workspace: Path) -> Score:
    head = {"case": case.id, "harness": run.harness}
    if case.reference is None:
        refused = run.refused is not None
        return Score(
            **head, expected="refuse", correct=refused, message=run.error or (f"refused: {run.refused}" if refused else "answered a case to refuse")
        )
    if run.output is None:
        return Score(**head, expected="answer", correct=False, message=run.error or f"refused a case to answer: {run.refused}")
    manifest = load_manifest(case.plugin)
    verdict = verify_task(manifest, case.task, case.arguments, run.output, case.reference, workspace)
    return Score(**head, expected="answer", correct=verdict.valid, message=verdict.message)


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


class ScoreRuns(Run):
    """Score every run of step 3 and sum them up by harness."""

    config: ScoreConfig
    layout: ScoreLayout

    def main(self) -> None:
        cases = {case.id: case for case in self.config.cases.cases}
        folders = sorted(path.parent for path in Path(self.config.runs).glob("*/*/profile.json"))
        if not folders:
            raise RuntimeError(f"{self.config.runs} holds no runs of step 3")
        scores, runs = [], {}
        for folder in folders:
            run = load_layout(folder, ProfileLayout).profile
            with tempfile.TemporaryDirectory() as scratch:
                scores.append(score(cases[run.case], run, Path(scratch)))
            runs.setdefault(run.harness, []).append((run, scores[-1]))
        summaries = []
        for harness, done in runs.items():
            figures = {
                name: mean([getattr(run, name) for run, _ in done])
                for name in ("latency_seconds", "model_seconds", "tools_seconds", "overhead_seconds", "input_tokens", "output_tokens", "cost")
            }
            summaries.append(Summary(harness=harness, runs=len(done), correct=sum(scored.correct for _, scored in done), **figures))
        self.layout.scores = Scores(scores=scores, summaries=summaries)
        print(f"{'harness':<10} {'correct':>8} {'latency':>8} {'model':>7} {'tools':>7} {'overhead':>8} {'input':>9} {'output':>7} {'cost':>9}")
        for row in summaries:
            print(
                f"{row.harness:<10} {f'{row.correct}/{row.runs}':>8} {row.latency_seconds:>7.1f}s {row.model_seconds:>6.1f}s"
                f" {row.tools_seconds:>6.1f}s {row.overhead_seconds:>7.1f}s {row.input_tokens:>9,.0f} {row.output_tokens:>7,.0f} ${row.cost:>8.4f}"
            )
        for row in scores:
            if not row.correct:
                print(f"{row.harness} · {row.case}: wrong · {row.message}")


if __name__ == "__main__":
    ScoreRuns().run()
