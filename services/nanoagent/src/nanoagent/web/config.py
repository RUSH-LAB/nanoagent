"""Configuration owned by the HTTP host, layered over a normal agent definition."""

from __future__ import annotations

import re
from dataclasses import dataclass

from omegaconf import MISSING

from nanoagent.runtime.config import AgentDefinitionConfig, HarnessProfileConfig


@dataclass
class WebConfig(AgentDefinitionConfig):
    """A server-owned agent definition and its HTTP/runtime bounds.

    Requests cannot override the inherited model or tool fields. They may provide conversation
    history and additional instructions; operators remain the only parties able to select
    credentials, backends and executable capabilities.
    """

    default_profile: str = MISSING
    profiles: dict[str, HarnessProfileConfig] = MISSING
    host: str = MISSING
    port: int = MISSING
    api_token: str | None = MISSING
    max_concurrency: int = MISSING
    request_timeout: float = MISSING
    max_request_bytes: int = MISSING
    max_output_chars: int = MISSING
    heartbeat_seconds: float = MISSING
    include_reasoning: bool = MISSING

    def __post_init__(self) -> None:
        for name in ("port", "max_concurrency", "max_request_bytes", "max_output_chars"):
            value = getattr(self, name)
            if isinstance(value, int) and value < 1:
                raise ValueError(f"{name} must be >= 1, got {value}")
        for name in ("request_timeout", "heartbeat_seconds"):
            value = getattr(self, name)
            if isinstance(value, (int, float)) and value <= 0:
                raise ValueError(f"{name} must be > 0, got {value}")
        if isinstance(self.api_token, str) and not self.api_token:
            raise ValueError("api_token must be non-empty or null")
        if isinstance(self.profiles, dict) and not self.profiles:
            raise ValueError("profiles must contain at least one server-approved profile")
        if isinstance(self.profiles, dict):
            for profile_id in self.profiles:
                if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,99}", profile_id):
                    raise ValueError(
                        "profile ids must start with a lowercase letter or digit and contain "
                        "only lowercase letters, digits, '.', '_' or '-'"
                    )
        if (
            isinstance(self.profiles, dict)
            and isinstance(self.default_profile, str)
            and self.default_profile != MISSING
        ):
            if self.default_profile not in self.profiles:
                raise ValueError(f"default_profile {self.default_profile!r} is not in profiles")
        if self.host not in {"127.0.0.1", "localhost", "::1"} and not self.api_token:
            raise ValueError("api_token is required when the web host is not loopback-only")
        if self.agent.events is not None:
            raise ValueError("agent.events must be null for the web host; run events are streamed")
