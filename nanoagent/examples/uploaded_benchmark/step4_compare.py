"""Step 4: compare two harnesses on a benchmark, and optionally their attempts at one case, action by action.

The benchmark is the one named `benchmark` of `plugin` at `plugin_version`; `harness_a` and `harness_b` are two harnesses you ran on it
(step 2). The step prints and keeps step 5's table for the pair: one row per harness, one column per case, from your newest run of each.
With `case` (a case id of the benchmark) it also asks RUSH to compare the two harnesses' attempts at that case (`GET
/compare/attempts?a=&b=`, 409 `not_same_case` or `attempt_not_sealed` otherwise), which NanoAgent computes deterministically from the
attempts' stored events and payloads: the conditions with every flagged difference first, the latency-adjusted estimate delta
(withheld unless timing method and reference rate match), the rows and the first difference. Attempts are found by benchmark, case
and harness, never by id. No step here calls the gateway or any model endpoint. comparison.json holds both."""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run
from step5_results import ResultsConfig, Table, build_table, format_table

from nanoagent.uploaded.client import BenchmarkClient, ServerConfig

JUMPS = ("first_difference", "none")


@dataclass
class CompareConfig(Config):
    server: ServerConfig = field(default_factory=ServerConfig)
    # The benchmark, by plugin, plugin version and name (step 1's), and the two harnesses you ran on it.
    plugin: str = MISSING
    plugin_version: str = MISSING
    benchmark: str = MISSING
    harness_a: str = MISSING
    harness_b: str = MISSING
    # Optional: one case id of the benchmark, whose two attempts are compared action by action; null skips it.
    case: str | None = None
    # Your most recent runs to read for the table (1 to 200).
    limit: int = MISSING
    # Keep only rows that differ (or are unknown, ambiguous or one-sided).
    differences_only: bool = MISSING
    # first_difference reports the index of the earliest changed action (or group of parallel actions); none leaves it null.
    jump: str = MISSING


@dataclass
class AttemptComparison(Output):
    case: str
    attempt_a: str
    attempt_b: str
    header: dict[str, Any]
    rows: list[dict[str, Any]]
    first_difference: int | None


@dataclass
class HarnessComparison(Output):
    """Step 5's table of the pair, and the attempt comparison when a case was named."""

    table: Table
    attempts: AttemptComparison | None


@dataclass
class CompareLayout(Layout):
    comparison: HarnessComparison


def differs(row: dict[str, Any]) -> bool:
    """Whether a row of the server's attempt comparison is anything but equal: another status, a field, order or concurrency
    change, an unknown, or a recorded token or cost change (an unrecorded one, `{"unknown": ...}`, is never a difference)."""
    if row["status"] != "same" or row["sequence_changed"] or row["concurrency_changed"]:
        return True
    if any(row[name] for name in ("input_diff", "output_diff", "status_diff")):
        return True
    return any(isinstance(delta, (int, str)) and Decimal(delta) != 0 for delta in (row["token_delta"], row["cost_delta"]))


def summary(header: dict[str, Any], rows: list[dict[str, Any]], first: int | None) -> str:
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    changed = [d["name"] for d in header["condition_differences"]]
    lines = [
        f"compare {header['attempt_a']} with {header['attempt_b']}",
        f"conditions that differ: {', '.join(changed) or 'none'}",
        f"conditions unknown: {', '.join(header['unknown_fields']) or 'none'}",
        "estimate delta: "
        + (f"{header['estimate_delta_ns']} ns" if header["estimate_withheld"] is None else f"withheld ({header['estimate_withheld']})"),
        "rows: " + (", ".join(f"{status} {n}" for status, n in sorted(counts.items())) or "none"),
        "first difference: none" if first is None else f"first difference: row {first}",
    ]
    return "\n".join(lines)


class CompareHarnesses(Run):
    config: CompareConfig
    layout: CompareLayout

    def main(self) -> None:
        config = self.config
        if config.jump not in JUMPS:
            raise ValueError(f"jump must be one of {JUMPS}, not {config.jump!r}")
        if config.harness_a == config.harness_b:
            raise ValueError("harness_a and harness_b are two harnesses")
        results = ResultsConfig(
            server=config.server,
            plugin=config.plugin,
            plugin_version=config.plugin_version,
            benchmark=config.benchmark,
            limit=config.limit,
            as_json=False,
        )
        with config.server.client() as client:
            table = build_table(client, results, [config.harness_a, config.harness_b])
            print(format_table(table))
            attempts = None if config.case is None else self.compare_attempts(client, table)
        self.layout.comparison = HarnessComparison(table=table, attempts=attempts)

    def compare_attempts(self, client: BenchmarkClient, table: Table) -> AttemptComparison:
        config = self.config
        assert config.case is not None
        if config.case not in table.cases:
            raise ValueError(f"{config.benchmark} has no case {config.case}; its cases are {', '.join(table.cases)}")
        ids = []
        for harness in (config.harness_a, config.harness_b):
            row = next((row for row in table.rows if row.harness == harness), None)
            if row is None:
                raise LookupError(f"you have no run of {harness} on {config.benchmark}")
            if config.case not in row.attempts:
                raise LookupError(f"your newest run of {harness} did not take case {config.case}")
            ids.append(row.attempts[config.case])
        result = client.compare_attempts(ids[0], ids[1])
        rows = [row for row in result["rows"] if not config.differences_only or differs(row)]
        first = result["first_difference"] if config.jump == "first_difference" else None
        print(summary(result["header"], rows, first))
        return AttemptComparison(case=config.case, attempt_a=ids[0], attempt_b=ids[1], header=result["header"], rows=rows, first_difference=first)


if __name__ == "__main__":
    CompareHarnesses().run()
