"""Steps 3 and 4 on the probe: a batch of concurrent runs against the scripted mock, then the report.

Step 3 gives every run the same overrides, so every run has the same base URL: the mock's pool routes a
request to its run by the case's token, which each request replays. Each run has its own scenario and ledger."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
import yaml
from conftest import API_KEY, API_KEY_ENV, MODEL, NANOAGENT, PRICES, PROBE, PROBE_CASES, SCENARIOS, case_of, digest_of
from expect import HARNESS_TRAITS, FIGURES, assert_conserved, assert_valid_batch, assert_valid_report, close, load_run, run_folders, tolerances
from mockllm import MockProvider, load_scenario
from nanoagent.plugin.package import pack

pytestmark = pytest.mark.acceptance

STEP3 = "examples/benchmark/step3_batch_runs.py"
STEP4 = "examples/benchmark/step4_report.py"
STEP4_CONFIG = "examples/benchmark/configs/step4_report.yaml"
HARNESS = "nanoagent"
# Each run's folder under the batch's runs: <plugin>/<task>/<case>/<harness>.
TASK = Path("acceptance-probe") / "probe"
# case -> scenario: the report mixes right and wrong runs.
SCRIPTS = {
    "acceptance-probe-01": "two-step-answer",
    "acceptance-probe-02": "wrong-answer",
    "acceptance-probe-03": "refuse-correctly",
}


def run_python(script: str, config: str, home: Path, overrides: list[str]) -> subprocess.CompletedProcess[str]:
    env = {name: value for name, value in os.environ.items() if name != "OPENROUTER_API_KEY"}
    env[API_KEY_ENV] = API_KEY
    return subprocess.run(
        [str(NANOAGENT / ".venv" / "bin" / "python"), script, f"config={config}", f"home={home}", "--", *overrides],
        cwd=NANOAGENT,
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
    )


@pytest.fixture(scope="module")
def pipeline(mock_provider: MockProvider, tmp_path_factory: pytest.TempPathFactory) -> dict[str, object]:
    tmp = tmp_path_factory.mktemp("pipeline")
    package = pack(PROBE)
    row = f"0.1.0\t{hashlib.sha256(package).hexdigest()}\t{base64.b64encode(package).decode()}\n"
    (tmp / "psql.row").write_text(row)
    psql = tmp / "psql.sh"
    psql.write_text(f"#!/bin/sh\ncat > /dev/null\ncat '{tmp / 'psql.row'}'\n")
    psql.chmod(psql.stat().st_mode | stat.S_IXUSR)

    # One pool, one base URL; the case's token tells the runs apart.
    members, tokens = {}, {}
    for case, name in SCRIPTS.items():
        arguments, expected = case_of(case)
        refs = {"reference": digest_of(arguments["token"])} if expected == "answer" else {}
        members[arguments["token"]] = (load_scenario(SCENARIOS / f"{name}.yaml"), refs)
        tokens[case] = arguments["token"]
    base_url, handles = mock_provider.register_pool(members, harness=HARNESS, model=MODEL)

    prices = ", ".join(f"{name}: {value}" for name, value in PRICES.items())
    sub_overrides = [
        "database=unused",
        f"model={MODEL}",
        f"openrouter.api_key_env={API_KEY_ENV}",
        f"prices={{{MODEL}: {{{prices}}}}}",
        f"psql={psql}",
        f"openrouter.base_url={base_url}",
    ]
    # Step 3 batches every step1_<name>_cases.json in its cases folder: here, the probe's alone.
    cases = tmp / "cases"
    cases.mkdir()
    shutil.copyfile(PROBE_CASES, cases / "step1_acceptance_probe_cases.json")
    config = tmp / "step3.yaml"
    config.write_text(
        yaml.safe_dump(
            {
                "_ > step3_batch_runs.BatchConfig": None,
                "single_run": "examples/benchmark/configs/step2_single_run.yaml",
                "overrides": sub_overrides,
                "cases": str(cases),
                "answer": 2,
                "refuse": 1,
                "harnesses": [HARNESS],
                "plugins": [],
                "cpus_per_run": 1,
                "max_parallel": len(SCRIPTS),
            }
        ).replace("_ > step3_batch_runs.BatchConfig: null", "_ > step3_batch_runs.BatchConfig:")
    )
    batch_home = tmp / "step3"
    batch = run_python(STEP3, str(config), batch_home, [])
    report_home = tmp / "step4"
    report = run_python(STEP4, STEP4_CONFIG, report_home, [f"runs={batch_home / 'runs'}"])
    return {
        "batch": batch,
        "batch_home": batch_home,
        "report": report,
        "report_home": report_home,
        "handles": {case: handles[token] for case, token in tokens.items()},
        "mock": mock_provider,
        "tmp": tmp,
    }


def output(done: subprocess.CompletedProcess[str]) -> str:
    return done.stdout + done.stderr


def test_the_batch_runs_every_case_and_records_it(pipeline: dict[str, object]) -> None:
    batch_home = pipeline["batch_home"]
    assert pipeline["batch"].returncode == 0, output(pipeline["batch"])
    assert_valid_batch(batch_home, API_KEY)
    runs = json.loads((batch_home / "batch.json").read_text())
    entries = {(run["case"], run["harness"]): run["status"] for run in (runs["runs"] if "runs" in runs else runs["batch"]["runs"])}
    assert set(entries) == {(case, HARNESS) for case in SCRIPTS}
    assert all(status == 0 for status in entries.values())


def test_each_case_is_pinned_once_by_the_plugin(pipeline: dict[str, object]) -> None:
    runs = Path(pipeline["batch_home"]) / "runs"
    for case in SCRIPTS:
        arguments, expected = case_of(case)
        pinned = json.loads((runs / TASK / case / "pinned.json").read_text())
        if expected == "answer":
            # The test's own oracle, not the benchmark's: the probe's digest of the case's token.
            assert (pinned["reference"], pinned["reference_error"]) == ({"digest": digest_of(arguments["token"])}, None)
        else:
            # The plugin rejected the case with the text its cases file names.
            assert pinned["reference"] is None and "has no digest" in pinned["reference_error"]


def test_every_run_is_accurate_to_its_own_provider_script(pipeline: dict[str, object]) -> None:
    runs = Path(pipeline["batch_home"]) / "runs"
    failures: list[str] = []
    for case, handle in pipeline["handles"].items():
        folder = runs / TASK / case / HARNESS
        arguments, expected = case_of(case)
        oracle = {"digest": digest_of(arguments["token"])} if expected == "answer" else None
        try:
            assert_conserved(
                folder, handle, handle.scenario, HARNESS_TRAITS[HARNESS], tolerances(HARNESS), case=arguments, oracle=oracle, key=API_KEY
            )
        except AssertionError as failure:
            failures.append(str(failure).replace(str(folder), f"<{case}>"))
    assert not failures, "\n".join(failures)


def test_concurrent_runs_do_not_cross_talk(pipeline: dict[str, object]) -> None:
    mock: MockProvider = pipeline["mock"]
    assert not mock.violations
    spans: dict[str, tuple[float, float]] = {}
    for case, handle in pipeline["handles"].items():
        handle.ledger.assert_clean()
        calls = handle.ledger.calls
        assert calls, f"{case} made no request"
        token = case_of(case)[0]["token"]
        for call in calls:
            # Every request of the run replays its own case's arguments, and no other case's.
            text = json.dumps(call.request.messages)
            assert token in text, f"{case}: a request without its token"
            for other, other_handle in pipeline["handles"].items():
                other_token = case_of(other)[0]["token"]
                if other != case and other_token != token:
                    assert other_token not in text, f"{case}: a request carries {other}'s token"
        spans[case] = (min(call.arrival for call in calls), max(call.last_byte for call in calls))
    side_by_side = json.loads((Path(pipeline["batch_home"]) / "batch.json").read_text())
    side_by_side = (side_by_side.get("batch") or side_by_side)["side_by_side"]
    if side_by_side < 2:
        pytest.skip("this machine runs one run at a time")
    # The test is meaningful only when runs really overlapped in time.
    ordered = sorted(spans.values())
    overlapping = any(later[0] < earlier[1] for earlier, later in zip(ordered, ordered[1:]))
    assert overlapping, f"no two runs' provider activity overlapped: {spans}"


def test_the_report_is_the_mean_of_the_runs(pipeline: dict[str, object]) -> None:
    report = pipeline["report"]
    assert report.returncode == 0, output(report)
    runs = Path(pipeline["batch_home"]) / "runs"
    assert_valid_report(pipeline["report_home"], runs)
    results = [load_run(folder).result for folder in run_folders(runs)]
    lines = json.loads((Path(pipeline["report_home"]) / "report.json").read_text())
    lines = lines.get("report", lines)
    (line,) = lines["harnesses"]
    assert (line["harness"], line["runs"]) == (HARNESS, 3)
    # Scripted: 01 answers right, 02 answers wrong, 03 refuses right; the harness finishes every run.
    assert (line["correct"], line["errors"]) == (2, 0)
    assert {r.case: r.correct for r in results} == {"acceptance-probe-01": True, "acceptance-probe-02": False, "acceptance-probe-03": True}
    for name in FIGURES:
        assert close(line[name], sum(getattr(r, name) for r in results) / len(results)), name


def test_the_secret_is_nowhere_in_the_outputs(pipeline: dict[str, object]) -> None:
    needle = API_KEY.encode()
    for home in (pipeline["batch_home"], pipeline["report_home"]):
        for path in Path(home).rglob("*"):
            if path.is_file() and not path.is_symlink():
                assert needle not in path.read_bytes(), f"the API key is in {path}"
