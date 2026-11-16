"""The gateway's request policy for the pinned prompt (user and system parts) and provider routing."""

from __future__ import annotations

from typing import Any

import pytest
from service_fakes import MODEL, PROMPT, chat_request, make_policy

from nanoagent.uploaded.policy import PolicyViolation, apply_policy

SYSTEM = "Decide exactly.\n"
STRUCTURED = {"type": "json_schema", "json_schema": {"name": "answer", "schema": {"type": "object"}}}


def apply(body: dict[str, Any], **policy: Any) -> dict[str, Any]:
    effective, _ = apply_policy("chat_completions", body, make_policy(**policy), first_prompt_required=True)
    return effective


def violation(body: dict[str, Any], **policy: Any) -> str:
    with pytest.raises(PolicyViolation) as raised:
        apply(body, **policy)
    return raised.value.code


def test_the_gateway_sets_require_parameters_on_a_request_with_response_format() -> None:
    effective = apply({**chat_request(), "response_format": STRUCTURED})
    assert effective["provider"] == {"order": ["fixed-provider"], "allow_fallbacks": False, "require_parameters": True}


def test_a_request_without_response_format_gets_no_require_parameters() -> None:
    assert "require_parameters" not in apply(chat_request())["provider"]


def test_the_exact_provider_the_gateway_would_set_is_accepted_with_response_format() -> None:
    body = {**chat_request(), "response_format": STRUCTURED, "provider": {"require_parameters": True}}
    assert apply(body)["provider"] == {"order": ["fixed-provider"], "allow_fallbacks": False, "require_parameters": True}


@pytest.mark.parametrize(
    "provider",
    [{"order": ["x"]}, {"require_parameters": False}, {"require_parameters": True, "order": ["x"]}, {"require_parameters": True, "allow_fallbacks": True}, {}],
)
def test_any_other_caller_provider_is_still_rejected(provider: dict[str, Any]) -> None:
    assert violation({**chat_request(), "response_format": STRUCTURED, "provider": provider}) == "provider_routing_forbidden"


def test_require_parameters_from_the_caller_is_rejected_on_a_request_without_response_format() -> None:
    assert violation({**chat_request(), "provider": {"require_parameters": True}}) == "provider_routing_forbidden"


def test_the_system_part_of_the_pinned_prompt_must_be_present_until_a_generation_completes() -> None:
    assert violation(chat_request(), prompt_system=SYSTEM) == "first_prompt_missing"
    body = {**chat_request(), "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": PROMPT}]}
    assert apply(body, prompt_system=SYSTEM)["model"] == MODEL


def test_a_prompt_with_only_a_system_part_ignores_the_users_message() -> None:
    body = {**chat_request("anything"), "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": "anything"}]}
    assert apply(body, prompt_user=None, prompt_system=SYSTEM)["model"] == MODEL
    assert violation(chat_request("anything"), prompt_user=None, prompt_system=SYSTEM) == "first_prompt_missing"


def test_an_attempt_policy_needs_a_prompt_part() -> None:
    with pytest.raises(ValueError, match="prompt"):
        make_policy(prompt_user=None, prompt_system=None)
