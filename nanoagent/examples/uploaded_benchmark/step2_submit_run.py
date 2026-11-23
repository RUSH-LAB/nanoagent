"""Step 2: run a published benchmark with one or more harnesses, and follow the runs.

`harnesses` lists the agents to run, each a listed one (`claude`, `codex`, `pi`, `dsh`, `hermes`, `nanoagent`) or one of your own as
`rush <command>`. Every run is the whole benchmark. The benchmark is the one named `benchmark`
of `plugin` at `plugin_version` (published with step 1). One run is submitted per harness, each under the key
`<idempotency_key>-<harness>`, so repeating the step never queues a harness twice. The model, endpoint, limits and the cases' prompts
are the benchmark's; every harness gets the same starter prompt and uses its own tools (`nanoagent` alone is given the plugin's tools).
The attempts of one run go one after another on your worker, and the runs queue.
With `follow`, the step waits until every attempt of every run is sealed and the run is scored, then prints each run's summary: the
primary metrics first (tokens, with how many attempts did not report each, and elapsed time), then the verdicts, with the verifier's
named checks of each, and the run's score (passed cases over scored cases). runs.json holds the same, machine-readable, and
case_set.json the benchmark's task and cases (never the private references)."""

import time
from dataclasses import dataclass, field
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run

from nanoagent.uploaded.client import BenchmarkClient, ServerConfig, run_title

METRICS = (
    ("total_tokens", "total tokens"),
    ("input_tokens", "input tokens"),
    ("output_tokens", "output tokens"),
    ("cache_read_tokens", "cache-read tokens"),
    ("cache_write_tokens", "cache-write tokens"),
    ("elapsed_ms", "elapsed time"),
)


@dataclass
class SubmitConfig(Config):
    server: ServerConfig = field(default_factory=ServerConfig)
    # The benchmark by plugin, plugin version and name (published with step 1).
    plugin: str = MISSING
    plugin_version: str = MISSING
    benchmark: str = MISSING
    # The agents to run it with, one run each: claude, codex, pi, dsh, hermes, nanoagent, or `rush <command>`.
    harnesses: list[str] = MISSING
    # The same key and request return the same run, so a repeated submit never queues a harness twice; each run's key is this and its harness.
    idempotency_key: str = MISSING
    # Wait for every attempt to seal and every run to score, polling every `poll_seconds` for at most `follow_timeout` seconds.
    follow: bool = MISSING
    poll_seconds: float = MISSING
    follow_timeout: float = MISSING


@dataclass
class AttemptLine:
    case_id: str
    attempt_id: str
    attempt_no: int
    state: str
    execution_status: str | None
    verdict: str | None
    # Why the verdict is a fail (a TASK_VERIFIER_EXPLANATIONS code); null for a pass and for a failure only verify_task judged.
    explanation: str | None
    verifier_error: str | None
    # The verifier's named checks in order, `[{name, status}]`; null for an attempt with no verdict.
    checks: list[dict[str, str]] | None
    sealed: bool
    coverage: dict[str, Any]
    metrics: dict[str, Any]


@dataclass
class BenchmarkCaseSet(Output):
    """The case set of the benchmark the runs are on: its task and every case (never the private references)."""

    benchmark_id: str
    name: str
    plugin: dict[str, Any]
    task: dict[str, Any]
    cases: list[dict[str, Any]]


@dataclass
class RunReport(Output):
    harness: str
    run_id: str
    status: str
    # Whether the server answered a repeated idempotency key with the original run.
    replayed: bool
    model: str
    endpoint_profile: str
    # The effective limits, every one the run is held to.
    limits: dict[str, Any]
    case_ids: list[str]
    # The run's metric sums, each {"total": known sum, "missing_attempts": attempts that did not report it}.
    metrics: dict[str, Any]
    # The server's score: {value (passed over scored cases, null when unavailable), passed, scored, total, unscored,
    # verifier_errors, complete, unavailable_reason}.
    score: dict[str, Any]
    attempts: list[AttemptLine]


@dataclass
class RunsReport(Output):
    """One run per harness, in the order the harnesses were given."""

    runs: list[RunReport]


@dataclass
class RunLayout(Layout):
    case_set: BenchmarkCaseSet
    runs: RunsReport


def format_metric(name: str, key: str, sums: dict[str, Any]) -> str:
    total, missing = sums["total"], sums["missing_attempts"]
    value = f"{total / 1000:.3f} s" if key == "elapsed_ms" else f"{total:,}"
    return f"  {name}: {value}" + (f" known, {missing} attempt{'s' if missing != 1 else ''} did not report it" if missing else "")


def cases_of(view: dict[str, Any]) -> list[dict[str, Any]]:
    return view.get("cases", [])


def format_checks(checks: list[dict[str, str]] | None) -> str:
    return "" if not checks else ", checks " + " ".join(f"{check['name']}={check['status']}" for check in checks)


def format_summary(run: dict[str, Any]) -> str:
    """The run's summary: its model and limits, primary metrics first, then each attempt's verdict and the run's score."""
    limits = run["limits"]
    lines = [
        f"Run {run['run_id']} ({run['status']}): {run_title(run)}",
        f"  model: {run['model']} via {run['endpoint_profile']}",
        f"  limits: {', '.join(f'{name} {value}' for name, value in limits.items())}",
        f"  internet access: {'on, so model calls that bypass the gateway are unverified' if limits.get('internet_access') else 'off'}",
        "Primary metrics",
    ]
    lines += [format_metric(label, key, run["metrics"][key]) for key, label in METRICS]
    lines.append("Verdicts")
    for case in cases_of(run):
        for attempt in case["attempts"]:
            execution = (attempt["execution"] or {}).get("status", "pending")
            lines.append(
                f"  {case['case_id']} #{attempt['attempt_no']}: {attempt['verdict'] or '-'} ({execution}"
                f"{', ' + attempt['explanation'] if attempt.get('explanation') else ''}"
                f"{', verifier error: ' + attempt['verifier_error'] if attempt.get('verifier_error') else ''})"
                f"{format_checks(attempt.get('checks'))}"
            )
    score = run["score"]
    lines.append("Score (passed cases over scored cases)")
    value = score["value"] if score["value"] is not None else f"unavailable ({score['unavailable_reason']})"
    lines.append(f"  {value} ({score['passed']} of {score['scored']} scored, {score['unscored']} unscored of {score['total']})")
    return "\n".join(lines)


def attempts_of(run: dict[str, Any]) -> list[dict[str, Any]]:
    return [attempt for case in cases_of(run) for attempt in case["attempts"]]


def settled(run: dict[str, Any]) -> bool:
    """Every attempt of the run is final and sealed and the run's score is no longer pending."""
    if run["status"] == "canceled":
        return all(attempt["state"] == "final" for attempt in attempts_of(run))
    return (
        run["status"] == "complete"
        and all(attempt["state"] == "final" and attempt["sealed"] for attempt in attempts_of(run))
        and run["score"]["unavailable_reason"] != "scoring_pending"
    )


def follow(client: BenchmarkClient, run_id: str, poll_seconds: float, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        run = client.run(run_id)
        if settled(run):
            return run
        if time.monotonic() > deadline:
            raise TimeoutError(f"run {run_id} is {run['status']} after {timeout:g} seconds")
        time.sleep(poll_seconds)


def report(run: dict[str, Any], replayed: bool) -> RunReport:
    attempts = [
        AttemptLine(
            case_id=case["case_id"],
            attempt_id=attempt["attempt_id"],
            attempt_no=attempt["attempt_no"],
            state=attempt["state"],
            execution_status=(attempt["execution"] or {}).get("status"),
            verdict=attempt["verdict"],
            explanation=attempt.get("explanation"),
            verifier_error=attempt.get("verifier_error"),
            checks=attempt.get("checks"),
            sealed=attempt["sealed"],
            coverage=attempt["coverage"] or {},
            metrics=attempt["metrics"] or {},
        )
        for case in cases_of(run)
        for attempt in case["attempts"]
    ]
    return RunReport(
        harness=run["harness"]["name"],
        run_id=run["run_id"],
        status=run["status"],
        replayed=replayed,
        model=run["model"],
        endpoint_profile=run["endpoint_profile"],
        limits=run["limits"],
        case_ids=[case["case_id"] for case in cases_of(run)],
        metrics=run["metrics"],
        score=run["score"],
        attempts=attempts,
    )


def case_set_of(benchmark: dict[str, Any]) -> BenchmarkCaseSet:
    return BenchmarkCaseSet(
        benchmark_id=benchmark["benchmark_id"],
        name=benchmark["name"],
        plugin=benchmark["plugin"],
        task=benchmark["task"],
        cases=benchmark["cases"],
    )


class SubmitRun(Run):
    config: SubmitConfig
    layout: RunLayout

    def main(self) -> None:
        config = self.config
        if not config.harnesses or len(set(config.harnesses)) != len(config.harnesses):
            raise ValueError("`harnesses` lists each harness once, and at least one")
        with config.server.client() as client:
            benchmark = client.benchmark(client.find_benchmark(config.plugin, config.plugin_version, config.benchmark)["benchmark_id"])
            self.layout.case_set = case_set_of(benchmark)
            # Every run is queued before any is followed, so the runs wait on the worker together, not on this step.
            submissions = []
            for harness in config.harnesses:
                submission = client.create_run(
                    benchmark_id=benchmark["benchmark_id"],
                    harness=harness,
                    idempotency_key=f"{config.idempotency_key}-{harness}",
                )
                print(f"{'replayed' if submission.replayed else 'queued'} run {submission.run['run_id']}: {harness} on {config.benchmark}")
                submissions.append(submission)
            reports = []
            for submission in submissions:
                run = follow(client, submission.run["run_id"], config.poll_seconds, config.follow_timeout) if config.follow else submission.run
                print(format_summary(run))
                reports.append(report(run, submission.replayed))
        self.layout.runs = RunsReport(runs=reports)


if __name__ == "__main__":
    SubmitRun().run()
