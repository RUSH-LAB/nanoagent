"""Concurrent, resumable execution of one benchmark against one runner profile."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from nanoagent.benchmark.protocol import (
    BENCHMARK_CASE_PROTOCOL,
    BENCHMARK_RESULT_PROTOCOL,
    BenchmarkAdapter,
    BenchmarkCase,
    BenchmarkScore,
)
from nanoagent.benchmark.environment import EnvironmentOutcome, EnvironmentSession
from nanoagent.benchmark.scorer import ScoringContext
from nanoagent.harness import (
    HarnessProfile as RunnerProfile,
    HarnessRequest as RunnerRequest,
    HarnessResult as RunnerResult,
)
from nanoagent.execution.selection import select_subset


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_text(json.dumps(value, indent=2, default=str), encoding="utf-8")
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _artifact_name(case_id: str) -> str:
    readable = re.sub(r"[^A-Za-z0-9._-]+", "-", case_id).strip("-.")[:80] or "case"
    digest = hashlib.sha256(case_id.encode()).hexdigest()[:10]
    return f"{readable}-{digest}.benchmark.json"


def _read_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path} line {line_number}: invalid JSON: {error}") from error
            if not isinstance(row, dict) or not isinstance(
                row.get("task_id", row.get("case_id")), str
            ):
                raise ValueError(f"{path} line {line_number}: invalid benchmark result row")
            if "task_id" not in row:
                row["task_id"] = row["case_id"]
            if "case_id" not in row:
                row["case_id"] = row["task_id"]
            rows.append(row)
    return rows


def _manifest_identity(
    benchmark: BenchmarkAdapter,
    profile: RunnerProfile,
    selection: dict[str, Any] | None = None,
) -> dict[str, Any]:
    descriptor = benchmark.descriptor
    return {
        "benchmark": {
            "name": descriptor.name,
            "version": descriptor.version,
            "dataset_fingerprint": descriptor.dataset_fingerprint,
        },
        "environment": benchmark.environment.descriptor.to_dict(),
        "scorer": benchmark.scorer.descriptor.to_dict(),
        "metrics": [metric.to_dict() for metric in benchmark.scorer.metrics],
        "profile": {
            "id": profile.id,
            "model": profile.model,
            "harness": profile.harness,
            "configuration_fingerprint": profile.configuration_fingerprint,
        },
        **({"selection": selection} if selection is not None else {}),
    }


def _check_or_create_manifest(
    path: Path,
    benchmark: BenchmarkAdapter,
    profile: RunnerProfile,
    *,
    selected_cases: int,
    selection: dict[str, Any],
    redo: bool,
) -> dict[str, Any]:
    identity = _manifest_identity(benchmark, profile, selection)
    if path.exists() and not redo:
        existing = json.loads(path.read_text(encoding="utf-8"))
        if any(existing.get(key) != value for key, value in identity.items()):
            raise ValueError(
                f"{path.parent} contains results for a different benchmark or profile; "
                "choose another output or set redo=true"
            )
        return existing
    manifest = {
        "protocol": BENCHMARK_RESULT_PROTOCOL,
        "run_id": str(uuid4()),
        "created_at": _now(),
        **identity,
        "selected_cases": selected_cases,
        "selected_tasks": selected_cases,
    }
    _atomic_json(path, manifest)
    return manifest


def _result_row(
    *,
    run_id: str,
    case: BenchmarkCase,
    profile: RunnerProfile,
    result: RunnerResult | None,
    score: BenchmarkScore | None,
    outcome: EnvironmentOutcome | None,
    status: str,
    error: str | None,
    artifact: str,
    duration_seconds: float,
) -> dict[str, Any]:
    return {
        "protocol": BENCHMARK_RESULT_PROTOCOL,
        "run_id": run_id,
        "task_id": case.id,
        "case_id": case.id,
        "task_name": case.name,
        "profile": profile.id,
        "model": profile.model,
        "harness": profile.harness,
        "status": status,
        "answer": result.answer if result else "",
        "stop_reason": result.stop_reason if result else "error",
        "metrics": dict(score.metrics) if score else {},
        "score_details": dict(score.details) if score else {},
        "submission": score.submission if score else (outcome.submission if outcome else None),
        "environment": case.environment.to_dict(),
        "environment_details": dict(outcome.metadata) if outcome else {},
        "steps": result.steps if result else 0,
        "usage": dict(result.usage) if result else {},
        "cost": result.cost if result else 0.0,
        "duration_seconds": duration_seconds,
        "runner_metrics": result.profile if result else None,
        "artifact": artifact,
        "error": error,
    }


async def run_benchmark(
    benchmark: BenchmarkAdapter,
    profile: RunnerProfile,
    *,
    output_dir: str | Path,
    concurrency: int,
    filter_re: str = "",
    slice_spec: str = "",
    shuffle: bool = False,
    redo: bool = False,
    timeout: float | None = None,
    on_done: Any = None,
) -> dict[str, Any]:
    """Run selected cases and return the standardized aggregate summary."""
    if concurrency < 1:
        raise ValueError("benchmark concurrency must be >= 1")
    if timeout is not None and timeout <= 0:
        raise ValueError("benchmark timeout must be > 0 or null")
    run_started = time.perf_counter()
    all_cases = benchmark.tasks()
    case_ids = [case.id for case in all_cases]
    if len(case_ids) != len(set(case_ids)):
        raise ValueError(f"benchmark {benchmark.descriptor.name!r} contains duplicate case ids")
    selected = select_subset(
        all_cases,
        key=lambda case: case.id,
        filter_re=filter_re,
        slice_spec=slice_spec,
        shuffle=shuffle,
    )
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    ledger_path = out / "results.jsonl"
    summary_path = out / "summary.json"
    if redo:
        ledger_path.unlink(missing_ok=True)
        summary_path.unlink(missing_ok=True)
        (out / "predictions.jsonl").unlink(missing_ok=True)
    selection = {"filter": filter_re, "slice": slice_spec, "shuffle": shuffle}
    manifest = _check_or_create_manifest(
        out / "run.json",
        benchmark,
        profile,
        selected_cases=len(selected),
        selection=selection,
        redo=redo,
    )
    completed = {row["case_id"] for row in _read_rows(ledger_path)}
    pending = [case for case in selected if case.id not in completed]
    available, unavailable_reason = profile.runner.availability()
    if not available:
        raise RuntimeError(unavailable_reason or f"runner profile {profile.id!r} is unavailable")
    available, unavailable_reason = benchmark.environment.availability()
    if not available:
        raise RuntimeError(unavailable_reason or "benchmark environment is unavailable")
    available, unavailable_reason = benchmark.scorer.availability()
    if not available:
        raise RuntimeError(unavailable_reason or "benchmark scorer is unavailable")
    semaphore = asyncio.Semaphore(concurrency)
    write_lock = asyncio.Lock()
    scoring_context = ScoringContext(
        output_dir=out.resolve(),
        run_id=manifest["run_id"],
        profile_id=profile.id,
        model=profile.model,
    )

    async def run_one(case: BenchmarkCase) -> dict[str, Any]:
        relative_artifact = f"trajectories/{_artifact_name(case.id)}"
        artifact_path = out / relative_artifact
        events: list[dict[str, Any]] = []
        result: RunnerResult | None = None
        score: BenchmarkScore | None = None
        session: EnvironmentSession | None = None
        outcome: EnvironmentOutcome | None = None
        status = "completed"
        error: str | None = None
        started_at = _now()
        started = time.perf_counter()
        try:
            try:
                session = await benchmark.environment.start(case)
            except Exception as caught:
                status = "environment_error"
                error = f"{type(caught).__name__}: {caught}"
            if session is not None:
                try:
                    prepared = await benchmark.prepare(case)
                except Exception as caught:
                    status = "setup_error"
                    error = f"{type(caught).__name__}: {caught}"
                else:
                    request = RunnerRequest(
                        input=prepared.input,
                        messages=prepared.messages,
                        instructions=prepared.instructions,
                        metadata={"case_id": case.id, "task_name": case.name, **prepared.metadata},
                        workspace=None if session.workspace is None else str(session.workspace),
                    )
                    try:
                        operation = profile.runner.run(
                            request, lambda event: events.append(dict(event))
                        )
                        result = (
                            await asyncio.wait_for(operation, timeout=timeout)
                            if timeout is not None
                            else await operation
                        )
                    except asyncio.TimeoutError:
                        status = "timeout"
                        error = f"exceeded {timeout}s"
                    except Exception as caught:
                        status = "runner_error"
                        error = f"{type(caught).__name__}: {caught}"
                    else:
                        if result.error:
                            status = "runner_error"
                            error = result.error
                try:
                    outcome = await benchmark.environment.capture(case, session)
                except Exception as caught:
                    status = "environment_error"
                    error = f"{type(caught).__name__}: {caught}"
                if status == "completed" and result is not None and outcome is not None:
                    try:
                        score = await benchmark.scorer.score(
                            case, result, session, outcome, scoring_context
                        )
                        benchmark.scorer.validate(score)
                        if benchmark.descriptor.primary_metric not in score.metrics:
                            raise ValueError(
                                "score is missing primary metric "
                                f"{benchmark.descriptor.primary_metric!r}"
                            )
                    except Exception as caught:
                        status = "scorer_error"
                        error = f"{type(caught).__name__}: {caught}"
        finally:
            if session is not None:
                try:
                    await benchmark.environment.close(case, session)
                except Exception as caught:
                    if status == "completed":
                        status = "environment_error"
                        error = f"{type(caught).__name__}: {caught}"
        row = _result_row(
            run_id=manifest["run_id"],
            case=case,
            profile=profile,
            result=result,
            score=score,
            outcome=outcome,
            status=status,
            error=error,
            artifact=relative_artifact,
            duration_seconds=time.perf_counter() - started,
        )
        _atomic_json(
            artifact_path,
            {
                "protocol": BENCHMARK_CASE_PROTOCOL,
                "run_id": manifest["run_id"],
                "task_id": case.id,
                "case_id": case.id,
                "started_at": started_at,
                "finished_at": _now(),
                "task": case.public(),
                "environment": {
                    "session": dict(session.metadata) if session else {},
                    "outcome": dict(outcome.metadata) if outcome else {},
                },
                "events": events,
                "result": row,
            },
        )
        async with write_lock:
            with ledger_path.open("a", encoding="utf-8") as ledger:
                ledger.write(json.dumps(row, separators=(",", ":"), default=str) + "\n")
        if on_done is not None:
            on_done(row)
        return row

    async def guarded(case: BenchmarkCase) -> dict[str, Any]:
        async with semaphore:
            return await run_one(case)

    if pending:
        await asyncio.gather(*(guarded(case) for case in pending))
    rows = _read_rows(ledger_path)
    selected_ids = {case.id for case in selected}
    rows = [row for row in rows if row["case_id"] in selected_ids]
    scores = [
        BenchmarkScore(metrics=row["metrics"], details=row.get("score_details", {}))
        for row in rows
        if row.get("status") == "completed" and row.get("metrics")
    ]
    metrics = benchmark.scorer.aggregate(scores)
    descriptor = benchmark.descriptor
    summary = {
        "protocol": BENCHMARK_RESULT_PROTOCOL,
        "run_id": manifest["run_id"],
        "benchmark": benchmark.public(),
        "profile": _manifest_identity(benchmark, profile)["profile"],
        "primary_metric": {
            "name": descriptor.primary_metric,
            "value": metrics.get(descriptor.primary_metric),
        },
        "metrics": metrics,
        "counts": {
            "selected": len(selected),
            "completed": sum(row.get("status") == "completed" for row in rows),
            "errors": sum(row.get("status") != "completed" for row in rows),
        },
        "usage": {
            key: sum(int(row.get("usage", {}).get(key, 0)) for row in rows)
            for key in sorted({key for row in rows for key in row.get("usage", {})})
        },
        "cost": sum(float(row.get("cost", 0.0)) for row in rows),
        "duration_seconds": time.perf_counter() - run_started,
        "finished_at": _now(),
    }
    _atomic_json(summary_path, summary)
    submissions = [row["submission"] for row in rows if isinstance(row.get("submission"), dict)]
    predictions_path = out / "predictions.jsonl"
    if submissions:
        predictions_path.write_text(
            "".join(json.dumps(item, separators=(",", ":"), default=str) + "\n" for item in submissions),
            encoding="utf-8",
        )
    return summary
