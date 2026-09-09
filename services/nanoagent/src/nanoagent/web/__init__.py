"""Server-side HTTP integration for NanoAgent.

The browser-facing application remains responsible for identity and tenancy. This package hosts
the model runtime behind an internal bearer token and exposes a small SSE contract that Node,
Go, Python, or any other HTTP client can consume.
"""

from nanoagent.web.app import create_app
from nanoagent.web.config import WebConfig
from nanoagent.web.runtime import RunHost, RunRequest, ValidationError, validate_run_request

__all__ = [
    "RunHost",
    "RunRequest",
    "ValidationError",
    "WebConfig",
    "create_app",
    "validate_run_request",
]
