"""Configuration owned by the HTTP host, layered over a normal agent definition."""

from __future__ import annotations

from dataclasses import dataclass

from omegaconf import MISSING

from nanoagent.runtime.config import AgentDefinitionConfig


@dataclass
class WebConfig(AgentDefinitionConfig):
    """A server-owned agent definition and its HTTP/runtime bounds.

    Requests cannot override the inherited tool fields. They may provide conversation history,
    additional instructions, and settings within this host's limits; they choose a model only
    among the profiles, unless ``run_models`` lets them name one. Operators remain the only parties
    able to select credentials, backends and executable capabilities.
    """

    default_profile: str = MISSING
    # Registry files, each a complete HarnessProfileConfig; the id is the file's stem (see
    # `nanoagent.runtime.config.load_registry`). At least one; the default must be among them —
    # both checked where the registry loads, since the files are only read there.
    profiles: list[str] = MISSING
    # Plugin directories offered for download at /v1/packages (a marketplace's built-in plugins).
    # Each must follow every rule; ids must be unique, checked where they load. Like any package,
    # one runs here only once a caller installs it.
    packages: list[str] = MISSING
    # Where packages are installed to run (see nanoagent.plugin.install), one folder per sha256.
    installs: str = MISSING
    # What every plugin process runs in (see nanoagent.plugin.sandbox): `bwrap`, `seatbelt` on
    # macOS, or `none`, which confines nothing.
    sandbox: str = MISSING
    # Root of the scratch workspaces plugin runs use, one per run (see nanoagent.web.workspaces).
    workspaces: str = MISSING
    host: str = MISSING
    port: int = MISSING
    api_token: str | None = MISSING
    max_concurrency: int = MISSING
    request_timeout: float = MISSING
    max_request_bytes: int = MISSING
    # The largest file a caller may save into its workspace.
    max_file_bytes: int = MISSING
    max_output_chars: int = MISSING
    heartbeat_seconds: float = MISSING
    include_reasoning: bool = MISSING
    # Whether a run may name its own model (any in the PI catalog its credentials reach) and set
    # its settings beyond the limits above: for a NanoAgent its member runs for themselves (Mochi
    # Lab), whose keys and spending are theirs. Loopback hosts only.
    run_models: bool = MISSING

    def __post_init__(self) -> None:
        for name in ("port", "max_concurrency", "max_request_bytes", "max_file_bytes", "max_output_chars"):
            value = getattr(self, name)
            if isinstance(value, int) and value < 1:
                raise ValueError(f"{name} must be >= 1, got {value}")
        for name in ("request_timeout", "heartbeat_seconds"):
            value = getattr(self, name)
            if isinstance(value, (int, float)) and value <= 0:
                raise ValueError(f"{name} must be > 0, got {value}")
        if isinstance(self.api_token, str) and not self.api_token:
            raise ValueError("api_token must be non-empty or null")
        if isinstance(self.profiles, list) and not self.profiles:
            raise ValueError("profiles must contain at least one server-approved profile")
        loopback = self.host in {"127.0.0.1", "localhost", "::1"}
        if not loopback and not self.api_token:
            raise ValueError("api_token is required when the web host is not loopback-only")
        if self.sandbox not in {"bwrap", "seatbelt", "none", MISSING}:
            raise ValueError(f"sandbox must be bwrap, seatbelt or none, got {self.sandbox!r}")
        if self.run_models is True and isinstance(self.host, str) and not loopback:
            raise ValueError("run_models is for a NanoAgent its member runs on their own computer (a loopback host)")
        if self.agent.events is not None:
            raise ValueError("agent.events must be null for the web host; run events are streamed")
