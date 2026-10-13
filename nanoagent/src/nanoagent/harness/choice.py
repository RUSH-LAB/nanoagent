"""What one run may choose for itself: a model by provider and id, its settings, and its keys.

A run names either a configured profile, or (on a NanoAgent run for its own member, see
``WebConfig.run_models``, or on a run that brings its own keys) a model from the PI catalog by
its PI provider id. Its settings tune that one run; a harness that cannot honor one refuses it
rather than ignoring it. A run that brings provider API keys reaches its model with those alone,
never with this host's.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, fields
from typing import Any

# PI provider ids the NanoAgent loop (nanoagent.inference.providers) reaches too, by its own name.
NATIVE_PROVIDERS = {"openrouter": "openrouter", "amazon-bedrock": "bedrock"}
PI_PROVIDERS = {native: pi for pi, native in NATIVE_PROVIDERS.items()}
# A provider's API key, as PI and the loop read it from the environment.
KEY_NAME = re.compile(r"[A-Z][A-Z0-9_]*_API_KEY|HF_TOKEN")


def keyed_environ(keys: Mapping[str, str]) -> dict[str, str]:
    """This process's environment with ``keys`` as its only provider keys: every one of its own is removed."""
    return {**{name: value for name, value in os.environ.items() if not KEY_NAME.fullmatch(name)}, **keys}


@dataclass(frozen=True)
class RunModel:
    provider: str
    model: str


@dataclass(frozen=True)
class RunSettings:
    thinking_level: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    max_steps: int | None = None
    cost_limit: float | None = None
    token_limit: int | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any] | None) -> RunSettings | None:
        return None if value is None else cls(**value)

    def stated(self) -> dict[str, Any]:
        """The settings this run set."""
        return {field.name: getattr(self, field.name) for field in fields(self) if getattr(self, field.name) is not None}


# Which settings each kind of run honors.
PI_SETTINGS = frozenset({"thinking_level", "temperature", "max_tokens"})
LOOP_SETTINGS = frozenset({"temperature", "max_tokens", "max_steps", "cost_limit", "token_limit"})


def refuse_unsupported(settings: RunSettings | None, supported: frozenset[str], runner: str) -> None:
    """Raise ValueError naming the first setting ``runner`` cannot honor."""
    for name in settings.stated() if settings else {}:
        if name not in supported:
            raise ValueError(f"{name} does not apply to {runner} runs")
