"""Fixtures for the benchmark's acceptance tests: the acceptance-probe plugin delivered through a fake psql,
and a helper that runs step 2 on it exactly as examples/benchmark/runs/step2_single_run.sh does."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import subprocess
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from mockllm import MockProvider, RunHandle, Scenario, load_scenario
from nanoagent.plugin.package import pack

NANOAGENT = Path(__file__).resolve().parents[3]
PROBE = NANOAGENT / "test" / "plugins" / "acceptance-probe"
PROBE_CASES = NANOAGENT / "test" / "acceptance" / "benchmark" / "cases" / "probe_cases.json"
STEP2 = "examples/benchmark/step2_single_run.py"
STEP2_CONFIG = "examples/benchmark/configs/step2_single_run.yaml"

# The key step 2 reads from API_KEY_ENV: a test-only variable, so the real OPENROUTER_API_KEY is never
# needed, and a value no harness could have by accident.
API_KEY_ENV = "ACCEPTANCE_API_KEY"
API_KEY = "sk-acceptance-sentinel-6f1c9d"

# The test model's prices per million tokens, pairwise distinct so a swapped field shows in the cost.
MODEL = "deepseek/deepseek-v4-flash-0731"
PRICES = {"input": 1.0, "cached_input": 0.25, "cache_write": 1.5, "output": 4.0}


@pytest.fixture(scope="session")
def probe_package() -> bytes:
    """The acceptance-probe plugin's package, as the marketplace stores it."""
    return pack(PROBE)


@pytest.fixture
def fake_psql(tmp_path: Path, probe_package: bytes) -> Callable[..., str]:
    """A factory of psql scripts that ignore their arguments and print the marketplace row of the probe
    plugin: ``version<TAB>sha256<TAB>base64(package)``, which step 2's `unpack` reads. ``sha256`` serves
    that digest instead of the package's own (a corrupted one)."""

    def make(*, sha256: str | None = None, package: bytes | None = None) -> str:
        data = probe_package if package is None else package
        row = f"0.1.0\t{sha256 or hashlib.sha256(data).hexdigest()}\t{base64.b64encode(data).decode()}\n"
        index = len(list(tmp_path.glob("psql-*.sh")))
        (tmp_path / f"psql-{index}.row").write_text(row)
        script = tmp_path / f"psql-{index}.sh"
        script.write_text(f"#!/bin/sh\ncat > /dev/null\ncat '{tmp_path / f'psql-{index}.row'}'\n")
        script.chmod(script.stat().st_mode | stat.S_IXUSR)
        return str(script)

    return make


def run_step2(home: Path, overrides: list[str], env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run step 2 as step2_single_run.sh does, from nanoagent/. The overrides name at least `case=`,
    `harness=`, `psql=` and `openrouter.base_url=`; they follow the helper's own (the probe's cases, the
    test API key and the test prices), so they may replace those."""
    child = {name: value for name, value in os.environ.items() if name != "OPENROUTER_API_KEY"}
    child[API_KEY_ENV] = API_KEY
    child.update(env or {})
    prices = ",".join(f"{name}: {value}" for name, value in PRICES.items())
    return subprocess.run(
        [
            str(NANOAGENT / ".venv" / "bin" / "python"),
            STEP2,
            f"config={STEP2_CONFIG}",
            f"home={home}",
            "--",
            "database=unused",
            f"cases={PROBE_CASES}",
            f"model={MODEL}",
            f"openrouter.api_key_env={API_KEY_ENV}",
            f"prices={{{MODEL}: {{{prices}}}}}",
            *overrides,
        ],
        cwd=NANOAGENT,
        env=child,
        capture_output=True,
        text=True,
        timeout=600,
    )


# ---- the mock-driven runs: a session mock, and one call that runs a scenario through step 2 ----

SCENARIOS = Path(__file__).resolve().parent / "scenarios"


def digest_of(token: str) -> str:
    """The test's own oracle for the probe's `digest` reference: the first 12 hex digits of sha256(token)."""
    return hashlib.sha256(token.encode()).hexdigest()[:12]


@dataclass(frozen=True)
class ScenarioRun:
    folder: Path
    handle: RunHandle
    scenario: Scenario
    done: subprocess.CompletedProcess[str]
    case: str
    arguments: dict[str, Any]
    expected: str  # "answer" or "refuse"
    oracle: dict[str, Any] | None  # the digest the benchmark must pin, from this test's own sha256


def case_of(case: str) -> tuple[dict[str, Any], str]:
    """(arguments, expected) of case id ``acceptance-probe-<n>``, read from the cases file."""
    cases = json.loads(PROBE_CASES.read_text())
    inputs = [(arguments, "answer") for arguments in cases["answer"]] + [(refusal["arguments"], "refuse") for refusal in cases["refuse"]]
    return inputs[int(case.rsplit("-", 1)[1]) - 1]


@pytest.fixture(scope="session")
def mock_provider() -> Iterator[MockProvider]:
    with MockProvider() as mock:
        yield mock


@pytest.fixture
def run_scenario(mock_provider: MockProvider, fake_psql: Callable[..., str], tmp_path: Path) -> Callable[..., ScenarioRun]:
    """``run_scenario(name, harness, overrides=[...])``: registers the scenario with the mock, resolves its
    ``@reference`` from the test's own oracle, and runs step 2 pointed at the mock."""

    def run(name: str, harness: str, *, overrides: list[str] | None = None, case: str | None = None) -> ScenarioRun:
        scenario = load_scenario(SCENARIOS / f"{name}.yaml")
        case = case or scenario.case
        arguments, expected = case_of(case)
        oracle = {"digest": digest_of(arguments["token"])} if expected == "answer" else None
        handle = mock_provider.register(scenario, harness=harness, model=MODEL, refs={"reference": oracle["digest"]} if oracle else {})
        home = tmp_path / "run"
        done = run_step2(
            home,
            [f"psql={fake_psql()}", f"case={case}", f"harness={harness}", f"openrouter.base_url={handle.base_url}", *(overrides or [])],
        )
        return ScenarioRun(home, handle, scenario, done, case, arguments, expected, oracle)

    return run
