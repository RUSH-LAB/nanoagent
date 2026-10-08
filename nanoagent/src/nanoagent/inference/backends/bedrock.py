"""Amazon Bedrock Converse backend.

The backend translates NanoAgent's OpenAI-shaped transcript and tool schemas at the transport
boundary. Bedrock's synchronous boto3 client runs in a worker thread so it does not block the
agent loop. Botocore owns service retries; NanoAgent's request timeout becomes its read timeout.
"""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Callable
from typing import Any

from nanoagent.inference.backend import token_cost
from nanoagent.inference.config import LeanInferConfig
from nanoagent.inference.types import Fidelity, Response, ToolCall


class BedrockBackend:
    """Chat and tool calling through the Bedrock Converse API."""

    fidelity = Fidelity.RECONSTRUCTED

    def __init__(self, config: LeanInferConfig, *, client: Any | None = None) -> None:
        if client is None:
            import boto3
            from botocore.config import Config as BotocoreConfig

            session = boto3.Session(
                profile_name=config.aws_profile,
                region_name=config.aws_region,
            )
            client = session.client(
                "bedrock-runtime",
                config=BotocoreConfig(
                    retries={
                        "total_max_attempts": config.max_retries + 1,
                        "mode": "adaptive",
                    },
                    read_timeout=config.request_timeout,
                ),
            )
        self._client = client
        self._model = config.model
        self._temperature = config.temperature
        self._max_tokens = config.max_tokens
        self._input_price = config.input_price
        self._output_price = config.output_price

    @classmethod
    def from_config(cls, config: LeanInferConfig) -> BedrockBackend:
        return cls(config)

    async def generate(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        on_delta: Callable[[str, str], None] | None = None,
    ) -> Response:
        request = self._request(messages, tools)
        reply = await asyncio.to_thread(self._client.converse, **request)
        response = self._response(reply)
        # Converse is deliberately non-streaming in this first backend. Preserve the Backend
        # callback contract by emitting each final channel once.
        if on_delta is not None:
            if response.reasoning:
                on_delta("reasoning", response.reasoning)
            if response.text:
                on_delta("content", response.text)
        return response

    async def aclose(self) -> None:
        close = getattr(self._client, "close", None)
        if close is not None:
            await asyncio.to_thread(close)

    def _request(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        system: list[dict[str, str]] = []
        conversation: list[dict[str, Any]] = []
        for message in messages:
            role = message.get("role")
            if role == "system":
                content = message.get("content")
                if content:
                    system.append({"text": str(content)})
                continue
            converted = _message(message)
            if converted["content"]:
                # Bedrock requires alternating user/assistant messages. Tool results are user
                # blocks, so merge adjacent blocks of the same role before sending.
                if conversation and conversation[-1]["role"] == converted["role"]:
                    conversation[-1]["content"].extend(converted["content"])
                else:
                    conversation.append(converted)

        inference: dict[str, Any] = {}
        if self._max_tokens is not None:
            inference["maxTokens"] = self._max_tokens
        if self._temperature is not None:
            inference["temperature"] = self._temperature
        request: dict[str, Any] = {
            "modelId": self._model,
            "messages": conversation,
        }
        if system:
            request["system"] = system
        if inference:
            request["inferenceConfig"] = inference
        if tools:
            request["toolConfig"] = {"tools": [_tool_spec(tool) for tool in tools]}
        return request

    def _response(self, reply: dict[str, Any]) -> Response:
        content = reply["output"]["message"].get("content", [])
        text: list[str] = []
        reasoning: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in content:
            if "text" in block:
                text.append(block["text"])
            elif "toolUse" in block:
                call = block["toolUse"]
                tool_calls.append(
                    ToolCall(
                        id=call["toolUseId"],
                        name=call["name"],
                        arguments=json.dumps(call.get("input", {}), separators=(",", ":")),
                    )
                )
            else:
                reasoning_block = block.get("reasoningContent", {}).get("reasoningText")
                if isinstance(reasoning_block, dict) and isinstance(
                    reasoning_block.get("text"), str
                ):
                    reasoning.append(reasoning_block["text"])
        raw_usage = reply.get("usage", {})
        prompt = int(raw_usage.get("inputTokens", 0))
        completion = int(raw_usage.get("outputTokens", 0))
        usage = {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": prompt + completion,
        }
        cache_read = int(raw_usage.get("cacheReadInputTokens", 0))
        cache_write = int(raw_usage.get("cacheWriteInputTokens", 0))
        if cache_read:
            usage["cached_tokens"] = cache_read
        if cache_write:
            usage["cache_write_tokens"] = cache_write
        return Response(
            text="".join(text) or None,
            reasoning="".join(reasoning) or None,
            tool_calls=tool_calls,
            usage=usage,
            cost=token_cost(usage, self._input_price, self._output_price),
            finish_reason=reply.get("stopReason"),
        )


def _message(message: dict[str, Any]) -> dict[str, Any]:
    role = message.get("role")
    if role == "tool":
        return {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": str(message.get("tool_call_id", "")),
                        "content": [
                            {"text": str(message.get("content", ""))},
                            *(_image(image) for image in message.get("images", [])),
                        ],
                        "status": "success",
                    }
                }
            ],
        }
    if role not in {"user", "assistant"}:
        raise ValueError(f"Bedrock does not support transcript role {role!r}")
    content: list[dict[str, Any]] = []
    text = message.get("content")
    if text:
        content.append({"text": str(text)})
    if role == "assistant":
        for raw_call in message.get("tool_calls", []) or []:
            function = raw_call.get("function", {})
            arguments = function.get("arguments", "{}")
            try:
                parsed = json.loads(arguments) if isinstance(arguments, str) else arguments
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"assistant tool call {function.get('name')!r} has invalid JSON arguments"
                ) from error
            content.append(
                {
                    "toolUse": {
                        "toolUseId": str(raw_call.get("id", "")),
                        "name": str(function.get("name", "")),
                        "input": parsed,
                    }
                }
            )
    return {"role": role, "content": content}


def _image(image: dict[str, str]) -> dict[str, Any]:
    """One tool-result image (``{"media_type": "image/png", "data": <base64>}``) as a Converse block."""
    kind, _, image_format = image["media_type"].partition("/")
    if kind != "image" or image_format not in {"png", "jpeg", "gif", "webp"}:
        raise ValueError(f"Bedrock cannot show a tool image of type {image['media_type']!r}")
    return {"image": {"format": image_format, "source": {"bytes": base64.b64decode(image["data"])}}}


def _tool_spec(tool: dict[str, Any]) -> dict[str, Any]:
    function = tool.get("function", tool)
    return {
        "toolSpec": {
            "name": function["name"],
            "description": function.get("description") or function["name"],
            "inputSchema": {"json": function.get("parameters", {"type": "object"})},
        }
    }


__all__ = ["BedrockBackend"]
