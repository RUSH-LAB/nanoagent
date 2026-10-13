"""Harness profile selection and construction."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, replace
from collections.abc import Mapping
from typing import Any

from slimconfig import stated

from nanoagent.harness.base import Runner, RunnerCapabilities
from nanoagent.harness.choice import (
    LOOP_SETTINGS,
    NATIVE_PROVIDERS,
    PI_PROVIDERS,
    PI_SETTINGS,
    RunModel,
    RunSettings,
    keyed_environ,
    refuse_unsupported,
)
from nanoagent.harness.nanoagent import AgentFactory, NanoAgentRunner
from nanoagent.harness.subprocess import SubprocessRunner
from nanoagent.inference.providers import OPENROUTER_API_KEY_ENV, MissingKeyError
from nanoagent.runtime.config import (
    AgentDefinitionConfig,
    HarnessProfileConfig,
    load_registry,
    parse_kv_list,
)

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


def _validate_provider_options(harness: str, options: dict[str, Any]) -> None:
    """Fail at profile construction when a built-in harness cannot honor its provider settings."""
    provider = options.get("provider")
    expected = {
        "claude": "bedrock",
        "codex": "bedrock",
    }.get(harness)
    if expected is not None and provider not in {None, expected}:
        raise ValueError(f"{harness} harness provider must be {expected!r} when set")
    uses_bedrock = provider == "bedrock" or (
        harness == "pi" and provider == "amazon-bedrock"
    )
    if uses_bedrock:
        region = options.get("aws_region")
        if not isinstance(region, str) or not region:
            raise ValueError(f"{harness} Bedrock profiles require options.aws_region")
        profile = options.get("aws_profile")
        if profile is not None and (not isinstance(profile, str) or not profile):
            raise ValueError(
                f"{harness} Bedrock option aws_profile must be a non-empty string"
            )


# What a profile of each harness is for: PI answers (fast, no tools), the NanoAgent loop also
# operates plugins' tools.
_USES = {"pi": ["chat", "inline"], "nanoagent": ["chat", "apps"]}


@dataclass(frozen=True)
class RunnerProfile:
    id: str
    label: str
    harness: str
    model: str
    runner: Runner
    configuration_fingerprint: str | None = None
    # The model's provider by its PI id, when the harness names one.
    provider: str | None = None

    def public(self) -> dict[str, Any]:
        availability = getattr(self.runner, "availability", lambda: (True, None))
        available, reason = availability()
        return {
            "id": self.id,
            "label": self.label,
            "harness": self.harness,
            "provider": self.provider,
            "model": self.model,
            "uses": _USES.get(self.harness, ["chat"]),
            "available": available,
            "unavailableReason": reason,
            "capabilities": self.runner.capabilities.as_dict(),
        }


class RunnerRegistry:
    def __init__(
        self,
        profiles: dict[str, RunnerProfile],
        default_profile: str,
        *,
        cfg: AgentDefinitionConfig | None = None,
        configs: dict[str, HarnessProfileConfig] | None = None,
    ) -> None:
        if default_profile not in profiles:
            raise ValueError(f"default profile {default_profile!r} is not configured")
        self._profiles = profiles
        self.default_profile = default_profile
        # What each profile was built from, so one run can have its own build of it (derive).
        self._cfg = cfg
        self._configs = configs or {}

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
        configs = load_registry(profile_paths, HarnessProfileConfig)
        definition = AgentDefinitionConfig(
            model=cfg.model,
            agent=cfg.agent,
            tools=cfg.tools,
            tools_dir=cfg.tools_dir,
            allowed_tools=cfg.allowed_tools,
        )
        for profile_id, profile_cfg in configs.items():
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
                provider=profile_provider(cfg, profile_cfg),
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
        return cls(built, default_profile, cfg=cfg, configs=configs)

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

    def derive(
        self,
        profile_id: str | None,
        model: RunModel | None,
        settings: RunSettings | None,
        *,
        prices: tuple[float, float] | None = None,
        keys: Mapping[str, str] | None = None,
    ) -> RunnerProfile:
        """A one-run build of the profile with the run's model and settings; the caller closes its runner.

        ``prices`` (USD per million input and output tokens) price a model the profile does not name.
        ``keys`` are the run's own provider API keys, its only ones (see :func:`build_runner`).
        """
        base = self.resolve(profile_id)
        config = self._configs.get(base.id)
        if config is None or self._cfg is None:
            raise ValueError(f"profile {base.id!r} takes no run model or settings")
        runner = build_runner(self._cfg, config, model=model, settings=settings, prices=prices, keys=keys)
        return replace(
            base,
            model=model.model if model else base.model,
            provider=model.provider if model else base.provider,
            runner=runner,
            configuration_fingerprint=None,
        )

    @property
    def configs(self) -> dict[str, HarnessProfileConfig]:
        return dict(self._configs)

    def config(self, profile_id: str) -> HarnessProfileConfig:
        """The configuration profile ``profile_id`` was built from."""
        self.resolve(profile_id)
        if profile_id not in self._configs:
            raise KeyError(f"profile {profile_id!r} has no configuration")
        return self._configs[profile_id]

    def public(self) -> dict[str, Any]:
        return {
            "defaultProfile": self.default_profile,
            "profiles": [self._profiles[key].public() for key in sorted(self._profiles)],
        }

    def forget_models(self) -> list[Any]:
        """Drop every model a profile built with the credentials it had (NanoAgentRunner.forget_model)."""
        forgotten = (getattr(profile.runner, "forget_model", lambda: None)() for profile in self._profiles.values())
        return [model for model in forgotten if model is not None]

    async def aclose(self) -> None:
        closed: set[int] = set()
        for profile in self._profiles.values():
            identity = id(profile.runner)
            if identity in closed:
                continue
            closed.add(identity)
            await profile.runner.aclose()


def profile_provider(cfg: AgentDefinitionConfig, profile: HarnessProfileConfig) -> str | None:
    """The provider ``profile``'s model is reached through, by its PI id."""
    if profile.harness.type == "nanoagent":
        native = stated(profile.model_overrides).get("provider", cfg.model.provider)
        return PI_PROVIDERS.get(native, native)
    if profile.harness.type == "pi":
        return parse_kv_list(profile.harness.options).get("provider")
    return None


def loop_model(
    cfg: AgentDefinitionConfig,
    profile: HarnessProfileConfig | None,
    *,
    model: RunModel | None = None,
    settings: RunSettings | None = None,
    prices: tuple[float, float] | None = None,
) -> tuple[Any, Any]:
    """The ModelConfig and AgentConfig a NanoAgent-loop run of ``profile`` (else ``cfg``'s own model) uses."""
    overrides = stated(profile.model_overrides) if profile is not None else {}
    if "model" in overrides:
        raise ValueError("profile.model owns the NanoAgent model name; do not override model")
    refuse_unsupported(settings, LOOP_SETTINGS, "NanoAgent-loop")
    changes: dict[str, Any] = dict(overrides)
    if model is not None:
        if model.provider not in NATIVE_PROVIDERS:
            raise ValueError(f"the NanoAgent loop does not reach {model.provider} models")
        if prices is None:
            raise ValueError(f"no price for {model.provider}/{model.model}")
        changes["provider"] = NATIVE_PROVIDERS[model.provider]
    if prices is not None:
        changes["input_price"], changes["output_price"] = prices
    stated_settings = settings.stated() if settings else {}
    changes.update({key: stated_settings[key] for key in ("temperature", "max_tokens") if key in stated_settings})
    name = model.model if model else profile.model if profile is not None else cfg.model.model
    model_cfg = replace(cfg.model, model=name, **changes)
    agent_cfg = replace(
        cfg.agent,
        **{key: stated_settings[key] for key in ("max_steps", "cost_limit", "token_limit") if key in stated_settings},
    )
    return model_cfg, agent_cfg


def keyed_model(model_cfg: Any, keys: Mapping[str, str]) -> Any:
    """``model_cfg`` reaching its provider with the run's own key, never this host's credentials.

    Raises MissingKeyError (naming the key, never a value) when ``keys`` cannot reach it.
    """
    if model_cfg.provider != "openrouter":
        raise MissingKeyError(f"{model_cfg.provider} models run on this host's own credentials, not a run's keys")
    if OPENROUTER_API_KEY_ENV not in keys:
        raise MissingKeyError(f"this run brings no OpenRouter API key ({OPENROUTER_API_KEY_ENV}) to run {model_cfg.model}")
    return replace(model_cfg, api_key=keys[OPENROUTER_API_KEY_ENV])


def build_runner(
    cfg: AgentDefinitionConfig,
    profile: HarnessProfileConfig,
    *,
    agent_factory: AgentFactory | None = None,
    model: RunModel | None = None,
    settings: RunSettings | None = None,
    prices: tuple[float, float] | None = None,
    keys: Mapping[str, str] | None = None,
) -> Runner:
    """The runner of ``profile``, with a run's model, settings and ``keys`` when it brought them.

    A run's keys are its only provider credentials: the loop's model takes its key from them, and
    PI's process sees them in place of this process's own keys and is told it may use no others.
    """
    harness = profile.harness
    if harness.type == "nanoagent":
        model_cfg, agent_cfg = loop_model(cfg, profile, model=model, settings=settings, prices=prices)
        if keys is not None:
            model_cfg = keyed_model(model_cfg, keys)
        definition = AgentDefinitionConfig(
            model=model_cfg,
            agent=agent_cfg,
            tools=cfg.tools,
            tools_dir=cfg.tools_dir,
            allowed_tools=cfg.allowed_tools,
        )
        return NanoAgentRunner(definition, agent_factory=agent_factory)
    if agent_factory is not None:
        raise ValueError("agent_factory can only be used with a NanoAgent default profile")
    command = harness.command or list(_DEFAULT_COMMANDS[harness.type])
    capabilities = _CAPABILITIES.get(harness.type, RunnerCapabilities())
    options = parse_kv_list(harness.options)
    if (model is not None or settings is not None) and harness.type != "pi":
        raise ValueError(f"the {harness.type} harness takes no run model or settings")
    if keys is not None and harness.type != "pi":
        raise ValueError(f"the {harness.type} harness takes no run keys")
    if harness.type == "pi":
        refuse_unsupported(settings, PI_SETTINGS, "PI")
        if model is not None and model.provider != options.get("provider"):
            # The profile's key and region are its provider's; pi-ai finds the new one's own.
            for key in ("api_key_env", "aws_region", "aws_profile"):
                options.pop(key, None)
            options["provider"] = model.provider
        options.update(settings.stated() if settings else {})
        if keys is not None:
            needed = options.get("api_key_env")
            if needed is not None and needed not in keys:
                raise MissingKeyError(f"this run brings no {needed} to run {model.model if model else profile.model}")
            # Names only: the runner resolves credentials from these alone.
            options["run_keys"] = sorted(keys)
    if harness.type == "custom":
        capabilities, options = _custom_capabilities(options)
    else:
        _validate_provider_options(harness.type, options)
    return SubprocessRunner(
        harness.type,
        command,
        cwd=harness.cwd,
        options={**options, "model": model.model if model else profile.model},
        capabilities=capabilities,
        env=None if keys is None else keyed_environ(keys),
    )


HarnessProfile = RunnerProfile
HarnessRegistry = RunnerRegistry
build_harness = build_runner

__all__ = [
    "HarnessProfile",
    "HarnessRegistry",
    "RunnerProfile",
    "RunnerRegistry",
    "build_harness",
    "build_runner",
    "keyed_model",
]
