"""Step 5: read benchmark results from RUSH: your own runs, or everyone's runs on one benchmark.

`scope` is `mine` (every run you made in the workspace, newest first, `GET /runs`) or `all` (every member's runs of the
benchmark `benchmark` of `plugin` at `plugin_version`, `GET /benchmarks/{id}/results`). Rows are run summaries: harness name and
version, benchmark, plugin and version, model, policy, who ran it, total tokens and elapsed time (partial when attempts did not
report them), status and score. They are printed and kept in results.json in two sections, Coding and Task tools, each grouped by
the member who ran the harness and the harness's name@version, newest run first. The step only reads."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run

from nanoagent.uploaded.client import BenchmarkClient, ServerConfig

POLICIES = (("coding", "Coding"), ("task_tools", "Task tools"))


class Scope(Enum):
    MINE = "mine"
    ALL = "all"


@dataclass
class ResultsConfig(Config):
    server: ServerConfig = field(default_factory=ServerConfig)
    scope: Scope = MISSING
    # scope all: the benchmark, by plugin, plugin version and name.
    plugin: str | None = None
    plugin_version: str | None = None
    benchmark: str | None = None
    # The most rows to read (1 to 200).
    limit: int = MISSING


@dataclass
class Group:
    """The runs of one harness version of one member (`user` is {id, name, github}), as run summaries."""

    user: dict[str, Any]
    harness: str
    runs: list[dict[str, Any]]


@dataclass
class Section:
    policy: str
    groups: list[Group]


@dataclass
class Results(Output):
    scope: str
    # The benchmark summary for scope all; null for mine.
    benchmark: dict[str, Any] | None
    sections: list[Section]


@dataclass
class ResultsLayout(Layout):
    results: Results


def metric(sums: dict[str, Any], key: str) -> str:
    """A metric of a run summary, marked partial with the count of attempts that did not report it."""
    total, missing = sums[key]["total"], sums[key]["missing_attempts"]
    value = f"{total / 1000:.3f} s" if key == "elapsed_ms" else f"{total:,}"
    return value + (f" (partial, {missing} attempt{'s' if missing != 1 else ''} did not report it)" if missing else "")


def who(user: dict[str, Any]) -> str:
    return user["name"] + (f" (@{user['github']})" if user["github"] else "")


def sections_of(rows: list[dict[str, Any]]) -> list[Section]:
    """Rows split by policy, then grouped by member and harness name@version in the order they first appear."""
    sections = []
    for policy, _ in POLICIES:
        groups: dict[tuple[str, str], Group] = {}
        for row in rows:
            if row["policy"] == policy:
                harness = f"{row['harness']['name']}@{row['harness']['version']}"
                groups.setdefault((row["user"]["id"], harness), Group(row["user"], harness, [])).runs.append(row)
        sections.append(Section(policy, list(groups.values())))
    return sections


def format_row(row: dict[str, Any]) -> str:
    score = row["score"]
    value = f"{score['passed']}/{score['scored']} scored of {score['total']}" if score["value"] is not None else f"unavailable ({score['unavailable_reason']})"
    plugin = row["plugin"]
    return (
        f"    {row['run_id']} {row['status']}, {value}\n"
        f"      {row['benchmark']['name']} ({plugin['id']} @ {plugin['version']}), {row['model']}, "
        f"{metric(row['metrics'], 'total_tokens')} tokens, {metric(row['metrics'], 'elapsed_ms')}"
    )


def format_results(sections: list[Section]) -> str:
    labels = dict(POLICIES)
    lines = []
    for section in sections:
        lines.append(f"{labels[section.policy]} ({sum(len(group.runs) for group in section.groups)} runs)")
        for group in section.groups:
            lines.append(f"  {who(group.user)}: {group.harness}")
            lines += [format_row(row) for row in group.runs]
    return "\n".join(lines)


class ReadResults(Run):
    config: ResultsConfig
    layout: ResultsLayout

    def main(self) -> None:
        config = self.config
        with config.server.client() as client:
            benchmark, rows = self.read(client)
        sections = sections_of(rows)
        print(format_results(sections))
        self.layout.results = Results(scope=config.scope.value, benchmark=benchmark, sections=sections)

    def read(self, client: BenchmarkClient) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        config = self.config
        if config.scope is Scope.MINE:
            return None, client.list_runs(config.limit)
        if config.plugin is None or config.plugin_version is None or config.benchmark is None:
            raise ValueError("scope all needs `plugin`, `plugin_version` and `benchmark`")
        benchmark = client.find_benchmark(config.plugin, config.plugin_version, config.benchmark)
        return benchmark, client.benchmark_results(benchmark["benchmark_id"], config.limit)


if __name__ == "__main__":
    ReadResults().run()
