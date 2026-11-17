"""The gateway's per-attempt request policy: what a generation request may not contain, and the parameters the gateway sets itself.

[apply_policy] returns the effective upstream body and leaves the submitted one untouched. Every refusal is a
[PolicyViolation] with a stable code.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

from nanoagent.uploaded.attempt import AttemptPolicy
from nanoagent.uploaded.contract import contains_first_prompt

# Field -> (code, why). A field is refused when it is present and not null.
FORBIDDEN_FIELDS: dict[str, tuple[str, str]] = {
    "models": ("fallback_forbidden", "a fallback model list is not allowed; the attempt is pinned to one model"),
    "route": ("fallback_forbidden", "OpenRouter's `route` fallback selection is not allowed"),
    "plugins": ("plugins_forbidden", "OpenRouter plugins are not allowed"),
    "previous_response_id": ("provider_state_forbidden", "provider-side conversation state is not allowed"),
    "conversation": ("provider_state_forbidden", "provider-side conversation state is not allowed"),
    "web_search_options": ("server_tool_forbidden", "remote server tools are not allowed"),
}

# The only provider routing a caller may send, and only on a request with `response_format`: what the gateway sets there itself.
CALLER_PROVIDER = {"require_parameters": True}

# Each dialect's output-token fields and the one the gateway sets when the caller sets none.
OUTPUT_FIELDS = {
    "chat_completions": ("max_tokens", "max_completion_tokens"),
    "responses": ("max_output_tokens",),
    "anthropic_messages": ("max_tokens",),
}
# Tool `type` values that are client-executed functions; anything else is a remote server tool.
FUNCTION_TOOL_TYPES = {"chat_completions": {"function"}, "responses": {"function"}, "anthropic_messages": {None, "custom"}}


class PolicyViolation(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _check_tools(dialect: str, body: Mapping[str, Any]) -> None:
    tools = body.get("tools")
    if tools is None:
        return
    if not isinstance(tools, list):
        raise PolicyViolation("invalid_request", "`tools` must be an array")
    allowed = FUNCTION_TOOL_TYPES[dialect]
    for index, tool in enumerate(tools):
        kind = tool.get("type") if isinstance(tool, dict) else object()
        if kind not in allowed or (dialect == "chat_completions" and not isinstance(tool.get("function"), dict)):
            raise PolicyViolation("server_tool_forbidden", f"tools[{index}] has type {kind!r}; only function tools the harness executes are allowed")


def _check_media(node: Any) -> None:
    """Refuse media and files the gateway cannot size: a URL or file id costs a few bytes but thousands of input tokens, which
    would break the byte-length spend bound. Inline base64 data is fine, its bytes are counted."""
    if isinstance(node, list):
        for item in node:
            _check_media(item)
    elif isinstance(node, dict):
        url = node.get("image_url")
        url = url.get("url") if isinstance(url, dict) else url
        source = node.get("source")
        if (
            (isinstance(url, str) and not url.startswith("data:"))
            or isinstance(node.get("file_url"), str)
            or isinstance(node.get("file_id"), str)
            or (isinstance(source, dict) and source.get("type") in ("url", "file"))
        ):
            raise PolicyViolation("media_url_forbidden", "media and files must be inline data; URL and file-id references are not allowed")
        for value in node.values():
            _check_media(value)


def _output_cap(dialect: str, body: Mapping[str, Any], cap: int) -> tuple[int | None, str]:
    """The largest requested output-token value (None when the caller set none) and the field to set when it is absent."""
    requested = []
    for name in OUTPUT_FIELDS[dialect]:
        value = body.get(name)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise PolicyViolation("invalid_request", f"`{name}` must be a positive integer")
        if value > cap:
            raise PolicyViolation("output_cap_exceeded", f"`{name}` is {value}; the attempt allows at most {cap} output tokens per call")
        requested.append(value)
    return (max(requested) if requested else None), OUTPUT_FIELDS[dialect][0]


def apply_policy(dialect: str, body: dict[str, Any], policy: AttemptPolicy, *, first_prompt_required: bool) -> tuple[dict[str, Any], int]:
    """Validate ``body`` and return ``(effective upstream body, output-token cap used for the spend bound)``."""
    for name, (code, why) in FORBIDDEN_FIELDS.items():
        if body.get(name) is not None:
            raise PolicyViolation(code, f"`{name}`: {why}")
    if body.get("provider") is not None and not (body.get("provider") == CALLER_PROVIDER and body.get("response_format") is not None):
        raise PolicyViolation("provider_routing_forbidden", "`provider`: the gateway sets provider routing; callers cannot")
    if body.get("store") is True:
        raise PolicyViolation("provider_state_forbidden", "`store: true` asks the provider to keep state, which is not allowed")
    if body.get("model") != policy.model:
        raise PolicyViolation("model_not_pinned", f"the attempt is pinned to model {policy.model!r}, the request asked for {body.get('model')!r}")
    _check_tools(dialect, body)
    _check_media([body.get("messages"), body.get("input"), body.get("system")])
    requested, default_field = _output_cap(dialect, body, policy.max_output_tokens_per_call)
    if first_prompt_required and not contains_first_prompt(dialect, body, policy.prompt_user, policy.prompt_system):
        raise PolicyViolation(
            "first_prompt_missing",
            "until one generation request completes, every request must carry the exact rendered prompt: the user part as a user message and the system part as the system prompt",
        )
    effective = copy.deepcopy(body)
    effective["provider"] = {**policy.provider, "allow_fallbacks": False}
    if body.get("response_format") is not None:
        # A structured-output request must reach a provider that supports every parameter it sends.
        effective["provider"]["require_parameters"] = True
    effective["usage"] = {"include": True}
    if dialect == "chat_completions" and body.get("stream"):
        stream_options = effective.get("stream_options")
        if stream_options is not None and not isinstance(stream_options, dict):
            raise PolicyViolation("invalid_request", "`stream_options` must be an object")
        effective["stream_options"] = {**(stream_options or {}), "include_usage": True}
    if requested is None:
        effective[default_field] = policy.max_output_tokens_per_call
    return effective, requested or policy.max_output_tokens_per_call
