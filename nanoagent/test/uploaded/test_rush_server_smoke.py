"""The CLI against a real RUSH server on a scratch database: publish the acceptance probe's benchmark, preview a run, upload a source and submit. Run with `pytest -m rush_server`."""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from rush_server import NANOAGENT, RushServer, rush_server, unavailable
from slimconfig import load_layout

from nanoagent.plugin.package import pack
from nanoagent.uploaded.client import BenchmarkClient

pytestmark = pytest.mark.rush_server

PROBE = NANOAGENT / "test" / "plugins" / "acceptance-probe"
PROBE_CASES = NANOAGENT / "test" / "acceptance" / "benchmark" / "cases" / "probe_cases.json"
NAME = "probe-smoke"
sys.path[:0] = [str(NANOAGENT / "examples" / "uploaded_benchmark"), str(NANOAGENT / "examples" / "benchmark")]

import step1_publish_benchmark  # noqa: E402
import step2_submit_run  # noqa: E402


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable()
    if reason:
        pytest.skip(reason)
    with rush_server() as server:
        server.seed_plugin(pack(PROBE))
        server.advertise("openrouter", models=("deepseek/deepseek-v4-flash-0731",))  # the example config's endpoint profile and model
        yield server


def step(rush: RushServer, number: str, name: str, home: Path, *overrides: str) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "RUSH_SESSION_TOKEN": rush.token}
    done = subprocess.run(
        [
            str(NANOAGENT / ".venv" / "bin" / "python"),
            f"examples/uploaded_benchmark/step{number}_{name}.py",
            f"config=examples/uploaded_benchmark/configs/step{number}_{name}.yaml",
            f"home={home}",
            "--",
            f"server.base_url={rush.base_url}",
            f"server.workspace_id={rush.workspace_id}",
            *overrides,
        ],
        cwd=NANOAGENT,
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    return done


def test_publish_preview_and_submit(rush: RushServer, tmp_path: Path) -> None:
    step1 = tmp_path / "step1"
    step(rush, "1", "publish_benchmark", step1, f"cases={PROBE_CASES}", f"name={NAME}", "limits.internet_access=false", "coding_template=Solve {description}")
    published = load_layout(step1, step1_publish_benchmark.PublishLayout).benchmark
    assert published.created and len(published.publication["cases"]) == 3
    assert "private" not in published.publication
    benchmark_id = published.benchmark["benchmark_id"]

    source = tmp_path / "source"
    source.mkdir()
    (source / "harness.yaml").write_text("protocol: rush.harness.v1\nname: smoke\nversion: '1'\ndialects: [chat_completions]\nrun: [python, main.py]\n")

    with BenchmarkClient(rush.base_url, rush.workspace_id, rush.token) as member:
        ids = [case["case_id"] for case in published.publication["cases"]]
        assert [case["case_id"] for case in member.benchmark(benchmark_id)["cases"]] == ids
        preview = member.preview(benchmark_id, "coding")
        assert [case["case_id"] for case in preview["cases"]] == ids
        assert preview["limits"]["effective"]["internet_access"] is False and preview["prompt"]["text"] == "Solve {description}"

        step2 = tmp_path / "step2"
        done = step(
            rush, "2", "submit_run", step2, f"source={source}", "plugin=acceptance-probe", "plugin_version=0.1.0", f"benchmark={NAME}",
            "idempotency_key=smoke-1", "follow=false",
        )  # fmt: skip
        layout = load_layout(step2, step2_submit_run.RunLayout)
        report = layout.run
        assert [case["case_id"] for case in layout.case_set.cases] == ids
        assert report.replayed is False and len(report.attempts) == 3 and {a.state for a in report.attempts} == {"queued"}
        assert report.policy == "coding" and report.harness["name"] == "smoke" and report.benchmark["name"] == NAME and "Effective configuration" in done.stdout
        step(
            rush, "2", "submit_run", tmp_path / "again", f"source={source}", "plugin=acceptance-probe", "plugin_version=0.1.0", f"benchmark={NAME}",
            "idempotency_key=smoke-1", "follow=false", f"preview_id={report.preview_id}",
        )  # fmt: skip
        repeated = load_layout(tmp_path / "again", step2_submit_run.RunLayout).run
        assert repeated.run_id == report.run_id and repeated.replayed is True
