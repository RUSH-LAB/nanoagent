"""JSONL subprocess bridge for harnesses implemented outside NanoAgent."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from nanoagent.runtime.runner import (
    ProgressSink,
    RunnerCapabilities,
    RunnerError,
    RunnerProtocolError,
    RunnerRequest,
    RunnerResult,
    RunnerUnavailableError,
    validate_progress_event,
)

_STDERR_LIMIT = 64 * 1024
_STREAM_LIMIT = 1024 * 1024
logger = logging.getLogger(__name__)


class SubprocessRunner:
    """Run one isolated adapter process per request using a line-delimited JSON contract."""

    def __init__(
        self,
        name: str,
        command: Sequence[str],
        *,
        cwd: str | Path | None = None,
        options: dict[str, Any] | None = None,
        capabilities: RunnerCapabilities | None = None,
        shutdown_grace: float = 2.0,
    ) -> None:
        if not command or any(not isinstance(part, str) or not part for part in command):
            raise ValueError("runner command must contain non-empty strings")
        self.name = name
        self.command = tuple(command)
        self.cwd = None if cwd is None else str(cwd)
        self.options = dict(options or {})
        self.capabilities = capabilities or RunnerCapabilities()
        self.shutdown_grace = shutdown_grace

    async def run(self, request: RunnerRequest, emit: ProgressSink) -> RunnerResult:
        try:
            process = await asyncio.create_subprocess_exec(
                *self.command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.cwd,
                env=os.environ.copy(),
                limit=_STREAM_LIMIT,
            )
        except FileNotFoundError as error:
            raise RunnerUnavailableError(
                f"{self.name} runner executable was not found: {self.command[0]}"
            ) from error

        assert process.stdin is not None
        assert process.stdout is not None
        assert process.stderr is not None
        stderr_task = asyncio.create_task(_stderr_tail(process.stderr))
        result: RunnerResult | None = None
        reported_error: RunnerError | None = None
        try:
            payload = {"protocol": "nanoagent.runner.v1", "request": request.to_dict(), "options": self.options}
            process.stdin.write((json.dumps(payload, separators=(",", ":")) + "\n").encode())
            await process.stdin.drain()
            process.stdin.close()
            await process.stdin.wait_closed()

            while line := await process.stdout.readline():
                event = _decode_event(line)
                event_type = event.get("type")
                if result is not None or reported_error is not None:
                    raise RunnerProtocolError("runner emitted data after a terminal event")
                if event_type == "done":
                    result = RunnerResult.from_event(event)
                elif event_type == "error":
                    code = event.get("code", "runner_error")
                    message = event.get("error")
                    if not isinstance(code, str) or not isinstance(message, str):
                        raise RunnerProtocolError("error event requires string code and error")
                    reported_error = RunnerError(message, code=code)
                else:
                    emit(validate_progress_event(event))

            return_code = await process.wait()
            stderr = await stderr_task
            if reported_error is not None:
                raise reported_error
            if return_code != 0:
                if stderr:
                    logger.warning("%s runner stderr: %s", self.name, stderr)
                raise RunnerError(f"{self.name} runner exited with status {return_code}")
            if result is None:
                if stderr:
                    logger.warning("%s runner stderr: %s", self.name, stderr)
                raise RunnerProtocolError(f"{self.name} runner exited without a done event")
            return result
        except asyncio.CancelledError:
            await _stop_process(process, self.shutdown_grace)
            raise
        except Exception:
            await _stop_process(process, self.shutdown_grace)
            raise
        finally:
            if not stderr_task.done():
                stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)

    async def aclose(self) -> None:
        """Processes are request-scoped, so there is no shared resource to close."""

    def availability(self) -> tuple[bool, str | None]:
        executable = self.command[0]
        found = (
            Path(executable).is_file()
            if Path(executable).parent != Path(".")
            else shutil.which(executable) is not None
        )
        if not found:
            return False, f"{self.name} runner is not installed"
        if self.name == "hermes" and self.command == ("nanoagent-hermes-runner",):
            hermes = self.options.get("executable", "hermes")
            if not isinstance(hermes, str) or not shutil.which(hermes):
                return False, "Hermes Agent is not installed"
        return True, None


def _decode_event(line: bytes) -> dict[str, Any]:
    try:
        value = json.loads(line)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RunnerProtocolError("runner emitted invalid JSON") from error
    if not isinstance(value, dict):
        raise RunnerProtocolError("runner event must be a JSON object")
    return value


async def _stderr_tail(stream: asyncio.StreamReader) -> str:
    tail = bytearray()
    while chunk := await stream.read(8192):
        tail.extend(chunk)
        if len(tail) > _STDERR_LIMIT:
            del tail[:-_STDERR_LIMIT]
    return tail.decode(errors="replace").strip()


async def _stop_process(process: asyncio.subprocess.Process, grace: float) -> None:
    if process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=grace)
    except TimeoutError:
        process.kill()
        await process.wait()
