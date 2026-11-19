"""Step 2: submit an uploaded harness to a published benchmark, and follow the run.

`action` is one of:
  * submit: zip `source` (a folder, packed deterministically: sorted entries, fixed timestamps, no symlinks; or a
    ZIP taken as it is) or build the reference harness `reference` (one of NanoAgent's own, under its own name and a version
    derived from its content; set exactly one of the two), upload it, preview the run, and submit it with `idempotency_key` (repeat a submit with the
    first run's `preview_id`). The run is the benchmark `benchmark` of `plugin` at `plugin_version` under the participant
    `policy` (`coding`: the harness is given the case's prompt and writes answer.json; `task_tools`: it works the task with
    the task's tools) and the harness `source`; the model, endpoint, limits, prompts and cases are the benchmark's and the
    harness name, version and dialects are its manifest's. The benchmark's case set (task, context and every case) is
    written to case_set.json. The preview and the run print the effective configuration and the resolved case ids. A
    preview gone stale stops the step with the current configuration; it never resubmits itself.
  * rerun: queue a new attempt of `case_id` of run `run_id`.
  * cancel: cancel run `run_id`.
With `follow`, the step waits until every attempt is sealed and the run is scored, then prints the summary: the primary
metrics first (tokens, with how many attempts did not report each, and elapsed time), then the verdicts and the run's
score (passed cases over scored cases). run.json holds the same, machine-readable."""

import time
import zipfile
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run

from nanoagent.uploaded.client import BenchmarkClient, ServerConfig, StalePreview, run_title
from nanoagent.uploaded.reference import build_reference
from nanoagent.uploaded.source_zip import zip_folder

METRICS = (
    ("total_tokens", "total tokens"),
    ("input_tokens", "input tokens"),
    ("output_tokens", "output tokens"),
    ("cache_read_tokens", "cache-read tokens"),
    ("cache_write_tokens", "cache-write tokens"),
    ("elapsed_ms", "elapsed time"),
)


class Action(Enum):
    SUBMIT = "submit"
    RERUN = "rerun"
    CANCEL = "cancel"


class Policy(Enum):
    CODING = "coding"
    TASK_TOOLS = "task_tools"


@dataclass
class SubmitConfig(Config):
    server: ServerConfig = field(default_factory=ServerConfig)
    action: Action = MISSING
    # submit: the harness source, and the benchmark by plugin, plugin version and name
    source: str | None = None
    reference: str | None = None
    plugin: str | None = None
    plugin_version: str | None = None
    benchmark: str | None = None
    policy: Policy = MISSING
    idempotency_key: str | None = None
    # To repeat a submit, give the first run's preview_id (its run.json): the server compares the whole request,
    # preview included, so a fresh preview under a used key is an idempotency conflict. Null makes a preview.
    preview_id: str | None = None
    # rerun and cancel
    run_id: str | None = None
    case_id: str | None = None
    # Wait for every attempt to seal and the run to score, polling every `poll_seconds` for at most
    # `follow_timeout` seconds.
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
    sealed: bool
    coverage: dict[str, Any]
    metrics: dict[str, Any]


@dataclass
class BenchmarkCaseSet(Output):
    """The case set of the benchmark the run is on: its task, context and every case (never the private references)."""

    benchmark_id: str
    name: str
    plugin: dict[str, Any]
    task: dict[str, Any]
    context: str
    cases: list[dict[str, Any]]


@dataclass
class RunReport(Output):
    action: str
    run_id: str
    status: str
    # Whether the server answered a repeated idempotency key with the original run; null for other actions.
    replayed: bool | None
    model: str
    endpoint_profile: str
    preview_id: str
    # The benchmark ({benchmark_id, name}) and the harness ({name, version, dialects}) the run is of.
    benchmark: dict[str, Any]
    harness: dict[str, Any]
    case_set: dict[str, Any]
    policy: str
    # Where the prompt came from (default or custom) and its text, as pinned.
    prompt: dict[str, Any]
    # The effective limits, every one the run is held to.
    limits: dict[str, Any]
    case_ids: list[str]
    # The run's metric sums, each {"total": known sum, "missing_attempts": attempts that did not report it}.
    metrics: dict[str, Any]
    # The server's score: {value (passed over scored cases, null when unavailable), passed, scored, total, unscored,
    # verifier_errors, complete, unavailable_reason}.
    score: dict[str, Any]
    attempts: list[AttemptLine]
    # The attempts a rerun queued.
    queued_attempts: list[str]


@dataclass
class RunLayout(Layout):
    case_set: BenchmarkCaseSet
    run: RunReport


def zip_source(path: str) -> bytes:
    """The ZIP of folder ``path`` (see zip_folder); a file is taken as the ZIP it is."""
    root = Path(path)
    if root.is_file():
        if not zipfile.is_zipfile(root):
            raise ValueError(f"{root} is not a ZIP")
        return root.read_bytes()
    if not root.is_dir():
        raise FileNotFoundError(root)
    return zip_folder(root)


def format_metric(name: str, key: str, sums: dict[str, Any]) -> str:
    total, missing = sums["total"], sums["missing_attempts"]
    value = f"{total / 1000:.3f} s" if key == "elapsed_ms" else f"{total:,}"
    return f"  {name}: {value}" + (f" known, {missing} attempt{'s' if missing != 1 else ''} did not report it" if missing else "")


def cases_of(view: dict[str, Any]) -> list[dict[str, Any]]:
    return view.get("cases", [])


def format_setup(view: dict[str, Any]) -> str:
    """The effective configuration of a preview or a run: benchmark, policy, prompt source, every limit, the resolved case ids."""
    benchmark = view.get("benchmark") or {}
    prompt = view.get("prompt") or {}
    limits = view.get("limits") or {}
    limits = limits.get("effective", limits)  # a preview nests them beside the defaults and the worker's capabilities
    lines = [
        "Effective configuration",
        f"  benchmark: {benchmark.get('name')} ({benchmark.get('benchmark_id')})",
        f"  policy: {view.get('policy')}",
        f"  prompt: {prompt.get('source')} ({'template' if view.get('policy') == 'coding' else 'instructions'}, {len(prompt.get('text') or '')} characters)",
        "  limits:",
        *[f"    {name}: {value}" for name, value in limits.items()],
        f"  internet access: {'on, so model calls that bypass the gateway are unverified' if limits.get('internet_access') else 'off'}",
    ]
    ids = [case["case_id"] for case in cases_of(view)]
    lines.append(f"Cases ({len(ids)}): {', '.join(ids)}")
    return "\n".join(lines)


def format_summary(run: dict[str, Any]) -> str:
    """The run's summary: its configuration, primary metrics first, then each attempt's verdict and the run's score."""
    lines = [f"Run {run['run_id']} ({run['status']}): {run_title(run)}", format_setup(run), "Primary metrics"]
    lines += [format_metric(label, key, run["metrics"][key]) for key, label in METRICS]
    lines.append("Verdicts")
    for case in cases_of(run):
        for attempt in case["attempts"]:
            execution = (attempt["execution"] or {}).get("status", "pending")
            lines.append(
                f"  {case['case_id']} #{attempt['attempt_no']}: {attempt['verdict'] or '-'} ({execution}"
                f"{', ' + attempt['explanation'] if attempt.get('explanation') else ''}"
                f"{', verifier error: ' + attempt['verifier_error'] if attempt.get('verifier_error') else ''})"
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


def report(action: str, run: dict[str, Any], **extra: Any) -> RunReport:
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
            sealed=attempt["sealed"],
            coverage=attempt["coverage"] or {},
            metrics=attempt["metrics"] or {},
        )
        for case in cases_of(run)
        for attempt in case["attempts"]
    ]
    return RunReport(
        action=action,
        run_id=run["run_id"],
        status=run["status"],
        replayed=extra.get("replayed"),
        model=run["model"],
        endpoint_profile=run["endpoint_profile"],
        preview_id=run["preview_id"],
        benchmark=run["benchmark"],
        harness=run["harness"],
        case_set=run["case_set"],
        policy=run["policy"],
        prompt=run["prompt"],
        limits=run["limits"],
        case_ids=[case["case_id"] for case in cases_of(run)],
        metrics=run["metrics"],
        score=run["score"],
        attempts=attempts,
        queued_attempts=extra.get("queued_attempts", []),
    )


def stale_message(error: StalePreview) -> str:
    return (
        f"the preview is stale: {', '.join(error.stale)} changed\n{format_setup(error.current)}\nrun the step again to preview it afresh"
    )


def case_set_of(benchmark: dict[str, Any]) -> BenchmarkCaseSet:
    return BenchmarkCaseSet(
        benchmark_id=benchmark["benchmark_id"],
        name=benchmark["name"],
        plugin=benchmark["plugin"],
        task=benchmark["task"],
        context=benchmark["context"],
        cases=benchmark["cases"],
    )


def submit(client: BenchmarkClient, config: SubmitConfig, layout: RunLayout) -> tuple[dict[str, Any], dict[str, Any]]:
    if config.idempotency_key is None or config.plugin is None or config.plugin_version is None or config.benchmark is None:
        raise ValueError("submit needs `plugin`, `plugin_version`, `benchmark` and `idempotency_key`")
    if (config.source is None) == (config.reference is None):
        raise ValueError("submit needs exactly one of `source` and `reference`")
    benchmark = client.benchmark(client.find_benchmark(config.plugin, config.plugin_version, config.benchmark)["benchmark_id"])
    layout.case_set = case_set_of(benchmark)
    source = client.upload_source(zip_source(config.source)) if config.reference is None else client.upload_reference(config.reference, build_reference(config.reference))
    harness = source["harness"]
    print(f"harness {harness['name']}@{harness['version']} (dialects {', '.join(harness['dialects'])}) on {config.benchmark} ({config.plugin} @ {config.plugin_version})")
    if config.preview_id is None:
        preview = client.preview(benchmark["benchmark_id"], config.policy.value)
        print(format_setup(preview))
        preview_id = preview["preview_id"]
    else:
        preview_id = config.preview_id
    try:
        submission = client.create_run(
            benchmark_id=benchmark["benchmark_id"],
            policy=config.policy.value,
            preview_id=preview_id,
            source_sha256=source["source_sha256"],
            idempotency_key=config.idempotency_key,
        )
    except StalePreview as error:
        raise RuntimeError(stale_message(error)) from error
    print(f"{'replayed' if submission.replayed else 'queued'} run {submission.run['run_id']}")
    return submission.run, {"replayed": submission.replayed}


def act(client: BenchmarkClient, config: SubmitConfig, layout: RunLayout) -> tuple[dict[str, Any], dict[str, Any]]:
    if config.action is Action.SUBMIT:
        return submit(client, config, layout)
    if config.run_id is None:
        raise ValueError(f"{config.action.value} needs `run_id`")
    extra: dict[str, Any] = {}
    match config.action:
        case Action.RERUN:
            if config.case_id is None:
                raise ValueError("rerun needs `case_id`")
            extra["queued_attempts"] = [client.rerun(config.run_id, config.case_id)["attempt_id"]]
        case Action.CANCEL:
            print(client.cancel(config.run_id))
    run = client.run(config.run_id)
    layout.case_set = case_set_of(client.benchmark(run["benchmark"]["benchmark_id"]))
    return run, extra


class SubmitRun(Run):
    config: SubmitConfig
    layout: RunLayout

    def main(self) -> None:
        config = self.config
        with config.server.client() as client:
            run, extra = act(client, config, self.layout)
            if config.follow:
                run = follow(client, run["run_id"], config.poll_seconds, config.follow_timeout)
        print(format_summary(run))
        self.layout.run = report(config.action.value, run, **extra)


if __name__ == "__main__":
    SubmitRun().run()
