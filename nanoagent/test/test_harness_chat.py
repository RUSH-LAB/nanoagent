from __future__ import annotations

import io
from pathlib import Path

import pytest
from rich.console import Console

from nanoagent.cli.repl.app import _interactive_profile
from nanoagent.cli.repl.harness import HarnessConversation
from nanoagent.harness import HarnessCapabilities, HarnessProfile, HarnessResult
from nanoagent.harness.nanoagent import NanoAgentRunner
from nanoagent.runtime.config import load_config_args, InteractiveConfig


class EchoHarness:
    name = "echo"
    capabilities = HarnessCapabilities(history=True)

    def __init__(self) -> None:
        self.requests = []

    async def run(self, request, emit):
        self.requests.append(request)
        emit(
            {
                "type": "tool",
                "id": f"call-{len(self.requests)}",
                "name": "echo_tool",
                "arguments": {"value": len(self.requests)},
                "output": f"observed {len(self.requests)}",
            }
        )
        emit({"type": "delta", "kind": "content", "text": f"reply {len(self.requests)}"})
        return HarnessResult(
            answer=f"reply {len(self.requests)}",
            stop_reason="answer",
            steps=1,
            usage={"prompt_tokens": len(self.requests), "completion_tokens": 1},
        )

    async def aclose(self) -> None:
        pass

    def availability(self):
        return True, None


@pytest.mark.asyncio
async def test_external_harness_chat_preserves_history(tmp_path: Path) -> None:
    harness = EchoHarness()
    profile = HarnessProfile("echo", "Echo", "echo", "model", harness)
    conversation = HarnessConversation.start(
        profile,
        instructions="help",
        workspace=tmp_path,
        console=Console(file=io.StringIO(), force_terminal=False),
    )

    await conversation.run_task("first")
    await conversation.run_task("second")

    assert harness.requests[0].messages == []
    assert harness.requests[1].messages == [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "reply 1"},
    ]
    result = conversation.to_result()
    assert result.answer == "reply 2"
    assert result.steps == 2
    assert result.usage == {"prompt_tokens": 3, "completion_tokens": 2}
    trajectory = conversation.trajectory()
    assert trajectory.schema_version == "ATIF-v1.8"
    tool_step = next(step for step in trajectory.steps if step["tool_calls"])
    assert tool_step["tool_calls"][0]["function_name"] == "echo_tool"
    assert tool_step["observation"]["results"][0]["content"] == "observed 1"


def test_interactive_default_is_a_registry_native_profile() -> None:
    config = load_config_args(
        InteractiveConfig,
        ["mgen_cfg=src/nanoagent/configs/mgen.yaml"],
    )
    registry, profile = _interactive_profile(config)
    try:
        assert profile.id == "nanoagent"
        assert isinstance(profile.runner, NanoAgentRunner)
    finally:
        import asyncio

        asyncio.run(registry.aclose())
