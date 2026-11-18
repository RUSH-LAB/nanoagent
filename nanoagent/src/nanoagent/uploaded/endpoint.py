"""The worker's `openrouter` YAML profile: where the gateway forwards, validated before any work is accepted.

```yaml
openrouter:
  label: production
  mode: openrouter            # or: mock
  upstream_base_url: https://openrouter.ai/api/v1
  api_key_env: OPENROUTER_API_KEY
  mock_hosts: [openrouter-mock]   # mock mode only: the hosts the upstream URL may name
```
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
MODES = ("openrouter", "mock")
KEYS = {"label", "mode", "upstream_base_url", "api_key_env", "mock_hosts"}
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class EndpointConfigError(ValueError):
    """An invalid or incomplete `openrouter` profile; `code` is stable."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True)
class EndpointProfile:
    label: str
    mode: str
    upstream_base_url: str
    api_key_env: str
    mock_hosts: tuple[str, ...]
    api_key: str = field(repr=False)

    @property
    def destination(self) -> str:
        """The scheme, host and port requests go to; recorded with every dispatched call."""
        parts = urlsplit(self.upstream_base_url)
        return f"{parts.scheme}://{parts.netloc}"

    def url_for(self, suffix: str) -> str:
        return f"{self.upstream_base_url}{suffix}"


def _text(config: Mapping[str, Any], key: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise EndpointConfigError("missing_key", f"openrouter.{key} must be a non-empty string")
    return value


def _check_mock_url(url: str, hosts: tuple[str, ...]) -> None:
    try:
        parts = urlsplit(url)
        hostname = parts.hostname
        parts.port  # noqa: B018 - raises ValueError on a malformed port
    except ValueError as error:
        raise EndpointConfigError("invalid_upstream_url", f"{url!r} is not a valid URL: {error}") from error
    if parts.scheme not in ("http", "https") or not hostname:
        raise EndpointConfigError("invalid_upstream_url", f"mock upstream {url!r} must be an http(s) URL with a host")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise EndpointConfigError("invalid_upstream_url", f"mock upstream {url!r} may not carry credentials, a query or a fragment")
    if hostname.lower() not in hosts:
        raise EndpointConfigError("upstream_not_allowed", f"mock upstream host {hostname!r} is not in openrouter.mock_hosts {list(hosts)}")


def parse_endpoint(config: Mapping[str, Any], env: Mapping[str, str]) -> EndpointProfile:
    """Validate the `openrouter` mapping and resolve its credential from ``env``."""
    unknown = sorted(set(config) - KEYS)
    if unknown:
        raise EndpointConfigError("unknown_key", f"unknown openrouter keys {unknown}; allowed: {sorted(KEYS)}")
    mode = _text(config, "mode")
    if mode not in MODES:
        raise EndpointConfigError("invalid_mode", f"openrouter.mode must be one of {MODES}, got {mode!r}")
    label, url, env_name = _text(config, "label"), _text(config, "upstream_base_url"), _text(config, "api_key_env")
    if not _ENV_NAME.match(env_name):
        raise EndpointConfigError("invalid_api_key_env", f"openrouter.api_key_env {env_name!r} is not an environment variable name")
    raw_hosts = config.get("mock_hosts")
    if mode == "openrouter":
        if raw_hosts is not None:
            raise EndpointConfigError("unexpected_key", "openrouter.mock_hosts is only valid in mock mode")
        if url != OPENROUTER_BASE_URL:
            raise EndpointConfigError("upstream_not_allowed", f"openrouter mode only permits {OPENROUTER_BASE_URL}, got {url!r}")
        hosts: tuple[str, ...] = ()
    else:
        if not isinstance(raw_hosts, list) or not raw_hosts or not all(isinstance(host, str) and host for host in raw_hosts):
            raise EndpointConfigError("missing_key", "mock mode needs openrouter.mock_hosts, a non-empty list of host names")
        hosts = tuple(host.lower() for host in raw_hosts)
        _check_mock_url(url, hosts)
    key = env.get(env_name, "")
    if not key.strip():
        raise EndpointConfigError("credential_missing", f"environment variable {env_name} is unset or empty")
    return EndpointProfile(label, mode, url, env_name, hosts, key)
