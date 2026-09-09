"""Framework-independent lifecycle and event stream for web-hosted agent runs."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from importlib.resources import files
from typing import Any, cast
from uuid import uuid4

from jsonschema import Draft202012Validator

from nanoagent.runtime.native_runner import AgentFactory
from nanoagent.runtime.runner import Runner, RunnerError, RunnerRequest
from nanoagent.runtime.runner_factory import RunnerProfile, RunnerRegistry
from nanoagent.web.config import WebConfig

logger = logging.getLogger(__name__)

_TERMINAL_TYPES = {"done", "error"}
_REQUEST_SCHEMA = json.loads(
    files("nanoagent.web.schema").joinpath("run-request.schema.json").read_text(encoding="utf-8")
)
_REQUEST_VALIDATOR = Draft202012Validator(_REQUEST_SCHEMA)


class ValidationError(ValueError):
    """A malformed public run request."""


class OutputLimitError(RuntimeError):
    """The streamed visible answer crossed the operator-owned response bound."""


@dataclass(frozen=True)
class RunRequest:
    """The request-controlled part of a run; model and tools stay in :class:`WebConfig`."""

    input: str
    messages: list[dict[str, Any]]
    instructions: str | None = None
    metadata: dict[str, Any] | None = None
    profile: str | None = None


def validate_run_request(value: Any) -> RunRequest:
    """Validate the deliberately small JSON request surface.

    System messages are rejected in history. Callers use ``instructions`` instead, which is
    appended to the operator-owned base prompt and cannot replace its safety policy.
    """
    errors = sorted(_REQUEST_VALIDATOR.iter_errors(value), key=lambda error: list(error.path))
    if errors:
        error = errors[0]
        location = ".".join(str(part) for part in error.path)
        raise ValidationError(f"{location + ': ' if location else ''}{error.message}")

    body = cast(dict[str, Any], value)
    input_text = cast(str, body["input"])
    if not input_text.strip():
        raise ValidationError("input must be a non-empty string")
    instructions = cast(str | None, body.get("instructions"))
    messages = [dict(message) for message in cast(list[dict[str, Any]], body.get("messages", []))]
    metadata = cast(dict[str, Any] | None, body.get("metadata"))
    profile = cast(str | None, body.get("profile"))
    return RunRequest(
        input=input_text,
        messages=messages,
        instructions=instructions,
        metadata=metadata,
        profile=profile,
    )


@dataclass
class ActiveRun:
    id: str
    _queue: asyncio.Queue[dict[str, Any] | None]
    _task: asyncio.Task[None]
    _heartbeat_seconds: float

    async def events(self) -> AsyncIterator[dict[str, Any] | None]:
        """Yield events; ``None`` is a heartbeat rather than end-of-stream."""
        try:
            while True:
                try:
                    event = await asyncio.wait_for(
                        self._queue.get(), timeout=self._heartbeat_seconds
                    )
                except TimeoutError:
                    yield None
                    continue
                if event is None:
                    return
                yield event
                if event.get("type") in _TERMINAL_TYPES:
                    return
        finally:
            if not self._task.done():
                self._task.cancel()


class RunHost:
    """Own active runs and expose any configured harness through one event protocol."""

    def __init__(
        self,
        cfg: WebConfig,
        *,
        runner: Runner | None = None,
        registry: RunnerRegistry | None = None,
        agent_factory: AgentFactory | None = None,
    ) -> None:
        if sum(value is not None for value in (runner, registry, agent_factory)) > 1:
            raise ValueError("pass only one of runner, registry, or agent_factory")
        self.cfg = cfg
        if registry is not None:
            self._runners = registry
        elif runner is None:
            self._runners = RunnerRegistry.from_config(
                cfg,
                cfg.profiles,
                cfg.default_profile,
                agent_factory=agent_factory,
            )
        else:
            profile_cfg = cfg.profiles[cfg.default_profile]
            self._runners = RunnerRegistry.single(
                runner,
                profile_id=cfg.default_profile,
                label=profile_cfg.label,
                model=profile_cfg.model,
            )
        self._semaphore = asyncio.Semaphore(cfg.max_concurrency)
        self._active: dict[str, asyncio.Task[None]] = {}

    @property
    def active_count(self) -> int:
        return len(self._active)

    @property
    def runner_name(self) -> str:
        return self._runners.resolve(None).harness

    @property
    def capabilities(self) -> dict[str, bool]:
        return self._runners.resolve(None).runner.capabilities.as_dict()

    @property
    def profiles(self) -> dict[str, Any]:
        return self._runners.public()

    async def start(self, request: RunRequest) -> ActiveRun:
        try:
            profile = self._runners.resolve(request.profile)
        except KeyError as error:
            raise ValidationError(str(error)) from None
        run_id = str(uuid4())
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        task = asyncio.create_task(
            self._run(run_id, request, profile, queue),
            name=f"nanoagent-run-{run_id}",
        )
        self._active[run_id] = task
        return ActiveRun(run_id, queue, task, self.cfg.heartbeat_seconds)

    def cancel(self, run_id: str) -> bool:
        task = self._active.get(run_id)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    async def aclose(self) -> None:
        tasks = list(self._active.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await self._runners.aclose()

    async def _run(
        self,
        run_id: str,
        request: RunRequest,
        profile: RunnerProfile,
        queue: asyncio.Queue[dict[str, Any] | None],
    ) -> None:
        output_chars = 0

        def emit(event_type: str, **fields: Any) -> None:
            queue.put_nowait({"type": event_type, "runId": run_id, **fields})

        def progress(event: dict[str, Any]) -> None:
            nonlocal output_chars
            event_type = event["type"]
            fields = {key: value for key, value in event.items() if key != "type"}
            if event_type == "delta":
                kind = fields["kind"]
                text = fields["text"]
                if kind == "reasoning" and not self.cfg.include_reasoning:
                    return
                if kind == "content":
                    output_chars += len(text)
                    if output_chars > self.cfg.max_output_chars:
                        raise OutputLimitError(
                            "agent output exceeded the configured character limit"
                        )
            emit(event_type, **fields)

        runner = profile.runner
        emit(
            "start",
            metadata=request.metadata,
            profile=profile.id,
            harness=profile.harness,
            model=profile.model,
        )
        try:
            if request.messages and not runner.capabilities.history:
                raise RunnerError(
                    f"{runner.name} harness does not support conversation history",
                    code="unsupported_feature",
                )
            async with self._semaphore:
                async with asyncio.timeout(self.cfg.request_timeout):
                    result = await runner.run(
                        RunnerRequest(
                            input=request.input,
                            messages=request.messages,
                            instructions=request.instructions,
                            metadata=request.metadata,
                        ),
                        progress,
                    )
            if len(result.answer) > self.cfg.max_output_chars:
                raise OutputLimitError("agent output exceeded the configured character limit")
            if result.error:
                code = (
                    "output_limit"
                    if result.error.startswith("OutputLimitError:")
                    else "agent_error"
                )
                emit("error", code=code, error=result.error.partition(": ")[2] or result.error)
            else:
                emit(
                    "done",
                    answer=result.answer,
                    stop_reason=result.stop_reason,
                    steps=result.steps,
                    usage=result.usage,
                    cost=result.cost,
                    error=None,
                    profile=profile.id,
                    harness=profile.harness,
                    model=profile.model,
                )
        except TimeoutError:
            emit("error", code="timeout", error="Agent run timed out")
        except asyncio.CancelledError:
            emit("error", code="cancelled", error="Agent run was cancelled")
        except OutputLimitError as error:
            emit("error", code="output_limit", error=str(error))
        except RunnerError as error:
            emit("error", code=error.code, error=str(error))
        except Exception:
            logger.exception("web agent run %s failed", run_id)
            emit("error", code="internal_error", error="Agent run failed")
        finally:
            self._active.pop(run_id, None)
            queue.put_nowait(None)
