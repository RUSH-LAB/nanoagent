from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.harness.adapters.claude import _command as claude_command
from nanoagent.harness.adapters.codex import _command as codex_command
from nanoagent.harness.adapters._coding_cli import aws_environment
from nanoagent.harness.registry import _validate_provider_options
from nanoagent.inference.backends.bedrock import BedrockBackend
from nanoagent.inference.config import LeanInferConfig


class FakeBedrock:
    def __init__(self) -> None:
        self.request = None

    def converse(self, **request):
        self.request = request
        return {
            "output": {
                "message": {
                    "role": "assistant",
                    "content": [
                        {"text": "checking"},
                        {
                            "toolUse": {
                                "toolUseId": "call-1",
                                "name": "lookup",
                                "input": {"query": "x"},
                            }
                        },
                    ],
                }
            },
            "stopReason": "tool_use",
            "usage": {
                "inputTokens": 10,
                "outputTokens": 4,
                "cacheReadInputTokens": 3,
            },
        }


@pytest.mark.asyncio
async def test_bedrock_translates_messages_tools_and_usage() -> None:
    client = FakeBedrock()
    backend = BedrockBackend(
        LeanInferConfig(
            provider="bedrock",
            model="us.anthropic.example",
            temperature=None,
            max_tokens=100,
            input_price=2.0,
            output_price=4.0,
        ),
        client=client,
    )

    response = await backend.generate(
        [
            {"role": "system", "content": "help"},
            {"role": "user", "content": "find x"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "previous",
                        "type": "function",
                        "function": {"name": "lookup", "arguments": '{"query":"old"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "previous", "content": "old result"},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "lookup",
                    "description": "Look up a value",
                    "parameters": {"type": "object"},
                },
            }
        ],
    )

    assert client.request["modelId"] == "us.anthropic.example"
    assert client.request["system"] == [{"text": "help"}]
    assert client.request["messages"][-1]["content"][0]["toolResult"]["toolUseId"] == "previous"
    assert client.request["toolConfig"]["tools"][0]["toolSpec"]["name"] == "lookup"
    assert response.text == "checking"
    assert response.tool_calls[0].arguments == json.dumps(
        {"query": "x"}, separators=(",", ":")
    )
    assert response.usage == {
        "prompt_tokens": 10,
        "completion_tokens": 4,
        "total_tokens": 14,
        "cached_tokens": 3,
    }
    assert response.finish_reason == "tool_use"


def test_coding_cli_commands_configure_bedrock() -> None:
    claude = claude_command("claude", {"model": "claude-opus", "provider": "bedrock"})
    assert claude[-2:] == ["--model", "claude-opus"]

    codex = codex_command(
        "codex",
        Path("/tmp/output"),
        Path("/tmp/workspace"),
        {
            "model": "openai.example",
            "provider": "bedrock",
            "aws_region": "us-east-2",
            "aws_profile": "example",
        },
    )
    assert 'model_provider="amazon-bedrock"' in codex
    assert 'model_providers.amazon-bedrock.aws.region="us-east-2"' in codex
    assert 'model_providers.amazon-bedrock.aws.profile="example"' in codex
    assert aws_environment(
        {"aws_region": "us-west-2", "aws_profile": "example"}
    ) == {"AWS_REGION": "us-west-2", "AWS_PROFILE": "example"}


def test_bedrock_harness_profiles_require_explicit_regions() -> None:
    for harness, provider in (
        ("claude", "bedrock"),
        ("codex", "bedrock"),
        ("pi", "amazon-bedrock"),
    ):
        with pytest.raises(ValueError, match="aws_region"):
            _validate_provider_options(harness, {"provider": provider})
        _validate_provider_options(
            harness, {"provider": provider, "aws_region": "us-west-2"}
        )


def test_bedrock_sends_tool_images_as_image_blocks() -> None:
    from nanoagent.inference.backends.bedrock import _message

    message = {
        "role": "tool",
        "tool_call_id": "call-1",
        "content": "{}",
        "images": [{"media_type": "image/png", "data": "iVBORw=="}],
    }
    [result] = _message(message)["content"]
    assert result["toolResult"]["content"] == [
        {"text": "{}"},
        {"image": {"format": "png", "source": {"bytes": b"\x89PNG"}}},
    ]
    with pytest.raises(ValueError, match="cannot show"):
        _message({**message, "images": [{"media_type": "application/pdf", "data": ""}]})
