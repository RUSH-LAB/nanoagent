"""Build and describe the server-owned harness profile registry."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, fields, replace
from typing import Any

from nanoagent.runtime.config import AgentDefinitionConfig, HarnessProfileConfig, ModelConfig
from nanoagent.runtime.native_runner import AgentFactory, NativeRunner
from nanoagent.runtime.process_runner import SubprocessRunner
from nanoagent.runtime.runner import Runner, RunnerCapabilities

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
        profiles: dict[str, HarnessProfileConfig],
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
        for profile_id, profile_cfg in profiles.items():
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
            raise KeyError(f"unknown profile {selected!r}") from None

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
        allowed = {field.name for field in fields(ModelConfig)}
        unknown = sorted(set(profile.model_overrides) - allowed)
        if unknown:
            raise ValueError(f"unknown native model override(s): {', '.join(unknown)}")
        if "model" in profile.model_overrides:
            raise ValueError("profile.model owns the native model name; do not override model")
        model = replace(cfg.model, model=profile.model, **profile.model_overrides)
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
    options = dict(harness.options)
    if harness.type == "custom":
        capabilities, options = _custom_capabilities(options)
    return SubprocessRunner(
        harness.type,
        command,
        cwd=harness.cwd,
        options={**options, "model": profile.model},
        capabilities=capabilities,
    )
