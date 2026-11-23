from __future__ import annotations

import csv
import hashlib
import json
import os
from pathlib import Path

from contract import AbInput, AbReferenceOutput, ScenarioRate

# NanoAgent names the folder the fixtures are staged in.
WORKSPACE_ENV = "NANOAGENT_WORKSPACE"
PREFIX = "ab_"


def ab_reference(given: AbInput) -> AbReferenceOutput:
    """The ground truth, computed from the staged files by this code alone."""
    workspace = Path(os.environ[WORKSPACE_ENV]).resolve()
    rates: list[ScenarioRate] = []
    empty: list[str] = []
    for path in given.csv_paths:
        scenario = Path(path).stem.removeprefix(PREFIX)
        sums = {"A_visits": 0, "A_conversions": 0, "B_visits": 0, "B_conversions": 0}
        rows = 0
        with _staged(workspace, path).open(newline="") as file:
            for row in csv.DictReader(file):
                rows += 1
                for column in sums:
                    sums[column] += int(row[column])
        if rows == 0:
            empty.append(scenario)
            continue
        rates.append(
            ScenarioRate(
                scenario=scenario,
                a_percent=round(100 * sums["A_conversions"] / sums["A_visits"], 4),
                b_percent=round(100 * sums["B_conversions"] / sums["B_visits"], 4),
            )
        )
    if not rates:
        raise ValueError("every scenario is empty: there is no winner to report")
    mean_a = sum(rate.a_percent for rate in rates) / len(rates)
    mean_b = sum(rate.b_percent for rate in rates) / len(rates)
    cloud = json.loads(_staged(workspace, given.cloud_path).read_text())
    return AbReferenceOutput(
        rates=rates,
        empty_scenarios=empty,
        winner="B" if mean_b > mean_a else "A" if mean_a > mean_b else "tie",
        seeded_sha256={
            path.relative_to(workspace).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(workspace.rglob("*"))
            if path.is_file()
        },
        cloud_buckets=cloud["buckets"],
        cloud_logs=cloud["logs"],
    )


def _staged(workspace: Path, relative: str) -> Path:
    path = (workspace / relative).resolve()
    if Path(relative).is_absolute() or not path.is_relative_to(workspace) or not path.is_file():
        raise ValueError(f"{relative!r} is not a staged fixture")
    return path
