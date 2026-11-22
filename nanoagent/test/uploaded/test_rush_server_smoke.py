"""The CLI and a worker against a real RUSH server on a scratch database (the local cluster on port 55432, never `mochi`): publish the
acceptance probe's ab-report benchmark through step 1, queue a run by harness name, then claim as a worker and check that the claim and
`GET /attempts/{id}/fixtures` are the shapes the fakes serve (runner_fakes.job_body, fake_rush.publication). Run with `pytest -m rush_server`.

If the cluster is down: `cd helpinghands && npm run db:setup`, then
`cd nanoagent && .venv/bin/python -m pytest -p no:cacheprovider -m rush_server test/uploaded/test_rush_server_smoke.py`."""

from __future__ import annotations

import gzip
import hashlib
import io
import os
import subprocess
import sys
import tarfile
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
import runner_fakes as fx
from fake_rush import CASE_FIELDS, publication
from rush_rules import Invalid, check_finalize, check_run
from rush_server import NANOAGENT, RushServer, rush_server, unavailable
from slimconfig import load_layout

from nanoagent.plugin.package import pack
from nanoagent.uploaded.client import BenchmarkClient

pytestmark = pytest.mark.rush_server

PROBE = NANOAGENT / "test" / "plugins" / "acceptance-probe"
CASES = NANOAGENT / "test" / "acceptance" / "benchmark" / "cases" / "ab_report_cases.yaml"
NAME = "ab-smoke"
MODEL = "deepseek/deepseek-v4-flash-0731"
sys.path[:0] = [str(NANOAGENT / "examples" / "uploaded_benchmark")]

import step1_publish_benchmark  # noqa: E402


@pytest.fixture(scope="module")
def rush() -> Iterator[RushServer]:
    reason = unavailable()
    if reason:
        pytest.skip(reason)
    with rush_server() as server:
        server.seed_plugin(pack(PROBE))
        server.advertise("openrouter", models=(MODEL,))  # the example config's endpoint profile and model
        yield server


def publish(rush: RushServer, home: Path) -> dict:
    env = {**os.environ, "RUSH_SESSION_TOKEN": rush.token}
    done = subprocess.run(
        [
            str(NANOAGENT / ".venv" / "bin" / "python"), "examples/uploaded_benchmark/step1_publish_benchmark.py",
            "config=examples/uploaded_benchmark/configs/step1_publish_benchmark.yaml", f"home={home}", "--",
            f"server.base_url={rush.base_url}", f"server.workspace_id={rush.workspace_id}", f"cases={CASES}", f"name={NAME}", "limits.internet_access=false",
        ],
        cwd=NANOAGENT, env=env, capture_output=True, text=True, timeout=900,
    )  # fmt: skip
    assert done.returncode == 0, done.stdout + done.stderr
    return load_layout(home, step1_publish_benchmark.PublishLayout).benchmark


def claim_all(rush: RushServer, count: int) -> list[dict]:
    capabilities = {
        "wall_time_ms": 600_000, "max_model_calls": 50, "max_output_tokens_per_call": 32768, "max_cost_usd": 1.5, "concurrency": 4, "cpus": 1,
        "memory_mb": 1024, "pids": 256, "workspace_bytes": 268_435_456, "workspace_files": 20_000, "tmp_bytes": 67_108_864, "build_wall_ms": 600_000,
        "build_memory_mb": 3072, "build_output_bytes": 1 << 30, "build_files": 100_000, "build_tmp_bytes": 512 << 20, "internet_access": False, "models": [MODEL],
    }  # fmt: skip
    jobs = []
    for _ in range(count):
        body = {"worker_id": "smoke", "endpoint_profile": {"label": "mock", "mode": "mock"}, "capabilities": capabilities, "interactive": False, "wait_s": 1}
        answer = httpx.post(f"{rush.base_url}/api/benchmark-worker/claim", json=body, headers={"authorization": f"Bearer {rush.worker_token}"})
        assert answer.status_code == 200, answer.text
        jobs.append(answer.json())
    return jobs


def test_publish_queue_claim_and_fetch_fixtures(rush: RushServer, tmp_path: Path) -> None:
    published = publish(rush, tmp_path / "step1")
    assert published.created and "private" not in published.publication
    cases = published.publication["cases"]
    assert all(set(case) == set(CASE_FIELDS) for case in cases) and set(publication()["cases"][0]) == set(CASE_FIELDS)  # the fake publishes the same case shape
    with_fixtures = [case["case_id"] for case in cases if case["fixtures"] is not None]
    assert with_fixtures and len(with_fixtures) < len(cases)

    with BenchmarkClient(rush.base_url, rush.workspace_id, rush.token) as member:
        run = member.create_run(benchmark_id=published.benchmark["benchmark_id"], harness="claude", idempotency_key="smoke-1").run
        assert run["harness"]["name"] == "claude"
        assert member.create_run(benchmark_id=published.benchmark["benchmark_id"], harness="claude", idempotency_key="smoke-1").replayed is True

    expected = fx.job_body()
    for job in claim_all(rush, len(cases)):
        # The claim is exactly what the runner's fakes serve: the same keys at every level, with no case_set, prompt, policy or source.
        assert set(job) == set(expected), set(job) ^ set(expected)
        assert set(job["run"]) == set(expected["run"]) and job["run"]["harness"] == "claude" and job["run"]["interactive"] is False
        assert set(job["task"]) == set(expected["task"]) and set(job["case"]) == set(expected["case"]) and set(job["plugin"]) == set(expected["plugin"])
        case = job["case"]
        assert case["prompt_sha256"] == hashlib.sha256(case["prompt"].encode()).hexdigest()
        fetched = httpx.get(
            f"{rush.base_url}/api/benchmark-worker/attempts/{job['attempt_id']}/fixtures",
            headers={"authorization": f"Bearer {rush.worker_token}", "x-rush-fence": str(job["fence"])},
        )
        if case["fixtures"] is None:
            assert fetched.status_code == 404 and fetched.json()["code"] == "no_fixtures"
            continue
        assert fetched.status_code == 200 and fetched.headers["content-type"] == "application/gzip"
        assert hashlib.sha256(fetched.content).hexdigest() == fetched.headers["x-rush-sha256"] == case["fixtures"]["sha256"]
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(fetched.content))) as tar:
            files = {member.name: hashlib.sha256(tar.extractfile(member).read()).hexdigest() for member in tar if member.isfile()}
        assert files == case["fixtures"]["files"]


def finalize_body(job: dict, **changes: object) -> dict:
    """What a worker finalizes a scored case with, as the runner builds it (runner.py `_finalize`): a verdict with its checks, and the
    session's chats and workspace beside it."""
    return {
        "fence": job["fence"], "execution": {"status": "answered", "reason": None}, "verdict": "pass", "explanation": None, "verifier_error": None,
        "checks": [{"name": "outcome_exists", "status": "passed"}, {"name": "no_extra_changes", "status": "skipped"}],
        "coverage": {"status": "complete"}, "metrics": {"total_tokens": 1}, "final_cursor_expected": 0,
        "chats": [{"agent": "claude", "id": "aaaa1111-0000-4000-8000-000000000001", "title": "say ok", "started_at": "2026-11-20T10:00:00+00:00",
                   "ended_at": "2026-11-20T10:01:00+00:00", "started_ns": "-5", "ended_ns": "60000000000"}],
        **changes,
    }  # fmt: skip


def test_run_requests_and_finalize_bodies_are_judged_as_the_fakes_judge_them(rush: RushServer, tmp_path: Path) -> None:
    published = publish(rush, tmp_path / "step1-rules")
    benchmark_id = published.benchmark["benchmark_id"]
    runs = f"{rush.base_url}/api/workspaces/{rush.workspace_id}/benchmark/runs"
    member = {"authorization": f"Bearer {rush.token}", "origin": rush.base_url}
    case_id = published.publication["cases"][0]["case_id"]

    def post_run(**changes: object) -> httpx.Response:
        body = {"benchmark_id": benchmark_id, "harness": "claude", "idempotency_key": f"rules-{len(changes)}-{sorted(changes)}", **changes}
        return httpx.post(runs, json=body, headers=member)

    # A run request the server refuses is refused by the fake's rules too, and one it takes is taken.
    for changes, status in [
        ({"benchmark_id": "bench-1"}, 400), ({"harness": "rush two words"}, 400), ({"harness": "gemini"}, 400), ({"cases": [case_id]}, 400),
        ({"cases": [case_id, case_id]}, 400), ({"interactive": True}, 400), ({"interactive": "yes"}, 400), ({"extra": 1}, 400),
        ({"harness": "rush mytool"}, 201), ({"harness": "hermes"}, 201),
    ]:
        answered = post_run(**changes)
        assert answered.status_code == status, (changes, answered.text)
        body = {"benchmark_id": benchmark_id, "harness": "claude", "idempotency_key": "k", **changes}
        if status == 400:
            with pytest.raises(Invalid):
                check_run(body)
        else:
            check_run(body)

    jobs = claim_all(rush, 2)
    job = jobs[0]
    worker = {"authorization": f"Bearer {rush.worker_token}"}
    finalize = f"{rush.base_url}/api/benchmark-worker/attempts/{job['attempt_id']}/finalize"

    # Bodies the server refuses, refused by the fake's rules for the same reason.
    refused = [
        finalize_body(job, checks=None), finalize_body(job, verdict=None), finalize_body(job, chats=None),
        finalize_body(job, checks=[{"name": "a", "status": "ok"}]), finalize_body(job, execution={"status": "build_failed", "reason": None}),
        finalize_body(job, workspace={"sha256": "x", "bytes": 1, "chunks": []}),
    ]
    for body in refused:
        answered = httpx.post(finalize, json=body, headers=worker)
        assert answered.status_code == 400, (body, answered.text)
        with pytest.raises(Invalid):
            check_finalize(body)

    # The archive the worker uploads, then the finalize that names it with the checks and chats: the member reads them back.
    archive = b"\x28\xb5\x2f\xfd workspace"
    digest = hashlib.sha256(archive).hexdigest()
    put = httpx.put(
        f"{rush.base_url}/api/benchmark-worker/attempts/{job['attempt_id']}/payloads/{digest}", content=archive,
        headers={**worker, "x-rush-fence": str(job["fence"]), "x-rush-redaction": "none", "content-type": "application/zstd"},
    )
    assert put.status_code == 200, put.text
    body = finalize_body(job, workspace={"sha256": digest, "bytes": len(archive), "chunks": [digest]})
    check_finalize(body)
    done = httpx.post(finalize, json=body, headers=worker)
    assert done.status_code == 200, done.text
    attempt = httpx.get(f"{rush.base_url}/api/workspaces/{rush.workspace_id}/benchmark/attempts/{job['attempt_id']}", headers=member).json()["attempt"]
    assert attempt["checks"] == body["checks"] and attempt["workspace"] == {"bytes": len(archive)}
    assert attempt["verdict"] == "pass"  # the chats were taken with it (200); the attempt's member view does not return them
