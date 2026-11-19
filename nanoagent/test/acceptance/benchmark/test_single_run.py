"""One run of step 2 against the scripted mock: the benchmark's output must be accurate to what the provider did.

The matrix is harness x scenario. Add a harness by adding its row to ``HARNESS_TRAITS`` (expect.py), its
tolerances to tolerances.yaml and its marker here."""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from pathlib import Path

import pytest
from conftest import API_KEY, SCENARIOS, ScenarioRun
from expect import HARNESS_TRAITS, assert_conserved, assert_valid_single_run, tolerances
from mockllm import load_scenario

# A harness's marker, and the scenarios it does not apply to are written in the scenario's `na` (never silent).
HARNESS_MARKS = {
    "nanoagent": pytest.mark.acceptance,
    "claude": pytest.mark.harness_claude,
    "codex": pytest.mark.harness_codex,
    "pi": pytest.mark.harness_pi,
    "dsh": pytest.mark.harness_dsh,
}
PI_RUNNER = Path(__file__).resolve().parents[3] / "js" / "pi-runner" / "dist" / "index.js"


def missing(harness: str) -> str | None:
    """Why a harness cannot run here (its binary or package is absent), or None."""
    needs = {
        "claude": [("the `claude` binary", shutil.which("claude"))],
        "codex": [("`npx`", shutil.which("npx"))],
        "dsh": [("`npx`", shutil.which("npx"))],
        "pi": [("`node`", shutil.which("node")), (f"{PI_RUNNER} (build it: `npm ci && npm run build` in js/pi-runner)", PI_RUNNER.exists())],
    }
    return next((f"{what} is not available" for what, found in needs.get(harness, []) if not found), None)


NAMES = sorted(path.stem for path in SCENARIOS.glob("*.yaml"))
MATRIX = [pytest.param(harness, name, marks=HARNESS_MARKS[harness], id=f"{harness}-{name}") for harness in HARNESS_TRAITS for name in NAMES]


@pytest.mark.parametrize(("harness", "name"), MATRIX)
def test_the_benchmark_records_what_the_provider_did(harness: str, name: str, run_scenario: Callable[..., ScenarioRun]) -> None:
    scenario = load_scenario(SCENARIOS / f"{name}.yaml")
    if harness in scenario.na:
        pytest.skip(f"{name} does not apply to {harness}: {scenario.na[harness]}")
    if reason := missing(harness):
        pytest.skip(reason)
    run = run_scenario(name, harness)
    assert (run.folder / "result.json").exists(), run.done.stdout + run.done.stderr
    result = json.loads((run.folder / "result.json").read_text())
    # Step 2 exits 1 exactly when the run has an error.
    assert run.done.returncode == (1 if result["error"] else 0), run.done.stdout + run.done.stderr
    # Every check runs, so one failure does not hide another.
    failures: list[str] = []
    for check in (
        lambda: assert_valid_single_run(run.folder, API_KEY),
        lambda: assert_conserved(
            run.folder, run.handle, run.scenario, HARNESS_TRAITS[harness], tolerances(harness), case=run.arguments, oracle=run.oracle, key=API_KEY
        ),
    ):
        try:
            check()
        except AssertionError as failure:
            failures.append(str(failure).replace(str(run.folder), "<run>"))
    assert not failures, "\n".join(failures)
