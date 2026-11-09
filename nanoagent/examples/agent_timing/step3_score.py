"""Step 3: every attempt of step 2 scored as the plugin scores its own runs, by its verifier against
step 1's pinned answer, and the attempts summed up by plugin and agent.

An attempt at a case to answer is correct when the verifier finds its answer valid; it names the
same items when its list holds the same stocks or cities as the right answer, whatever its numbers
(another source's closes can differ by cents). An attempt at a case to refuse is correct when the
agent refused it. Times are the outside clock's: an attempt's total, and the agent's part of it,
which leaves out NanoAgent pinning its reference before its agent starts."""

import math
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run, build_output, load_layout

from nanoagent.plugin import load_manifest
from nanoagent.plugin.verifier import verify_task
from step1_build_cases import Case, CasesLayout
from step2_run_agents import Attempt, RunAgentsLayout


class Task(Enum):
    FIND_DROPS = "find-drops"
    FIND_CITIES = "find-cities"


@dataclass
class ItemsConfig(Config):
    # The task output's list of what it found, and the field naming each item.
    field: str = MISSING
    key: str = MISSING


@dataclass
class ScoreConfig(Config):
    # Step 1's and step 2's run folders.
    cases: str = MISSING
    attempts: str = MISSING
    items: dict[Task, ItemsConfig] = MISSING


@dataclass
class Score(Output):
    case: str
    plugin: str
    system: str
    repeat: int
    # answer, or refuse: what the right outcome of the case is.
    expected: str
    correct: bool
    same_items: bool
    # Whether the attempt failed, neither answering nor refusing.
    failed: bool
    message: str
    total_seconds: float
    agent_seconds: float
    # The agent's own count of its time on the model's API; null when it gave none.
    model_seconds: float | None
    cost: float


@dataclass
class Summary(Output):
    plugin: str
    system: str
    attempts: int
    failed: int
    # Of the attempts at cases to answer: how many were correct, and how many named the same items.
    answer_attempts: int
    correct: int
    same_items: int
    # Of the attempts at cases to refuse, how many refused.
    refuse_attempts: int
    refused: int
    # The agent's seconds at cases to answer, and the attempts' total seconds there.
    agent_mean: float
    agent_p50: float
    agent_p90: float
    total_p50: float
    total_p90: float
    # Of the agent's own clock at cases to answer, the share spent on the model's API; null without it.
    model_share: float | None
    # The agent's seconds at cases to refuse.
    refuse_p50: float
    # Every attempt's agent seconds, over the attempts that were correct.
    seconds_per_correct: float | None
    cost_mean: float


@dataclass
class Scores(Output):
    scores: list[Score]
    summaries: list[Summary]


@dataclass
class ScoreLayout(Layout):
    scores: Scores


def percentile(values: list[float], share: float) -> float:
    """The nearest-rank percentile of ``values``."""
    ordered = sorted(values)
    return ordered[max(0, math.ceil(share * len(ordered)) - 1)]


def score(case: Case, attempt: Attempt, items: ItemsConfig, folder: Path) -> Score:
    times = {
        "total_seconds": attempt.wall_seconds,
        "agent_seconds": attempt.wall_seconds - (attempt.reference_seconds or 0.0),
        "model_seconds": attempt.model_seconds,
        "cost": attempt.cost,
    }
    head = {
        "case": case.id,
        "plugin": case.id.rsplit("-", 1)[0],
        "system": attempt.system,
        "repeat": attempt.repeat,
        "failed": attempt.error is not None,
    }
    if case.reference is None:
        refused = attempt.refused is not None
        message = attempt.error or (f"refused: {attempt.refused}" if refused else "answered a case to refuse")
        return Score(**head, expected="refuse", correct=refused, same_items=refused, message=message, **times)
    if attempt.output is None:
        message = attempt.error or f"refused a case to answer: {attempt.refused}"
        return Score(**head, expected="answer", correct=False, same_items=False, message=message, **times)
    manifest = load_manifest(case.plugin)
    task = manifest.task(case.task)
    try:
        build_output(attempt.output, task.output_type)
    except (ValueError, TypeError) as error:
        return Score(**head, expected="answer", correct=False, same_items=False, message=f"not the task's output: {error}", **times)
    verdict = verify_task(manifest, task.id, case.arguments, attempt.output, case.reference, folder / "workspace")
    found = {item[items.key] for item in attempt.output[items.field]}
    expected = {item[items.key] for item in case.reference[items.field]}
    return Score(**head, expected="answer", correct=verdict.valid, same_items=found == expected, message=verdict.message, **times)


def summary(plugin: str, system: str, scores: list[Score]) -> Summary:
    answers = [s for s in scores if s.expected == "answer"]
    refusals = [s for s in scores if s.expected == "refuse"]
    agent = [s.agent_seconds for s in answers]
    own = [(s.model_seconds, s.agent_seconds) for s in answers if s.model_seconds is not None]
    correct = sum(s.correct for s in scores)
    return Summary(
        plugin=plugin,
        system=system,
        attempts=len(scores),
        failed=sum(s.failed for s in scores),
        answer_attempts=len(answers),
        correct=sum(s.correct for s in answers),
        same_items=sum(s.same_items for s in answers),
        refuse_attempts=len(refusals),
        refused=sum(s.correct for s in refusals),
        agent_mean=sum(agent) / len(agent),
        agent_p50=percentile(agent, 0.5),
        agent_p90=percentile(agent, 0.9),
        total_p50=percentile([s.total_seconds for s in answers], 0.5),
        total_p90=percentile([s.total_seconds for s in answers], 0.9),
        model_share=sum(m for m, _ in own) / sum(a for _, a in own) if own else None,
        refuse_p50=percentile([s.agent_seconds for s in refusals], 0.5),
        seconds_per_correct=sum(s.agent_seconds for s in scores) / correct if correct else None,
        cost_mean=sum(s.cost for s in scores) / len(scores),
    )


def table(summaries: list[Summary]) -> str:
    rows = [
        "| plugin | agent | correct | same items | refused | agent mean | agent p50 | agent p90 | model share | s / correct | cost |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for s in summaries:
        share = "-" if s.model_share is None else f"{s.model_share:.0%}"
        per = "-" if s.seconds_per_correct is None else f"{s.seconds_per_correct:.1f}s"
        rows.append(
            f"| {s.plugin} | {s.system} | {s.correct}/{s.answer_attempts} | {s.same_items}/{s.answer_attempts}"
            f" | {s.refused}/{s.refuse_attempts} | {s.agent_mean:.1f}s | {s.agent_p50:.1f}s | {s.agent_p90:.1f}s"
            f" | {share} | {per} | ${s.cost_mean:.3f} |"
        )
    return "\n".join(rows)


class ScoreAttempts(Run):
    """Score every attempt and sum them up."""

    config: ScoreConfig
    layout: ScoreLayout

    def main(self) -> None:
        cases = {case.id: case for case in load_layout(self.config.cases, CasesLayout).cases.cases}
        run = load_layout(self.config.attempts, RunAgentsLayout)
        scores = []
        for attempt in run.attempts.attempts:
            case = cases[attempt.case]
            folder = Path(run.runs) / case.id / f"{attempt.system}-{attempt.repeat}"
            made = score(case, attempt, self.config.items[Task(case.task)], folder)
            print(f"{made.case} {made.system} #{made.repeat}: {'ok' if made.correct else 'WRONG'} · {made.message}")
            scores.append(made)
        groups = sorted({(s.plugin, s.system) for s in scores})
        summaries = [summary(p, a, [s for s in scores if (s.plugin, s.system) == (p, a)]) for p, a in groups]
        print(table(summaries))
        self.layout.scores = Scores(scores=scores, summaries=summaries)


if __name__ == "__main__":
    ScoreAttempts().run()
