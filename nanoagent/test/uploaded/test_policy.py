"""The gateway's request policy for the pinned prompt (user and system parts) and provider routing."""

from __future__ import annotations

from typing import Any

import pytest
from service_fakes import MODEL, PROMPT, chat_request, make_policy

from nanoagent.uploaded.policy import PolicyViolation, apply_policy

SYSTEM = "Decide exactly.\n"
STRUCTURED = {"type": "json_schema", "json_schema": {"name": "answer", "schema": {"type": "object"}}}


def apply(body: dict[str, Any], **policy: Any) -> dict[str, Any]:
    effective, _, _ = apply_policy("chat_completions", body, make_policy(**policy), first_prompt_required=True)
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


def test_the_gateways_system_text_is_added_after_the_agents_own_and_is_not_required_of_the_agent() -> None:
    assert apply(chat_request(), prompt_system=SYSTEM)["messages"] == [{"role": "system", "content": SYSTEM}, {"role": "user", "content": PROMPT}]
    body = {**chat_request(), "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": PROMPT}]}
    assert apply(body, prompt_system=SYSTEM)["messages"][0] == {"role": "system", "content": f"Be brief.\n\n{SYSTEM}"}


def test_no_system_text_is_added_without_one_in_the_policy() -> None:
    assert apply(chat_request())["messages"] == chat_request()["messages"]


def test_the_system_text_does_not_replace_the_pinned_user_message() -> None:
    assert violation(chat_request(f"{PROMPT}more"), prompt_system=SYSTEM) == "first_prompt_rewritten"
    assert apply(chat_request(), prompt_system=SYSTEM)["messages"][-1] == {"role": "user", "content": PROMPT}


def test_a_request_without_the_prompt_passes_the_policy_while_a_rewritten_one_does_not() -> None:
    assert apply(chat_request("something else"))["messages"] == chat_request("something else")["messages"]  # a side request
    assert apply({"model": MODEL, "messages": [{"role": "assistant", "content": "hi"}]})["messages"]  # no user message at all
    assert violation(chat_request(PROMPT.strip())) == "first_prompt_rewritten"
    assert violation({"model": MODEL, "messages": [{"role": "user", "content": [{"type": "text", "text": f"> {PROMPT}"}]}]}) == "first_prompt_rewritten"


def test_a_rewritten_first_message_passes_once_the_prompt_is_delivered() -> None:
    effective, _, _ = apply_policy("chat_completions", chat_request(PROMPT.strip()), make_policy(), first_prompt_required=False)
    assert effective["messages"][0]["content"] == PROMPT.strip()


def test_the_submitted_body_is_left_untouched() -> None:
    body = chat_request()
    apply(body, prompt_system=SYSTEM)
    assert body == chat_request()


def test_a_prompt_bound_attempt_policy_needs_a_user_prompt() -> None:
    with pytest.raises(ValueError, match="user prompt"):
        make_policy(prompt_user=None, prompt_system=SYSTEM)


def test_inline_base64_media_is_allowed_and_url_media_is_refused() -> None:
    inline = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
    body = {**chat_request(), "messages": [{"role": "user", "content": [{"type": "text", "text": PROMPT}, inline]}]}
    assert apply(body)["model"] == MODEL
    body["messages"][0]["content"][1] = {"type": "file", "file": {"file_id": "file-1"}}
    assert violation(body) == "media_url_forbidden"
