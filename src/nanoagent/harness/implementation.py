"""Harness implementations behind NanoAgent's stable run API.

One place for everything that turns a config into a runnable harness:

  * :class:`NativeRunner` — NanoAgent's own loop through the generic Runner contract.
  * :class:`SubprocessRunner` — JSONL subprocess bridge for out-of-process harnesses.
  * :class:`RunnerProfile` / :class:`RunnerRegistry` / :func:`build_runner` — the
    server-owned harness profile registry.

The wire contract itself (:class:`~nanoagent.harness.base.Runner`,
:class:`~nanoagent.harness.base.RunnerRequest`, etc.) stays in
:mod:`nanoagent.harness.base`, which remains light (no model imports) so modules
that only need the types don't pull in the inference stack.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
from collections.abc import Sequence
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Protocol

from slimconfig import stated

from nanoagent.core.agent import Agent, AgentResult, StopReason
from nanoagent.core import workspace
from nanoagent.runtime.build import build_agent
from nanoagent.runtime.config import (
    AgentDefinitionConfig,
    HarnessProfileConfig,
    load_registry,
    parse_kv_list,
)
from nanoagent.runtime.model import Model
from nanoagent.harness.base import (
    ProgressSink,
    Runner,
    RunnerCapabilities,
    RunnerError,
    RunnerProtocolError,
    RunnerRequest,
    RunnerResult,
    RunnerUnavailableError,
    validate_progress_event,
)

logger = logging.getLogger(__name__)

_STDERR_LIMIT = 64 * 1024
_STREAM_LIMIT = 1024 * 1024


class AgentFactory(Protocol):
    def __call__(self, instructions: str | None) -> tuple[Agent, str]: ...


class NativeRunner:
    name = "native"
    capabilities = RunnerCapabilities(
        streaming=True,
        reasoning=True,
        tools=True,
        usage=True,
        cancellation=True,
        history=True,
    )

    def __init__(
        self,
        cfg: AgentDefinitionConfig,
        *,
        agent_factory: AgentFactory | None = None,
    ) -> None:
        self._cfg = cfg
        self._model = None if agent_factory is not None else Model.from_config(cfg.model)
        self._factory = agent_factory or self._configured_agent

    def _configured_agent(self, instructions: str | None) -> tuple[Agent, str]:
        clean = instructions.strip() if instructions else ""
        suffix = f"Application instructions:\n{clean}" if clean else None
        agent = build_agent(self._cfg, model=self._model, prompt_suffix=suffix)
        return agent, agent.system_prompt

    async def run(self, request: RunnerRequest, emit: ProgressSink) -> RunnerResult:
        agent, system_prompt = self._factory(request.instructions)
        transcript = [
            {"role": "system", "content": system_prompt},
            *[dict(message) for message in request.messages],
        ]
        emitted_tools = 0
        terminal_snapshot: AgentResult | None = None

        def on_delta(kind: str, text: str) -> None:
            emit({"type": "delta", "kind": kind, "text": text})

        def on_step(result: AgentResult) -> None:
            nonlocal emitted_tools, terminal_snapshot
            for row in result.tool_calls[emitted_tools:]:
                emit({"type": "tool", **row})
            emitted_tools = len(result.tool_calls)
            if result.stop_reason is StopReason.RUNNING:
                emit(
                    {
                        "type": "step",
                        "step": result.steps,
                        "usage": result.usage,
                        "cost": result.cost,
                        "metrics": (
                            result.profile.steps[-1].to_dict()
                            if result.profile is not None and result.profile.steps
                            else None
                        ),
                    }
                )
            else:
                terminal_snapshot = result

        try:
            if request.workspace is None:
                result = await agent.run(
                    request.input,
                    messages=transcript,
                    on_delta=on_delta,
                    on_step=on_step,
                )
            else:
                with workspace.use(request.workspace):
                    result = await agent.run(
                        request.input,
                        messages=transcript,
                        on_delta=on_delta,
                        on_step=on_step,
                    )
        except Exception:
            if terminal_snapshot is None:
                raise
            result = terminal_snapshot
        return RunnerResult.from_agent_result(result)

    async def aclose(self) -> None:
        if self._model is not None:
            await self._model.aclose()

    def availability(self) -> tuple[bool, str | None]:
        return True, None


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
        companion_executables = {
            "codex": ("nanoagent-codex-runner", "codex", "Codex CLI"),
            "claude": ("nanoagent-claude-runner", "claude", "Claude Code"),
        }
        if self.name in companion_executables:
            companion, default, label = companion_executables[self.name]
            if self.command == (companion,):
                executable = self.options.get("executable", default)
                if not isinstance(executable, str) or not shutil.which(executable):
                    return False, f"{label} is not installed"
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


_DEFAULT_COMMANDS = {
    "hermes": ("nanoagent-hermes-runner",),
    "pi": ("nanoagent-pi-runner",),
    "codex": ("nanoagent-codex-runner",),
    "claude": ("nanoagent-claude-runner",),
}

_CAPABILITIES = {
    "hermes": RunnerCapabilities(tools=True, usage=True, cancellation=True, history=True),
    # PI tools stay disabled until their workspace semantics are enforced by NanoAgent.
    "pi": RunnerCapabilities(
        streaming=True, reasoning=True, usage=True, cancellation=True, history=True
    ),
    "codex": RunnerCapabilities(tools=True, usage=True, cancellation=True, history=True),
    "claude": RunnerCapabilities(tools=True, usage=True, cancellation=True, history=True),
}

_SECRET_FIELDS = {"api_key", "api_token", "client_secret", "password", "token"}


def _fingerprint_payload(value: Any) -> Any:
    """Remove credentials before hashing a reproducibility identity."""
    if isinstance(value, dict):
        return {
            key: "<redacted>" if key.lower() in _SECRET_FIELDS else _fingerprint_payload(child)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [_fingerprint_payload(child) for child in value]
    return value


def _custom_capabilities(options: dict[str, Any]) -> tuple[RunnerCapabilities, dict[str, Any]]:
    clean = dict(options)
    declared = clean.pop("capabilities", {})
    if not isinstance(declared, dict):
        raise ValueError("custom harness options.capabilities must be an object")
    allowed = set(RunnerCapabilities.__dataclass_fields__)
    unknown = sorted(set(declared) - allowed)
    if unknown:
        raise ValueError(f"unknown custom harness capabilities: {', '.join(unknown)}")
    if any(not isinstance(value, bool) for value in declared.values()):
        raise ValueError("custom harness capabilities must be booleans")
    return RunnerCapabilities(**declared), clean


@dataclass(frozen=True)
class RunnerProfile:
    id: str
    label: str
    harness: str
    model: str
    runner: Runner
    configuration_fingerprint: str | None = None

    def public(self) -> dict[str, Any]:
        availability = getattr(self.runner, "availability", lambda: (True, None))
        available, reason = availability()
        return {
            "id": self.id,
            "label": self.label,
            "harness": self.harness,
            "model": self.model,
            "available": available,
            "unavailableReason": reason,
            "capabilities": self.runner.capabilities.as_dict(),
        }


class RunnerRegistry:
    def __init__(self, profiles: dict[str, RunnerProfile], default_profile: str) -> None:
        if default_profile not in profiles:
            raise ValueError(f"default profile {default_profile!r} is not configured")
        self._profiles = profiles
        self.default_profile = default_profile

    @classmethod
    def from_config(
        cls,
        cfg: AgentDefinitionConfig,
        profile_paths: list[str],
        default_profile: str,
        *,
        agent_factory: AgentFactory | None = None,
    ) -> RunnerRegistry:
        built: dict[str, RunnerProfile] = {}
        definition = AgentDefinitionConfig(
            model=cfg.model,
            agent=cfg.agent,
            tools=cfg.tools,
            tools_dir=cfg.tools_dir,
            allowed_tools=cfg.allowed_tools,
        )
        for profile_id, profile_cfg in load_registry(
            profile_paths, HarnessProfileConfig
        ).items():
            runner = build_runner(
                cfg,
                profile_cfg,
                agent_factory=agent_factory if profile_id == default_profile else None,
            )
            built[profile_id] = RunnerProfile(
                id=profile_id,
                label=profile_cfg.label,
                harness=profile_cfg.harness.type,
                model=profile_cfg.model,
                runner=runner,
                configuration_fingerprint=hashlib.sha256(
                    json.dumps(
                        _fingerprint_payload(
                            {"definition": asdict(definition), "profile": asdict(profile_cfg)}
                        ),
                        sort_keys=True,
                        separators=(",", ":"),
                        default=str,
                    ).encode()
                ).hexdigest(),
            )
        return cls(built, default_profile)

    @classmethod
    def single(
        cls,
        runner: Runner,
        *,
        profile_id: str,
        label: str,
        model: str,
    ) -> RunnerRegistry:
        profile = RunnerProfile(profile_id, label, runner.name, model, runner)
        return cls({profile_id: profile}, profile_id)

    def resolve(self, profile_id: str | None) -> RunnerProfile:
        selected = profile_id or self.default_profile
        try:
            return self._profiles[selected]
        except KeyError:
            known = ", ".join(sorted(self._profiles)) or "none"
            raise KeyError(f"unknown profile {selected!r} (configured: {known})") from None

    def public(self) -> dict[str, Any]:
        return {
            "defaultProfile": self.default_profile,
            "profiles": [self._profiles[key].public() for key in sorted(self._profiles)],
        }

    async def aclose(self) -> None:
        closed: set[int] = set()
        for profile in self._profiles.values():
            identity = id(profile.runner)
            if identity in closed:
                continue
            closed.add(identity)
            await profile.runner.aclose()


def build_runner(
    cfg: AgentDefinitionConfig,
    profile: HarnessProfileConfig,
    *,
    agent_factory: AgentFactory | None = None,
) -> Runner:
    harness = profile.harness
    if harness.type == "native":
        # A partial states only set fields, so an unknown override key already failed at load;
        # only the name itself is still reserved here.
        overrides = stated(profile.model_overrides)
        if "model" in overrides:
            raise ValueError("profile.model owns the native model name; do not override model")
        model = replace(cfg.model, model=profile.model, **overrides)
        definition = AgentDefinitionConfig(
            model=model,
            agent=cfg.agent,
            tools=cfg.tools,
            tools_dir=cfg.tools_dir,
            allowed_tools=cfg.allowed_tools,
        )
        return NativeRunner(definition, agent_factory=agent_factory)
    if agent_factory is not None:
        raise ValueError("agent_factory can only be used with a native default profile")
    command = harness.command or list(_DEFAULT_COMMANDS[harness.type])
    capabilities = _CAPABILITIES.get(harness.type, RunnerCapabilities())
    options = parse_kv_list(harness.options)
    if harness.type == "custom":
        capabilities, options = _custom_capabilities(options)
    return SubprocessRunner(
        harness.type,
        command,
        cwd=harness.cwd,
        options={**options, "model": profile.model},
        capabilities=capabilities,
    )


__all__ = [
    "AgentFactory",
    "NativeRunner",
    "RunnerProfile",
    "RunnerRegistry",
    "SubprocessRunner",
    "build_runner",
]
