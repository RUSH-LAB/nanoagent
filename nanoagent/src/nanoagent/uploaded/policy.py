"""The gateway's per-attempt request policy: what a generation request may not contain, and the parameters the gateway sets itself.

[apply_policy] returns the effective upstream body and leaves the submitted one untouched. Every refusal is a
[PolicyViolation] with a stable code.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

from nanoagent.uploaded.attempt import AttemptPolicy
from nanoagent.uploaded.contract import rewrites_first_prompt
from nanoagent.uploaded.dialects import append_system

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


def _output_cap(dialect: str, body: Mapping[str, Any], policy: AttemptPolicy) -> tuple[int | None, str]:
    """The largest requested output-token value (None when the caller set none) and the field to set when it is absent. A scored
    run allows its configured cap; a Terminal session anything up to the pinned model's own maximum output."""
    requested = []
    for name in OUTPUT_FIELDS[dialect]:
        value = body.get(name)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise PolicyViolation("invalid_request", f"`{name}` must be a positive integer")
        if policy.prompt_bound and value > policy.max_output_tokens_per_call:
            raise PolicyViolation("output_cap_exceeded", f"`{name}` is {value}; the attempt allows at most {policy.max_output_tokens_per_call} output tokens per call")
        if not policy.prompt_bound and value > policy.model_max_output_tokens:
            raise PolicyViolation(
                "output_cap_exceeded", f"`{name}` is {value}; {policy.model} writes at most {policy.model_max_output_tokens} output tokens per call. Set it to {policy.model_max_output_tokens} or less."
            )
        requested.append(value)
    return (max(requested) if requested else None), OUTPUT_FIELDS[dialect][0]


def apply_policy(dialect: str, body: dict[str, Any], policy: AttemptPolicy, *, first_prompt_required: bool) -> tuple[dict[str, Any], int | None, int]:
    """Validate ``body`` and return ``(effective upstream body, requested output tokens or None, effective output-token cap,
    which bounds the spend)``."""
    for name, (code, why) in FORBIDDEN_FIELDS.items():
        if body.get(name) is not None:
            raise PolicyViolation(code, f"`{name}`: {why}")
    if body.get("provider") is not None and not (body.get("provider") == CALLER_PROVIDER and body.get("response_format") is not None):
        raise PolicyViolation("provider_routing_forbidden", "`provider`: the gateway sets provider routing; callers cannot")
    if body.get("store") is True:
        raise PolicyViolation("provider_state_forbidden", "`store: true` asks the provider to keep state, which is not allowed")
    if body.get("model") != policy.model:
        if not policy.prompt_bound:  # a Terminal session: the agent's CLI shows the member this message
            raise PolicyViolation(
                "model_not_pinned",
                f"This RUSH terminal runs every agent on {policy.model}, and this call asked for {body.get('model')!r}. "
                "Set your agent's model to $RUSH_MODEL (e.g. --model openai/$RUSH_MODEL).",
            )
        raise PolicyViolation("model_not_pinned", f"the attempt is pinned to model {policy.model!r}, the request asked for {body.get('model')!r}")
    _check_tools(dialect, body)
    _check_media([body.get("messages"), body.get("input"), body.get("system")])
    requested, default_field = _output_cap(dialect, body, policy)
    # Until the prompt is delivered, a request that carries no user message equal to it is forwarded (an agent CLI makes side requests, such as
    # a title or a background-model call); one whose first user message wraps or alters the prompt is a rewritten case prompt.
    if first_prompt_required and policy.prompt_user is not None and rewrites_first_prompt(dialect, body, policy.prompt_user):
        raise PolicyViolation(
            "first_prompt_rewritten",
            "the first user message contains the case prompt with other text around it; the prompt must reach the model as the exact rendered text",
        )
    effective = copy.deepcopy(body)
    if policy.prompt_system is not None:  # the gateway's own system text, after the agent's: the pinned user message is untouched
        append_system(dialect, effective, policy.prompt_system)
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
    return effective, requested, requested or policy.max_output_tokens_per_call
