"""Framework-independent lifecycle and event stream for web-hosted agent runs."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from jsonschema import Draft202012Validator

from nanoagent import __version__
from nanoagent.harness import (
    Harness as Runner,
    HarnessError as RunnerError,
    HarnessProfile as RunnerProfile,
    HarnessRegistry as RunnerRegistry,
    HarnessRequest as RunnerRequest,
)
from nanoagent.harness.choice import RunModel, RunSettings
from nanoagent.harness.nanoagent import AgentFactory
from nanoagent.runtime.config import HarnessProfileConfig, load_registry
from nanoagent.trajectory.atif import to_atif
from nanoagent.web.config import WebConfig

logger = logging.getLogger(__name__)

_TERMINAL_TYPES = {"done", "error"}
_REQUEST_SCHEMA = json.loads(
    files("nanoagent.web.schema").joinpath("run-request.schema.json").read_text(encoding="utf-8")
)
_REQUEST_VALIDATOR = Draft202012Validator(_REQUEST_SCHEMA)
# What a run chooses for itself, also for task runs, which have no input: its profile, model and settings.
_CHOICE_VALIDATOR = Draft202012Validator(
    {
        "$defs": _REQUEST_SCHEMA["$defs"],
        "type": "object",
        "properties": {key: _REQUEST_SCHEMA["properties"][key] for key in ("profile", "model", "settings")},
    }
)


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
    model: RunModel | None = None
    settings: RunSettings | None = None


@dataclass(frozen=True)
class RunChoice:
    """What a run chose: a profile, a model by provider (in place of the profile's), and settings."""

    profile: str | None = None
    model: RunModel | None = None
    settings: RunSettings | None = None


def _first_error(validator: Draft202012Validator, value: Any) -> None:
    errors = sorted(validator.iter_errors(value), key=lambda error: list(error.path))
    if errors:
        error = errors[0]
        location = ".".join(str(part) for part in error.path)
        raise ValidationError(f"{location + ': ' if location else ''}{error.message}")


def validate_run_choice(value: dict[str, Any]) -> RunChoice:
    """The profile, model and settings ``value`` chose."""
    _first_error(_CHOICE_VALIDATOR, value)
    model = value.get("model")
    return RunChoice(
        profile=value.get("profile"),
        model=None if model is None else RunModel(**model),
        settings=RunSettings.from_dict(value.get("settings")),
    )


def run_limits(cfg: WebConfig) -> dict[str, Any]:
    """The most a run may ask of this host; ``capped`` false when its member sets their own."""
    return {
        "max_steps": cfg.agent.max_steps,
        "cost_limit": cfg.agent.cost_limit,
        "token_limit": cfg.agent.token_limit,
        "max_tokens": cfg.model.max_tokens,
        "capped": not cfg.run_models,
    }


def check_choice(cfg: WebConfig, choice: RunChoice) -> None:
    """Refuse a model this host does not let runs choose, or a setting above its limit."""
    if choice.model is not None and not cfg.run_models:
        raise ValidationError("this NanoAgent runs only its configured profiles; choose a profile")
    if cfg.run_models or choice.settings is None:
        return
    limits = run_limits(cfg)
    for name, value in choice.settings.stated().items():
        cap = limits.get(name)
        if cap is not None and value > cap:
            raise ValidationError(f"settings.{name} may be at most {cap} here")


def validate_run_request(value: Any) -> RunRequest:
    """Validate the deliberately small JSON request surface.

    System messages are rejected in history. Callers use ``instructions`` instead, which is
    appended to the operator-owned base prompt and cannot replace its safety policy.
    """
    _first_error(_REQUEST_VALIDATOR, value)
    body = cast(dict[str, Any], value)
    input_text = cast(str, body["input"])
    if not input_text.strip():
        raise ValidationError("input must be a non-empty string")
    instructions = cast(str | None, body.get("instructions"))
    messages = [dict(message) for message in cast(list[dict[str, Any]], body.get("messages", []))]
    metadata = cast(dict[str, Any] | None, body.get("metadata"))
    choice = validate_run_choice(body)
    return RunRequest(
        input=input_text,
        messages=messages,
        instructions=instructions,
        metadata=metadata,
        profile=choice.profile,
        model=choice.model,
        settings=choice.settings,
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
        # Profile ids surface in URLs, so they stay URL-safe: the check moved here from
        # WebConfig, which now carries file paths (the id is each file's stem).
        for path in cfg.profiles:
            if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,99}", Path(path).stem):
                raise ValueError(
                    "profile ids must start with a lowercase letter or digit and contain "
                    "only lowercase letters, digits, '.', '_' or '-'"
                )
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
            profile_cfg = load_registry(cfg.profiles, HarnessProfileConfig)[cfg.default_profile]
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
        return {**self._runners.public(), "limits": run_limits(self.cfg)}

    @property
    def registry(self) -> RunnerRegistry:
        return self._runners

    async def start(
        self,
        request: RunRequest,
        *,
        runner_profile: RunnerProfile | None = None,
        prices: tuple[float, float] | None = None,
        close: Callable[[], Awaitable[None]] | None = None,
    ) -> ActiveRun:
        """Start ``request`` on its profile (its own build of it when it chose a model or settings),
        or on a caller-built ``runner_profile`` that already honors them. ``prices`` price a chosen
        model; ``close`` releases what was built for this run alone, once it ends."""
        if runner_profile is not None:
            profile = runner_profile
        else:
            choice = RunChoice(request.profile, request.model, request.settings)
            check_choice(self.cfg, choice)
            try:
                if request.model is None and request.settings is None:
                    profile = self._runners.resolve(request.profile)
                else:
                    profile = self._runners.derive(request.profile, request.model, request.settings, prices=prices)
                    close = profile.runner.aclose
            except (KeyError, ValueError) as error:
                raise ValidationError(error.args[0]) from None
        run_id = str(uuid4())
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        task = asyncio.create_task(
            self._run(run_id, request, profile, queue, close=close),
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
        *,
        close: Callable[[], Awaitable[None]] | None = None,
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
            # What the model saw and did, as an ATIF trajectory, for a caller that keeps it (RUSH's chat folders).
            if result.native is not None:
                emit(
                    "trajectory",
                    trajectory=to_atif(
                        result.native,
                        session_id=run_id,
                        harness=profile.harness,
                        harness_version=__version__,
                        model=profile.model,
                    ),
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
                    metrics=result.profile,
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
            if close is not None:
                await close()
            queue.put_nowait(None)
