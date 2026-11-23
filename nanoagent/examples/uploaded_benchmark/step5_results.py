"""Step 5: read your own results on a benchmark from RUSH, as a table: one row per harness, one column per case.

Only your own runs are read (`GET /runs`; RUSH shows no one else's). The benchmark is the one named `benchmark` of `plugin` at
`plugin_version`. For each harness the newest of your runs on it is a row: its pass rate (passed over scored cases), the verdict of
each case (`pass`, `fail`, `verifier_error`, or the attempt's execution status and reason when it has no verdict, `-` for a case
the run did not take), total tokens, cost (what the gateway settled; a lower bound, marked `+`, when an attempt has a call of unknown cost) and elapsed time (the
sum of the attempts' own, partial when attempts did not report it). The table is printed, as JSON when `as_json` is true, and
kept in table.json in its layout either way. The step only reads."""

import json
from dataclasses import asdict, dataclass, field
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run

from nanoagent.uploaded.client import BenchmarkClient, ServerConfig


@dataclass
class ResultsConfig(Config):
    server: ServerConfig = field(default_factory=ServerConfig)
    # The benchmark, by plugin, plugin version and name (step 1's).
    plugin: str = MISSING
    plugin_version: str = MISSING
    benchmark: str = MISSING
    # The most of your runs to read (1 to 200).
    limit: int = MISSING
    # Print the table as JSON instead of text.
    as_json: bool = MISSING


@dataclass
class HarnessRow:
    harness: str
    run_id: str
    status: str
    # passed over scored cases; null when no case was scored.
    pass_rate: float | None
    passed: int
    scored: int
    total: int
    # Each case's verdict by case id; every case of the benchmark is a key.
    verdicts: dict[str, str]
    # Each case's latest attempt by case id, for the traces of step 3 and the comparison of step 4; absent for a case the run did not take.
    attempts: dict[str, str]
    total_tokens: int
    # Attempts that did not report their tokens (the total is then partial).
    tokens_missing_attempts: int
    cost_usd: float | None
    # Whether an attempt had a call of unknown cost (`uncertain_calls`, or no settled cost at all): cost_usd is then a lower bound.
    cost_lower_bound: bool
    elapsed_ms: int
    elapsed_missing_attempts: int


@dataclass
class Table(Output):
    benchmark: dict[str, Any]
    cases: list[str]
    rows: list[HarnessRow]


@dataclass
class ResultsLayout(Layout):
    table: Table


def verdict_of(attempt: dict[str, Any]) -> str:
    """An attempt's verdict as one word: the verifier's, else why it has none."""
    if attempt.get("verdict"):
        return attempt["verdict"]
    if attempt.get("verifier_error"):
        return "verifier_error"
    execution = attempt.get("execution")
    if execution is None:
        return attempt["state"]
    return f"{execution['status']}:{execution['reason']}" if execution.get("reason") else execution["status"]


def latest_attempts(run: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Each case's newest attempt of the run detail, by case id."""
    return {case["case_id"]: max(case["attempts"], key=lambda attempt: attempt["attempt_no"]) for case in run["cases"] if case["attempts"]}


def row_of(client: BenchmarkClient, run: dict[str, Any], cases: list[str]) -> HarnessRow:
    attempts = latest_attempts(run)
    totals = [client.accounting(attempt["attempt_id"])["totals"] for attempt in attempts.values()]
    known = [total["settled_usd"] for total in totals if total["settled_usd"] is not None]
    score, metrics = run["score"], run["metrics"]
    return HarnessRow(
        harness=run["harness"]["name"],
        run_id=run["run_id"],
        status=run["status"],
        pass_rate=score["value"],
        passed=score["passed"],
        scored=score["scored"],
        total=score["total"],
        verdicts={case: verdict_of(attempts[case]) if case in attempts else "-" for case in cases},
        attempts={case: attempt["attempt_id"] for case, attempt in attempts.items()},
        total_tokens=metrics["total_tokens"]["total"],
        tokens_missing_attempts=metrics["total_tokens"]["missing_attempts"],
        cost_usd=sum(known) if known else None,
        cost_lower_bound=any(total["settled_usd"] is None or total["uncertain_calls"] for total in totals),
        elapsed_ms=metrics["elapsed_ms"]["total"],
        elapsed_missing_attempts=metrics["elapsed_ms"]["missing_attempts"],
    )


def build_table(client: BenchmarkClient, config: ResultsConfig, harnesses: list[str] | None = None) -> Table:
    """The table of your newest run of each harness on the benchmark (every harness you ran, or only ``harnesses``)."""
    summary = client.find_benchmark(config.plugin, config.plugin_version, config.benchmark)
    benchmark = client.benchmark(summary["benchmark_id"])
    cases = [case["case_id"] for case in benchmark["cases"]]
    newest: dict[str, dict[str, Any]] = {}
    for run in client.list_runs(config.limit):  # newest first
        mine = (
            run["benchmark"]["name"] == config.benchmark
            and run["plugin"]["id"] == config.plugin
            and run["plugin"]["version"] == config.plugin_version
        )
        if mine and run["harness"]["name"] not in newest and (harnesses is None or run["harness"]["name"] in harnesses):
            newest[run["harness"]["name"]] = run
    # Newest run first, or in the order the harnesses were asked for.
    ordered = list(newest.values()) if harnesses is None else [newest[name] for name in harnesses if name in newest]
    rows = [row_of(client, client.run(run["run_id"]), cases) for run in ordered]
    return Table(
        benchmark={"benchmark_id": benchmark["benchmark_id"], "name": benchmark["name"], "plugin": benchmark["plugin"]}, cases=cases, rows=rows
    )


def cost_text(cost: float | None) -> str:
    return "unknown" if cost is None else f"${cost:.4f}"


def format_table(table: Table) -> str:
    """The text table: a column per case, a row per harness, then the pass rate, tokens, cost and elapsed time."""
    header = ["harness", *table.cases, "pass rate", "tokens", "cost", "elapsed"]
    body = [
        [
            row.harness,
            *(row.verdicts[case] for case in table.cases),
            "unavailable" if row.pass_rate is None else f"{row.pass_rate:.2f} ({row.passed}/{row.scored} of {row.total})",
            f"{row.total_tokens:,}" + ("+" if row.tokens_missing_attempts else ""),
            cost_text(row.cost_usd) + ("+" if row.cost_lower_bound and row.cost_usd is not None else ""),
            f"{row.elapsed_ms / 1000:.1f} s" + ("+" if row.elapsed_missing_attempts else ""),
        ]
        for row in table.rows
    ]
    widths = [max(len(line[column]) for line in [header, *body]) for column in range(len(header))]
    return "\n".join("  ".join(cell.ljust(width) for cell, width in zip(line, widths, strict=True)).rstrip() for line in [header, *body])


class ReadResults(Run):
    config: ResultsConfig
    layout: ResultsLayout

    def main(self) -> None:
        with self.config.server.client() as client:
            table = build_table(client, self.config)
        self.layout.table = table
        print(json.dumps(asdict(table), indent=2) if self.config.as_json else format_table(table))


if __name__ == "__main__":
    ReadResults().run()
