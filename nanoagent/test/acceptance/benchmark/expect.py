"""The written definition of a valid benchmark result, checked against a run's artifacts only.

Nothing here calls step 2's own helpers (``cost``, ``finished_steps``): every figure is recomputed from
the files a run leaves, so a bug in the code that produced them is caught, not echoed. The step
modules are imported only for their layout classes, which are the files' declared schema."""

import json
import math
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "examples" / "benchmark"))

from nanoagent import __version__  # noqa: E402
from slimconfig import load_layout  # noqa: E402
from step2_single_run import Model, SingleRun, SingleRunLayout  # noqa: E402
from step3_batch_runs import BatchLayout  # noqa: E402
from step4_report import FIGURES, ReportLayout  # noqa: E402

# Seconds a figure on the harness's own clock may exceed the outside clock that timed the run
# (model + tools <= latency + EPSILON, t <= latency + EPSILON). Float compares use RELATIVE.
CLOCK_EPSILON = 0.05
RELATIVE = 1e-9
ABSOLUTE = 1e-9
# What slimconfig writes beside a layout's own files.
RUN_BOOKKEEPING = {"metadata.json", "config.yaml", "run.log"}


class StaleRun(Exception):
    """The folder was written by an older version of the code: its schema is not the current one."""


def fail(folder: Path, predicate: str, detail: str) -> None:
    raise AssertionError(f"{folder}: [{predicate}] {detail}")


def close(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=RELATIVE, abs_tol=ABSOLUTE)


def prices_of(folder: Path, model: str) -> dict[str, float]:
    """The run's per-million prices for ``model``, from the config.yaml the run wrote."""
    config = yaml.safe_load((folder / "config.yaml").read_text(encoding="utf-8"))
    # slimconfig writes a typed key as ``name > type``.
    prices = next((value for key, value in config.items() if key == "prices" or str(key).startswith("prices >")), None)
    if not isinstance(prices, dict):
        raise StaleRun("config.yaml has no `prices` table (it predates the per-model prices config)")
    for key, value in prices.items():
        # slimconfig writes an Enum key as its value or as its name; accept either.
        if str(key) in {model, Model(model).name, f"Model.{Model(model).name}"}:
            return value
    raise StaleRun(f"config.yaml's prices table has no entry for {model}")


def load_run(folder: Path) -> SingleRunLayout:
    """The folder as the current SingleRunLayout; StaleRun when the current schema cannot read it."""
    try:
        return load_layout(folder, SingleRunLayout)
    except Exception as error:
        raise StaleRun(f"does not load as the current SingleRunLayout: {str(error).splitlines()[0][:200]}") from error


def stale_reason(folder: Path) -> str | None:
    """Why ``folder`` is not a run of the current code, or None when it is."""
    try:
        result = load_run(folder).result
        prices_of(folder, result.model)
    except StaleRun as stale:
        return str(stale)
    return None


def assert_valid_single_run(folder: Path, secret: str | None = None) -> SingleRun:
    folder = Path(folder)
    try:
        run = load_run(folder).result
    except StaleRun as stale:
        fail(folder, "layout", str(stale))
    check_files(folder, run)
    check_log(folder, run)
    check_arithmetic(folder, run)
    check_verdict(folder, run)
    check_timeline(folder, run)
    if secret:
        check_secret(folder, secret)
    return run


def check_files(folder: Path, run: SingleRun) -> None:
    metadata = json.loads((folder / "metadata.json").read_text(encoding="utf-8"))
    declared = set(metadata["layout"])
    present = {entry.name for entry in folder.iterdir()} - RUN_BOOKKEEPING
    if declared != present:
        fail(folder, "metadata declares exactly the files present", f"declared {sorted(declared)}, present {sorted(present)}")
    for required in RUN_BOOKKEEPING:
        if not (folder / required).exists():
            fail(folder, "bookkeeping files", f"{required} is missing")


def summary_line(run: SingleRun) -> str:
    """step 2's closing line, rebuilt from the result's own figures."""
    return (
        f"{run.harness} · {run.case}: {'right' if run.correct else 'wrong'} · latency {run.latency_seconds:.1f}s"
        f" · model {run.model_seconds:.1f}s · tools {run.tools_seconds:.1f}s · overhead {run.overhead_seconds:.1f}s"
        f" · {run.input_tokens:,} in / {run.output_tokens:,} out · ${run.cost:.4f} · cpu {run.cpu_seconds:.1f}s"
    )


def check_log(folder: Path, run: SingleRun) -> None:
    lines = (folder / "run.log").read_text(encoding="utf-8", errors="replace").rstrip().splitlines()
    verdict = f"{run.harness} · {run.case}: {run.verdict}"
    # A run that is not right ends with its verdict line after the summary.
    tail = lines[-2:] if not run.correct else lines[-1:]
    expected = [summary_line(run), verdict] if not run.correct else [summary_line(run)]
    if tail != expected:
        fail(folder, "run.log ends with the summary line", f"expected last lines {expected!r}, found {tail!r}")


def check_arithmetic(folder: Path, run: SingleRun) -> None:
    def need(ok: bool, predicate: str, detail: str) -> None:
        if not ok:
            fail(folder, predicate, detail)

    profile = run.profile
    need(run.latency_seconds >= 0, "latency >= 0", f"latency {run.latency_seconds}")
    need(run.model_seconds >= 0 and run.tools_seconds >= 0, "model and tools >= 0", f"model {run.model_seconds}, tools {run.tools_seconds}")
    need(
        run.model_seconds + run.tools_seconds <= run.latency_seconds + CLOCK_EPSILON,
        "model + tools <= latency + eps",
        f"model {run.model_seconds} + tools {run.tools_seconds} = {run.model_seconds + run.tools_seconds} > latency {run.latency_seconds} + {CLOCK_EPSILON}",
    )
    overhead = max(0.0, run.latency_seconds - run.model_seconds - run.tools_seconds)
    need(
        close(run.overhead_seconds, overhead),
        "overhead == max(0, latency - model - tools)",
        f"overhead {run.overhead_seconds}, recomputed {overhead}",
    )
    need(close(run.model_seconds, profile["model_s"]), "model_seconds == profile.model_s", f"{run.model_seconds} vs {profile['model_s']}")
    need(close(run.tools_seconds, profile["tools_s"]), "tools_seconds == profile.tools_s", f"{run.tools_seconds} vs {profile['tools_s']}")
    need(
        run.cached_input_tokens >= 0 and run.cache_write_tokens >= 0,
        "cache tokens >= 0",
        f"cached {run.cached_input_tokens}, written {run.cache_write_tokens}",
    )
    need(run.cached_input_tokens <= run.input_tokens, "cached <= input", f"cached {run.cached_input_tokens} > input {run.input_tokens}")
    need(
        run.cached_input_tokens + run.cache_write_tokens <= run.input_tokens,
        "cache reads + writes <= input",
        f"cached {run.cached_input_tokens} + written {run.cache_write_tokens} > input {run.input_tokens}",
    )
    need(run.reasoning_tokens <= run.output_tokens, "reasoning <= output", f"reasoning {run.reasoning_tokens} > output {run.output_tokens}")
    steps = profile["steps"]
    need(run.steps == len(steps), "steps == len(profile.steps)", f"steps {run.steps}, profile has {len(steps)}")
    model_calls = sum(len(step["model_calls"]) for step in steps)
    tool_calls = sum(len(step["tool_calls"]) for step in steps)
    need(run.model_calls == model_calls, "model_calls == sum over profile", f"model_calls {run.model_calls}, profile sums to {model_calls}")
    need(run.tool_calls == tool_calls, "tool_calls == sum over profile", f"tool_calls {run.tool_calls}, profile sums to {tool_calls}")
    try:
        prices = prices_of(folder, run.model)
    except StaleRun as stale:
        fail(folder, "cost == f(tokens, config prices)", str(stale))
    uncached = run.input_tokens - run.cached_input_tokens - run.cache_write_tokens
    cost = (
        uncached * prices["input"]
        + run.cached_input_tokens * prices["cached_input"]
        + run.cache_write_tokens * prices["cache_write"]
        + run.output_tokens * prices["output"]
    ) / 1e6
    need(
        close(run.cost, cost),
        "cost == f(tokens, config prices)",
        f"cost {run.cost}, recomputed {cost} from {uncached} uncached/{run.cached_input_tokens} cached/{run.cache_write_tokens} written/{run.output_tokens} out at {prices}",
    )


def check_verdict(folder: Path, run: SingleRun) -> None:
    if run.expected not in {"answer", "refuse"}:
        fail(folder, "expected is answer or refuse", f"expected {run.expected!r}")
    if run.expected == "refuse" and run.reference is not None:
        fail(folder, "expected refuse => reference is None", f"reference {run.reference!r}")
    if run.expected == "answer" and run.reference is None:
        fail(folder, "expected answer => reference is set", "reference is None")
    if run.correct and run.error is not None:
        fail(folder, "correct => error is None", f"correct with error {run.error!r}")
    if run.refused is not None and run.output is not None:
        fail(folder, "refused and output never both set", f"refused {run.refused!r} and output {run.output!r}")


def check_timeline(folder: Path, run: SingleRun) -> None:
    last = 0.0
    for index, event in enumerate(run.timeline):
        t = event["t"]
        if t < last:
            fail(folder, "timeline t non-decreasing", f"event {index} ({event.get('type')}) at t={t} follows t={last}")
        if t < 0 or t > run.latency_seconds + CLOCK_EPSILON:
            fail(folder, "timeline t within [0, latency]", f"event {index} ({event.get('type')}) at t={t}, latency {run.latency_seconds}")
        last = t


def check_secret(folder: Path, secret: str) -> None:
    needle = secret.encode()
    for path in sorted(folder.rglob("*")):
        if path.is_file() and not path.is_symlink() and needle in path.read_bytes():
            fail(folder, "no secret in any file", f"the API key appears in {path.relative_to(folder)}")


def run_folders(runs: Path) -> list[Path]:
    """Every run folder of a batch: <plugin>/<task>/<case>/<harness>."""
    return sorted(path.parent for path in Path(runs).glob("*/*/*/*/result.json"))


def assert_valid_batch(folder: Path, secret: str | None = None) -> None:
    folder = Path(folder)
    try:
        layout = load_layout(folder, BatchLayout)
    except Exception as error:
        fail(folder, "layout", f"does not load as the current BatchLayout: {str(error).splitlines()[0][:200]}")
    batch, runs = layout.batch, Path(layout.runs)
    if batch.side_by_side < 1:
        fail(folder, "side_by_side >= 1", f"side_by_side {batch.side_by_side}")
    keys = [(entry.plugin, entry.task, entry.case, entry.harness) for entry in batch.runs]
    if len(set(keys)) != len(keys):
        fail(folder, "one batch entry per run", f"duplicates in {keys}")
    on_disk = {path.relative_to(runs).parts for path in run_folders(runs)}
    if set(keys) != on_disk:
        fail(
            folder,
            "batch.json lists exactly the runs on disk",
            f"only in batch {sorted(set(keys) - on_disk)}, only on disk {sorted(on_disk - set(keys))}",
        )
    for entry in batch.runs:
        home = runs / entry.plugin / entry.task / entry.case / entry.harness
        if entry.seconds < 0:
            fail(home, "batch seconds >= 0", f"seconds {entry.seconds}")
        if not (home.parent / f"{entry.harness}.log").is_file():
            fail(home, "run has its .log", f"{entry.harness}.log is missing")
        run = assert_valid_single_run(home, secret)
        if (run.plugin, run.task, run.case, run.harness) != (entry.plugin, entry.task, entry.case, entry.harness):
            fail(home, "result matches its batch entry", f"result is {run.case}/{run.harness}, entry is {entry.case}/{entry.harness}")
        # Step 2 exits 1 exactly when the run has an error.
        if entry.status != (1 if run.error else 0):
            fail(home, "status == 1 iff the run erred", f"status {entry.status}, error {run.error!r}")
        # Every harness on a case is judged against the one answer step 3 pinned for it.
        pinned = home.parent / "pinned.json"
        if not pinned.is_file():
            fail(home, "the case was pinned once for the batch", "pinned.json is missing")
        reference = json.loads(pinned.read_text(encoding="utf-8"))["reference"]
        if run.reference != reference:
            fail(home, "reference == the batch's pinned reference", f"run {run.reference!r}, pinned {reference!r}")


def assert_valid_report(report: Path, runs: Path) -> None:
    report, runs = Path(report), Path(runs)
    try:
        lines = load_layout(report, ReportLayout).report
    except Exception as error:
        fail(report, "layout", f"does not load as the current ReportLayout: {str(error).splitlines()[0][:200]}")
    results = [load_run(folder).result for folder in run_folders(runs)]
    if [(line.case, line.harness) for line in lines.runs] != [(r.case, r.harness) for r in results]:
        fail(
            report,
            "report lists every run, in folder order",
            f"report {[(one.case, one.harness) for one in lines.runs]}, runs {[(r.case, r.harness) for r in results]}",
        )
    for line, result in zip(lines.runs, results, strict=True):
        if (line.correct, line.verdict) != (result.correct, result.verdict):
            fail(
                report,
                "run line verdict matches result",
                f"{line.case}/{line.harness}: {line.correct} {line.verdict!r} vs {result.correct} {result.verdict!r}",
            )
        for name in FIGURES:
            if getattr(line, name) != getattr(result, name):
                fail(report, f"run line {name} matches result", f"{line.case}/{line.harness}: {getattr(line, name)} vs {getattr(result, name)}")
    harnesses = sorted({r.harness for r in results})
    if [line.harness for line in lines.harnesses] != harnesses:
        fail(report, "one harness line per harness, sorted", f"report {[one.harness for one in lines.harnesses]}, runs {harnesses}")
    for line in lines.harnesses:
        own = [r for r in results if r.harness == line.harness]
        if line.runs != len(own):
            fail(report, "harness line run count", f"{line.harness}: {line.runs} vs {len(own)}")
        if line.correct != sum(r.correct for r in own):
            fail(report, "harness line correct count", f"{line.harness}: {line.correct} vs {sum(r.correct for r in own)}")
        # The runs the harness failed to finish (timed out or erred), counted wrong too.
        failed = sum(r.stop_reason in {"timeout", "error"} for r in own)
        if line.errors != failed:
            fail(report, "harness line error count", f"{line.harness}: {line.errors} vs {failed}")
        # Pinned semantics: a plain mean over every run of the harness, wrong and errored runs included.
        for name in FIGURES:
            mean = sum(getattr(r, name) for r in own) / len(own)
            if not close(getattr(line, name), mean):
                fail(
                    report,
                    f"harness line {name} == mean of results",
                    f"{line.harness}: report {getattr(line, name)}, mean {mean} over {len(own)} runs",
                )


# ---- 4b: conservation checks, a mock run's artifacts against the mock's own ledger ----

TOLERANCES = Path(__file__).resolve().parent / "tolerances.yaml"
# The test model's prices, per million tokens, pairwise distinct so a swapped field shows in the cost.
PRICES = {"input": 1.0, "cached_input": 0.25, "cache_write": 1.5, "output": 4.0}


@dataclass(frozen=True)
class Traits:
    """What a harness is, as the benchmark's output must show it: the only per-harness table of the suite."""

    # Whether the run's token totals include the harness's side calls (Claude's modelUsage does).
    counts_side_calls: bool = False
    # Whether the harness reports a first token at all (Codex and dsh report None by design).
    ttft: bool = True
    # The harness is a coding agent: the answer and a refusal are written to answer.json by a shell call (a tool
    # call of its own), where NanoAgent submits through a tool and refuses with plain text.
    shell_answer: bool = False
    # The harness has a `submit` tool whose parameters are the task's output schema, and the plugin's own tools.
    submit_tool: bool = False
    # The harness is NanoAgent itself, so its trajectory's agent.version is NanoAgent's version; any other harness
    # reports the version of the harness it ran.
    nanoagent: bool = False


HARNESS_TRAITS = {
    "nanoagent": Traits(submit_tool=True, nanoagent=True),
    "claude": Traits(shell_answer=True),
    "codex": Traits(ttft=False, shell_answer=True),
    "pi": Traits(shell_answer=True),
    "dsh": Traits(ttft=False, shell_answer=True),
}


def tolerances(harness: str) -> dict[str, float]:
    return yaml.safe_load(TOLERANCES.read_text(encoding="utf-8"))[harness]


def tool_actions(act: Any, shell_answer: bool = False) -> list[tuple[str, Any]]:
    """The tool-call actions (wait, answer, malformed) of a turn's abstract act, each as (kind, value). A refusal
    is a tool call for a harness that writes it to answer.json."""
    kinds = {"wait", "answer", "malformed"} | ({"refuse"} if shell_answer else set())
    if isinstance(act, list):
        return [pair for item in act for pair in tool_actions(item, shell_answer)]
    if act == "malformed":
        return [("malformed", None)]
    if isinstance(act, dict):
        return [(kind, value) for kind, value in act.items() if kind in kinds]
    return []


def _actions_of(act: Any) -> list[tuple[str, Any]]:
    """Every (kind, value) of an abstract act."""
    if isinstance(act, list):
        return [pair for item in act for pair in _actions_of(item)]
    return list(act.items()) if isinstance(act, dict) else []


def resolved(value: Any, refs: dict[str, Any]) -> Any:
    if isinstance(value, str) and value.startswith("@") and value[1:] in refs:
        return refs[value[1:]]
    if isinstance(value, dict):
        return {key: resolved(item, refs) for key, item in value.items()}
    return value


def assert_conserved(
    folder: Path, handle: Any, scenario: Any, traits: Traits, tol: dict[str, float], *, case: dict[str, Any], oracle: Any, key: str
) -> None:
    """The run's result.json and messages.json against what the provider actually did (``handle.ledger``).

    ``case`` is the case's arguments, ``oracle`` the digest the test computed itself, ``key`` the sentinel API key."""
    folder = Path(folder)
    ledger = handle.ledger
    run = load_run(folder).result
    messages = load_run(folder).messages
    mains = ledger.main_calls
    errors = ledger.of_kind("error")
    under = tol["under"]

    broken: list[str] = []

    def need(ok: bool, predicate: str, detail: str) -> None:
        # Collected, so one broken figure does not hide the next.
        if not ok:
            broken.append(f"[{predicate}] {detail}")

    # The run's verdict is the scenario's.
    need(run.expected == ("answer" if oracle else "refuse"), "expected matches the case", f"expected {run.expected!r}")
    if scenario.expect.correct is not None:
        need(
            run.correct == scenario.expect.correct,
            "verdict matches the scenario",
            f"correct {run.correct}, verdict {run.verdict!r}, error {run.error!r}",
        )
    need(scenario.expect.verdict_contains in run.verdict, "verdict text", f"{scenario.expect.verdict_contains!r} not in {run.verdict!r}")
    if oracle:
        need(run.reference == oracle, "pinned reference is the oracle's", f"reference {run.reference!r}, oracle {oracle!r}")
        if run.correct:
            need(run.output == oracle, "a right answer is the oracle's", f"output {run.output!r}")
    ledger.assert_clean()

    # What the benchmark sent: model, auth, prompt, tools.
    for call in mains + errors:
        sent = call.request
        need(sent.model == run.model, "request model is the config's", f"{sent.model!r} vs {run.model!r}")
        need(sent.auth == key, "request carries the configured key", f"auth header {sent.auth_header!r}")
        if sent.dialect == "chat":
            need(
                bool((sent.stream_options or {}).get("include_usage")),
                "chat requests ask for streamed usage",
                f"stream_options {sent.stream_options!r}",
            )
    if mains:
        first = mains[0].request
        prompt = json.dumps(first.messages)
        for name, value in case.items():
            need(
                json.dumps(value)[1:-1] in prompt, "first prompt holds the case's arguments", f"{name}={value!r} not in the first request's messages"
            )
        need("digest" in prompt, "first prompt holds the output schema", "no `digest` in the first request's messages")
        if traits.submit_tool:
            tools = {spec.name: spec.schema for spec in first.tools}
            need(set(tools) == {"wait", "submit"}, "tools are the task's tools plus submit", f"tools {sorted(tools)}")
            submit = tools["submit"]
            need(
                submit.get("properties", {}).get("digest", {}).get("type") == "string" and submit.get("required") == ["digest"],
                "submit's parameters are the output schema",
                f"submit {submit!r}",
            )

    # Tokens: exactly what the provider emitted (main calls, plus side calls for harnesses that count them).
    sent_usage = ledger.usage("main", "side") if traits.counts_side_calls else ledger.usage()
    for field, truth in [
        ("input_tokens", sent_usage.input),
        ("cached_input_tokens", sent_usage.cached),
        ("cache_write_tokens", sent_usage.cache_write),
        ("output_tokens", sent_usage.output),
        ("reasoning_tokens", sent_usage.reasoning),
    ]:
        need(getattr(run, field) == truth, f"{field} == ledger usage", f"recorded {getattr(run, field)}, the provider emitted {truth}")

    # Cost: the ledger's tokens at the test prices.
    cost = (
        (sent_usage.input - sent_usage.cached - sent_usage.cache_write) * PRICES["input"]
        + sent_usage.cached * PRICES["cached_input"]
        + sent_usage.cache_write * PRICES["cache_write"]
        + sent_usage.output * PRICES["output"]
    ) / 1e6
    need(close(run.cost, cost), "cost == ledger tokens at the test prices", f"recorded {run.cost}, expected {cost}")

    # Counts. Request counts are pinned only where the provider never failed for good.
    always_failing = any(turn.status is not None and turn.repeat == 0 for turn in scenario.turns)
    if not always_failing:
        # A model call is a completed model turn. Every harness's client retries a failed request
        # inside the call (the openai client, Claude Code, Codex, pi-ai), so a retry is not a call;
        # its time stays in model_seconds (see the retry_backoff tolerance).
        need(
            run.model_calls == len(mains),
            "model_calls == main calls",
            f"recorded {run.model_calls}, ledger {len(mains)} (+ {len(errors)} retried errors)",
        )
    scripted = [pair for call in mains for pair in tool_actions(scenario.turns[call.turn_index].act, traits.shell_answer)]
    need(run.tool_calls == len(scripted), "tool_calls == scripted tool calls", f"recorded {run.tool_calls}, scripted {len(scripted)}")
    if always_failing:
        need(run.error is not None and not run.correct, "a provider that always fails ends in an error", f"error {run.error!r}")
        # No model turn completed: failed attempts are not calls (their time stays in model_seconds).
        need(run.model_calls == 0, "model_calls == 0 when every provider call fails", f"recorded {run.model_calls}")
        # The model was asked and failed: that is a step, and the waiting is model time, not overhead.
        need(run.steps >= 1, "steps >= 1 when every provider call fails", f"recorded {run.steps}")
        need(run.model_seconds > 0, "model_seconds > 0 when every provider call fails", f"recorded {run.model_seconds}")
        statuses = {str(call.status) for call in errors}
        need(
            run.error is not None and any(status in run.error for status in statuses),
            "the error names the provider's status",
            f"error {run.error!r}, provider answered {sorted(statuses)}",
        )

    # Time.
    spans = sum(call.span for call in mains + errors)
    # A client that retries a provider that always fails (Codex, Claude Code on a 401) backs off
    # exponentially: its waiting is model time but not a per-error constant, so only the floor is pinned.
    ceiling = float("inf") if always_failing else spans + tol["model_lag"] + len(errors) * tol["retry_backoff"]
    need(
        spans - under <= run.model_seconds <= ceiling,
        "model_seconds within the ledger's server spans",
        f"recorded {run.model_seconds:.3f}, server spans {spans:.3f} (slack -{under}/+{tol['model_lag']} + {len(errors)} x {tol['retry_backoff']} per injected error)",
    )
    # Tool time is the union of each turn's waits: a turn's waits run together, so it costs its longest.
    waits = 0.0
    waits_serial = 0.0
    waiting_turns = 0
    for call in mains:
        turn_waits = [value for kind, value in tool_actions(scenario.turns[call.turn_index].act) if kind == "wait"]
        waits += max(turn_waits, default=0.0)
        waits_serial += sum(turn_waits)
        waiting_turns += bool(turn_waits)
    # NanoAgent checks every plugin tool call's input and output with the plugin's verifier, inside the
    # tool phase: tolerances.yaml's tool_turn_overhead is that cost per turn that calls a plugin tool.
    # A coding harness may run one turn's shell calls one after another (dsh does) or together (Claude, PI do): both
    # are true to what it did, so its tool time is anywhere from the union to the sum of the waits.
    high = (waits_serial if traits.shell_answer else waits) + tol["tool_lag"] + waiting_turns * tol["tool_turn_overhead"]
    need(
        waits - under <= run.tools_seconds <= high,
        "tools_seconds within the scripted waits' union",
        f"recorded {run.tools_seconds:.3f}, waits {waits:.3f} (serial {waits_serial:.3f}) over {waiting_turns} turns (allowed {waits - under:.3f} to {high:.3f})",
    )
    calls = ledger.calls
    if os.environ.get("ACCEPTANCE_CALIBRATE"):
        # Observed slack, for calibrating tolerances.yaml: run with -s.
        print(
            f"CALIBRATE {run.harness} {scenario.name}: model {run.model_seconds - spans:+.3f} (errors {len(errors)}), tools {run.tools_seconds:.3f} vs waits {waits:.3f}/{waiting_turns} turns, ttft {run.ttft_seconds}, overhead {run.overhead_seconds:.3f}"
        )
    if calls:
        window = max(call.last_byte for call in calls if call.last_byte is not None) - min(call.arrival for call in calls)
        need(
            run.latency_seconds >= window - under,
            "latency covers the provider's busy window",
            f"latency {run.latency_seconds:.3f}, ledger window {window:.3f}",
        )
    if not mains or not traits.ttft:
        need(run.ttft_seconds is None, "no first token", f"ttft {run.ttft_seconds}")
    else:
        t0 = min(call.arrival for call in calls)
        low = mains[0].first_byte - t0
        high = mains[0].last_byte - t0 + tol["boot"]
        need(
            run.ttft_seconds is not None and low - under <= run.ttft_seconds <= high,
            "ttft within the first main call",
            f"ttft {run.ttft_seconds}, expected [{low:.3f}, {high:.3f}]",
        )

    # messages.json (ATIF) is a valid record of the conversation: it has agent steps, the tool calls it records are
    # the ones the provider asked for, the answer is in them, and the last agent message is the run's last text.
    # Step boundaries and ids are the harness's own, so they are not compared.
    version = messages.agent.get("version")
    need(isinstance(version, str) and bool(version), "messages.json names the harness's version", f"agent {messages.agent!r}")
    need(
        (version == __version__) == traits.nanoagent,
        "messages.json's agent.version is NanoAgent's only for NanoAgent",
        f"agent.version {version!r}, NanoAgent {__version__!r}, harness is {'' if traits.nanoagent else 'not '}NanoAgent",
    )
    agent_steps = [step for step in messages.steps if step["source"] == "agent"]
    if mains:
        need(bool(agent_steps), "messages.json has agent steps", f"steps {[step['source'] for step in messages.steps]}")
        recorded = [call for step in messages.steps for call in step["tool_calls"] or []]
        served = [(kind, value) for call in mains for kind, value in tool_actions(scenario.turns[call.turn_index].act, traits.shell_answer)]
        need(
            len(recorded) == len(served),
            "messages.json records the tool calls the provider asked for",
            f"recorded {len(recorded)} {[c['function_name'] for c in recorded]}, served {len(served)} {[kind for kind, _ in served]}",
        )
        refs = {"reference": oracle["digest"]} if oracle else {}
        # Each served answer is in a recorded tool call's arguments (the submit body, or the shell command writing it).
        for kind, value in served:
            if kind == "answer":
                text = json.dumps(resolved(value, refs)["digest"])[1:-1]
                need(
                    any(text in json.dumps(c["arguments"]) for c in recorded),
                    "messages.json carries the submitted answer",
                    f"{text!r} in none of {recorded!r}",
                )
        # The final agent message is the last text the provider sent (a refusal is plain text for NanoAgent).
        last = scenario.turns[mains[-1].turn_index]
        final = [last.text] + [value for kind, value in _actions_of(last.act) if kind == "refuse" and not traits.shell_answer]
        message = agent_steps[-1]["message"] if agent_steps else ""
        for part in filter(None, final):
            need(part in message, "the final agent message is the provider's last text", f"{part!r} not in {message!r}")
    if broken:
        fail(folder, "conservation", "\n  ".join(broken))
