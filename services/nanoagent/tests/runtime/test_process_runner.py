from __future__ import annotations

import asyncio
import sys

import pytest

from nanoagent.runtime.process_runner import SubprocessRunner
from nanoagent.runtime.runner import (
    RunnerError,
    RunnerProtocolError,
    RunnerRequest,
    RunnerUnavailableError,
)


@pytest.mark.asyncio
async def test_process_runner_round_trips_request_progress_and_result() -> None:
    script = """
import json, sys
payload = json.loads(sys.stdin.readline())
request = payload["request"]
print(json.dumps({"type": "delta", "kind": "content", "text": request["input"]}))
print(json.dumps({"type": "step", "step": 1, "usage": {"total_tokens": 2}, "cost": 0.1}))
print(json.dumps({
    "type": "done", "answer": payload["options"]["answer"], "stop_reason": "answer",
    "steps": 1, "usage": {"total_tokens": 2}, "cost": 0.1, "error": None,
}))
"""
    runner = SubprocessRunner(
        "test",
        [sys.executable, "-c", script],
        options={"answer": "finished"},
    )
    events: list[dict[str, object]] = []

    result = await runner.run(RunnerRequest(input="hello"), events.append)

    assert events == [
        {"type": "delta", "kind": "content", "text": "hello"},
        {"type": "step", "step": 1, "usage": {"total_tokens": 2}, "cost": 0.1},
    ]
    assert result.answer == "finished"
    assert result.usage == {"total_tokens": 2}


@pytest.mark.asyncio
async def test_process_runner_surfaces_reported_error() -> None:
    script = "import sys; sys.stdin.readline(); print('{\"type\":\"error\",\"code\":\"denied\",\"error\":\"blocked\"}')"
    runner = SubprocessRunner("test", [sys.executable, "-c", script])

    with pytest.raises(RunnerError, match="blocked") as caught:
        await runner.run(RunnerRequest(input="hello"), lambda _event: None)

    assert caught.value.code == "denied"


@pytest.mark.asyncio
async def test_process_runner_rejects_invalid_protocol() -> None:
    script = "import sys; sys.stdin.readline(); print('not json')"
    runner = SubprocessRunner("test", [sys.executable, "-c", script])

    with pytest.raises(RunnerProtocolError, match="invalid JSON"):
        await runner.run(RunnerRequest(input="hello"), lambda _event: None)


@pytest.mark.asyncio
async def test_process_runner_does_not_expose_stderr_to_api_callers() -> None:
    script = "import sys; sys.stdin.readline(); print('private detail', file=sys.stderr); raise SystemExit(7)"
    runner = SubprocessRunner("test", [sys.executable, "-c", script])

    with pytest.raises(RunnerError, match="exited with status 7") as caught:
        await runner.run(RunnerRequest(input="hello"), lambda _event: None)

    assert "private detail" not in str(caught.value)


@pytest.mark.asyncio
async def test_process_runner_cancellation_stops_child() -> None:
    script = "import sys, time; sys.stdin.readline(); time.sleep(30)"
    runner = SubprocessRunner("test", [sys.executable, "-c", script], shutdown_grace=0.1)
    task = asyncio.create_task(runner.run(RunnerRequest(input="wait"), lambda _event: None))
    await asyncio.sleep(0.05)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=1)


@pytest.mark.asyncio
async def test_process_runner_reports_missing_executable() -> None:
    runner = SubprocessRunner("missing", ["nanoagent-command-that-does-not-exist"])

    with pytest.raises(RunnerUnavailableError, match="was not found"):
        await runner.run(RunnerRequest(input="hello"), lambda _event: None)


def test_process_runner_requires_an_explicit_argv() -> None:
    with pytest.raises(ValueError, match="non-empty strings"):
        SubprocessRunner("bad", [])
    with pytest.raises(ValueError, match="non-empty strings"):
        SubprocessRunner("bad", [""])
