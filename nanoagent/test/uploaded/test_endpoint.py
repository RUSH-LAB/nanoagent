"""The worker's `openrouter` profile: validated at startup, with specific errors."""

from __future__ import annotations

from typing import Any

import pytest

from nanoagent.uploaded.endpoint import OPENROUTER_BASE_URL, EndpointConfigError, parse_endpoint

ENV = {"OPENROUTER_API_KEY": "sk-real", "MOCK_KEY": "synthetic"}
PRODUCTION: dict[str, Any] = {"label": "production", "mode": "openrouter", "upstream_base_url": OPENROUTER_BASE_URL, "api_key_env": "OPENROUTER_API_KEY"}
MOCK: dict[str, Any] = {"label": "dev-mock", "mode": "mock", "upstream_base_url": "http://openrouter-mock:8080/api/v1", "api_key_env": "MOCK_KEY", "mock_hosts": ["openrouter-mock"]}


def rejected(config: dict[str, Any], code: str, env: dict[str, str] = ENV) -> None:
    with pytest.raises(EndpointConfigError) as raised:
        parse_endpoint(config, env)
    assert raised.value.code == code, raised.value


def test_production_profile() -> None:
    profile = parse_endpoint(PRODUCTION, ENV)
    assert (profile.label, profile.mode, profile.api_key) == ("production", "openrouter", "sk-real")
    assert profile.destination == "https://openrouter.ai" and profile.url_for("/chat/completions") == f"{OPENROUTER_BASE_URL}/chat/completions"
    assert "sk-real" not in repr(profile)


def test_mock_profile_names_its_hosts() -> None:
    profile = parse_endpoint(MOCK, ENV)
    assert profile.destination == "http://openrouter-mock:8080" and profile.mock_hosts == ("openrouter-mock",)


@pytest.mark.parametrize("url", ["http://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/", "https://evil.example/api/v1", "https://openrouter.ai:444/api/v1", "http://openrouter-mock:8080/api/v1"])
def test_openrouter_mode_permits_only_the_approved_origin(url: str) -> None:
    rejected({**PRODUCTION, "upstream_base_url": url}, "upstream_not_allowed")


def test_openrouter_mode_takes_no_mock_hosts() -> None:
    rejected({**PRODUCTION, "mock_hosts": ["openrouter.ai"]}, "unexpected_key")


@pytest.mark.parametrize(
    "overrides,code",
    [
        ({"upstream_base_url": "http://other-host:8080/api/v1"}, "upstream_not_allowed"),
        ({"upstream_base_url": "ftp://openrouter-mock/api/v1"}, "invalid_upstream_url"),
        ({"upstream_base_url": "http://user:pw@openrouter-mock/api/v1"}, "invalid_upstream_url"),
        ({"upstream_base_url": "http://openrouter-mock/api/v1?x=1"}, "invalid_upstream_url"),
        ({"upstream_base_url": "http://openrouter-mock:notaport/api/v1"}, "invalid_upstream_url"),
        ({"mock_hosts": []}, "missing_key"),
        ({"mock_hosts": "openrouter-mock"}, "missing_key"),
    ],
)
def test_mock_mode_requires_an_explicitly_named_host(overrides: dict[str, Any], code: str) -> None:
    rejected({**MOCK, **overrides}, code)


def test_mock_mode_without_hosts_is_rejected() -> None:
    rejected({key: value for key, value in MOCK.items() if key != "mock_hosts"}, "missing_key")


def test_credential_must_be_set_and_non_empty() -> None:
    rejected(PRODUCTION, "credential_missing", {})
    rejected(PRODUCTION, "credential_missing", {"OPENROUTER_API_KEY": "  "})
    rejected({**PRODUCTION, "api_key_env": "not a name"}, "invalid_api_key_env")


@pytest.mark.parametrize(
    "overrides,code",
    [({"mode": "staging"}, "invalid_mode"), ({"extra": 1}, "unknown_key"), ({"label": ""}, "missing_key"), ({"api_key_env": None}, "missing_key")],
)
def test_shape_errors_are_specific(overrides: dict[str, Any], code: str) -> None:
    rejected({**PRODUCTION, **overrides}, code)


def test_missing_keys() -> None:
    for key in ("label", "mode", "upstream_base_url", "api_key_env"):
        rejected({k: v for k, v in PRODUCTION.items() if k != key}, "missing_key")
