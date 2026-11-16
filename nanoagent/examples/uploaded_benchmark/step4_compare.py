"""Step 4: compare two runs of the same verifier, and optionally two sealed attempts of one shared case.

The run comparison is the server's (`GET /compare?a=&b=`, 409 `not_same_verifier` unless both runs have the same plugin
package and task): the differences in effective configuration (case set, policy, model, endpoint, dialects, every limit
including internet access, selection, prompt source), the diff of the prompt (template or instructions) and of the
rendered prompt of each shared case, the cases both runs share (aligned by content, not by id) side by side, the cases
only one has, and whether either run had internet access, so its model calls are unverified.

With `attempt_a` and `attempt_b` (sealed attempts of the same pinned case, from the two runs or any others of the same
package and task) the step also asks the server for their comparison (`GET /compare/attempts?a=&b=`, 409
`not_same_verifier` or `not_same_case` otherwise), which NanoAgent computes deterministically from the attempts' stored
events and payloads: the conditions with every flagged difference first, the latency-adjusted estimate delta (withheld
unless timing method and reference rate match), the rows and the first difference. No step here calls the gateway or any
model endpoint. comparison.json holds both."""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run

from nanoagent.uploaded.client import BenchmarkClient, ServerConfig, run_title

JUMPS = ("first_difference", "none")


@dataclass
class CompareConfig(Config):
    server: ServerConfig = field(default_factory=ServerConfig)
    # The two runs to compare (set them with `-- run_a=<id> run_b=<id>`).
    run_a: str = MISSING
    run_b: str = MISSING
    # Optional: two sealed attempts of the same case content, compared action by action; both null skips it.
    attempt_a: str | None = None
    attempt_b: str | None = None
    # Keep only rows that differ (or are unknown, ambiguous or one-sided).
    differences_only: bool = MISSING
    # first_difference reports the index of the earliest changed action (or group of parallel actions); none leaves it null.
    jump: str = MISSING


@dataclass
class AttemptComparison(Output):
    header: dict[str, Any]
    rows: list[dict[str, Any]]
    first_difference: int | None


@dataclass
class RunComparison(Output):
    """The server's run comparison as it answered, and the attempt comparison when attempts were named."""

    # Each run's harness name@version on the benchmark (plugin @ plugin version).
    title_a: str
    title_b: str
    runs: dict[str, Any]
    attempts: AttemptComparison | None


@dataclass
class CompareLayout(Layout):
    comparison: RunComparison


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


def pair(entry: dict[str, Any]) -> str:
    return f"{entry['a']!r} -> {entry['b']!r}"


def prompt_lines(parts: list[dict[str, Any]]) -> list[str]:
    """The added and removed lines of a prompt diff (``{type: same|removed|added, text}`` parts)."""
    marks = {"added": "+", "removed": "-"}
    return [f"    {marks[part['type']]} {line}" for part in parts if part["type"] in marks for line in str(part["text"]).splitlines()]


def side(entry: dict[str, Any]) -> str:
    """One side of a shared case: its verdict and cost, an unknown cost shown as such."""
    cost = "unknown" if entry["cost_usd"] is None else f"${entry['cost_usd']}"
    uncertain = " (uncertain)" if entry["uncertain_cost"] else ""
    verdict = entry["verdict"] or entry["outcome"]
    return f"{verdict}{' ' + entry['explanation'] if entry.get('explanation') else ''}, cost {cost}{uncertain}"


def run_summary(result: dict[str, Any], a: str, b: str) -> str:
    """The run comparison's configuration and prompt differences, then how the cases line up."""
    lines = [f"compare run {a} with run {b}", "configuration differences:"]
    lines += [f"  {item['field']}: {pair(item)}" for item in result["config"] if item["differs"]] or ["  none"]
    prompt = result["prompt_diff"]
    lines.append("prompt differences:")
    lines += prompt_lines(prompt["text"]) or ["  none in the template or instructions"]
    lines.append(f"  rendered prompts that differ in {sum(1 for case in prompt['rendered'] if not case['identical'])} shared case(s)")
    lines.append(f"cases: {len(result['shared'])} shared, {len(result['only_a'])} only in a, {len(result['only_b'])} only in b")
    lines += [f"  {case['a']['case_id']}: a {side(case['a'])}; b {side(case['b'])}" for case in result["shared"]]
    egress = result["unverified_egress"]
    lines.append(f"unverified egress (internet access on): a {egress['a']}, b {egress['b']}")
    return "\n".join(lines)


class CompareRuns(Run):
    config: CompareConfig
    layout: CompareLayout

    def main(self) -> None:
        config = self.config
        if config.jump not in JUMPS:
            raise ValueError(f"jump must be one of {JUMPS}, not {config.jump!r}")
        if (config.attempt_a is None) != (config.attempt_b is None):
            raise ValueError("attempt_a and attempt_b are set together")
        with config.server.client() as client:
            runs = client.compare_runs(config.run_a, config.run_b)
            title_a, title_b = run_title(client.run(config.run_a)), run_title(client.run(config.run_b))
            print(f"{title_a}\n  against\n{title_b}")
            print(run_summary(runs, config.run_a, config.run_b))
            attempts = None if config.attempt_a is None else self.compare_attempts(client, config.attempt_a, config.attempt_b)
        self.layout.comparison = RunComparison(title_a=title_a, title_b=title_b, runs=runs, attempts=attempts)

    def compare_attempts(self, client: BenchmarkClient, attempt_a: str, attempt_b: str) -> AttemptComparison:
        config = self.config
        result = client.compare_attempts(attempt_a, attempt_b)
        rows = [row for row in result["rows"] if not config.differences_only or differs(row)]
        first = result["first_difference"] if config.jump == "first_difference" else None
        print(summary(result["header"], rows, first))
        return AttemptComparison(header=result["header"], rows=rows, first_difference=first)


if __name__ == "__main__":
    CompareRuns().run()
