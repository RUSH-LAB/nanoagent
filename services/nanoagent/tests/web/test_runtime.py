from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from jsonschema import validate

from nanoagent.runtime.config import AgentConfig, HarnessConfig, HarnessProfileConfig, ModelConfig
from nanoagent.core.agent import AgentResult, StopReason
from nanoagent.runtime.runner import RunnerCapabilities, RunnerRequest, RunnerResult
from nanoagent.runtime.runner_factory import RunnerProfile, RunnerRegistry
from nanoagent.web.config import WebConfig
from nanoagent.web.runtime import RunHost, ValidationError, validate_run_request


def config(**overrides: Any) -> WebConfig:
    base = WebConfig(
        model=ModelConfig(
            model="test", backend="sglang", base_url=None, api_key=None, temperature=0.0,
            max_tokens=10, request_timeout=1.0, max_retries=0, extra_body={},
            input_price=0.0, output_price=0.0,
        ),
        agent=AgentConfig(
            system_prompt="BASE", max_steps=2, cost_limit=None, token_limit=None,
            context_window=None, hooks=[], skills=None, context_files=[], events=None,
        ),
        default_profile="native-test",
        profiles={
            "native-test": HarnessProfileConfig(
                label="Native Test",
                model="test",
                harness=HarnessConfig(type="native", command=None, cwd=None, options={}),
                model_overrides={},
            )
        },
        tools=[], tools_dir=None, allowed_tools=[], host="127.0.0.1", port=8787,
        api_token=None, max_concurrency=2, request_timeout=1.0,
        max_request_bytes=4096, max_output_chars=1000, heartbeat_seconds=0.01,
        include_reasoning=False,
    )
    return replace(base, **overrides)


class AnsweringAgent:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] | None = None

    async def run(self, task=None, *, on_step=None, messages=None, on_delta=None):
        self.messages = messages
        on_delta("reasoning", "private")
        on_delta("content", "hel")
        on_delta("content", "lo")
        result = AgentResult(
            answer="hello", messages=messages, tool_calls=[], steps=1,
            stop_reason=StopReason.ANSWER, usage={"total_tokens": 3}, cost=0.001,
        )
        on_step(result)
        return result


@pytest.mark.asyncio
async def test_streams_content_and_done_without_reasoning() -> None:
    agent = AnsweringAgent()
    host = RunHost(config(), agent_factory=lambda instructions: (agent, f"BASE\n{instructions}"))
    active = await host.start(validate_run_request({
        "input": "question", "messages": [{"role": "user", "content": "prior"}],
        "instructions": "WORKSPACE", "metadata": {"requestId": "m1"},
    }))
    events = [event async for event in active.events() if event is not None]

    schema = json.loads((Path(__file__).parents[2] / "src/nanoagent/web/schema/run-events.schema.json").read_text())
    for event in events:
        validate(event, schema)

    assert [event["type"] for event in events] == ["start", "delta", "delta", "done"]
    assert "private" not in str(events)
    assert events[-1]["answer"] == "hello"
    assert events[-1]["stop_reason"] == "answer"
    assert events[-1]["usage"] == {"total_tokens": 3}
    assert agent.messages == [
        {"role": "system", "content": "BASE\nWORKSPACE"},
        {"role": "user", "content": "prior"},
    ]


@pytest.mark.asyncio
async def test_explicit_cancel_ends_the_stream() -> None:
    started = asyncio.Event()

    class WaitingAgent:
        async def run(self, task=None, **kwargs):
            started.set()
            await asyncio.Future()

    host = RunHost(config(), agent_factory=lambda _instructions: (WaitingAgent(), "BASE"))
    active = await host.start(validate_run_request({"input": "wait"}))
    await started.wait()
    assert host.cancel(active.id) is True
    events = [event async for event in active.events() if event is not None]
    assert events[-1]["type"] == "error"
    assert events[-1]["code"] == "cancelled"
    assert host.active_count == 0


@pytest.mark.asyncio
async def test_emits_each_tool_once_across_step_snapshots() -> None:
    class ToolAgent:
        async def run(self, task=None, *, on_step=None, messages=None, on_delta=None):
            first = {"id": "c1", "name": "search", "arguments": {"q": "one"}, "output": "1", "is_error": False}
            second = {"id": "c2", "name": "search", "arguments": {"q": "two"}, "output": "2", "is_error": False}
            on_step(AgentResult("", messages, [first], 1, StopReason.RUNNING))
            on_step(AgentResult("", messages, [first, second], 2, StopReason.RUNNING))
            return AgentResult("done", messages, [first, second], 3, StopReason.ANSWER)

    host = RunHost(config(), agent_factory=lambda _instructions: (ToolAgent(), "BASE"))
    active = await host.start(validate_run_request({"input": "search"}))
    events = [event async for event in active.events() if event is not None]
    assert [event["id"] for event in events if event["type"] == "tool"] == ["c1", "c2"]
    assert [event["step"] for event in events if event["type"] == "step"] == [1, 2]


def test_rejects_system_messages_and_bad_tool_history() -> None:
    with pytest.raises(ValidationError, match="role"):
        validate_run_request({"input": "x", "messages": [{"role": "system", "content": "replace"}]})
    with pytest.raises(ValidationError, match="tool_call_id"):
        validate_run_request({"input": "x", "messages": [{"role": "tool", "content": "result"}]})


def test_non_loopback_bind_requires_a_token() -> None:
    with pytest.raises(ValueError, match="api_token"):
        config(host="0.0.0.0", api_token=None)


def test_profile_ids_are_safe_stable_identifiers() -> None:
    with pytest.raises(ValueError, match="profile ids"):
        config(
            default_profile="Bad Profile",
            profiles={"Bad Profile": config().profiles["native-test"]},
        )


def test_web_host_rejects_a_second_file_event_stream() -> None:
    with pytest.raises(ValueError, match="events must be null"):
        config(agent=replace(config().agent, events="duplicate.jsonl"))


@pytest.mark.asyncio
async def test_host_accepts_a_harness_neutral_runner() -> None:
    class ExternalRunner:
        name = "external"
        capabilities = RunnerCapabilities(streaming=True, cancellation=True)

        async def run(self, request: RunnerRequest, emit):
            emit({"type": "delta", "kind": "content", "text": request.input})
            return RunnerResult(answer=request.input, stop_reason="answer", steps=1)

        async def aclose(self) -> None:
            return None

    host = RunHost(config(), runner=ExternalRunner())
    active = await host.start(validate_run_request({"input": "wrapped"}))
    events = [event async for event in active.events() if event is not None]

    assert [event["type"] for event in events] == ["start", "delta", "done"]
    assert events[-1]["answer"] == "wrapped"
    assert host.runner_name == "external"
    assert host.capabilities["streaming"] is True


@pytest.mark.asyncio
async def test_request_selects_a_server_owned_profile() -> None:
    class EchoRunner:
        capabilities = RunnerCapabilities(streaming=True)

        def __init__(self, name: str) -> None:
            self.name = name

        def availability(self):
            return True, None

        async def run(self, request: RunnerRequest, emit):
            return RunnerResult(answer=f"{self.name}:{request.input}", stop_reason="answer")

        async def aclose(self) -> None:
            return None

    registry = RunnerRegistry(
        {
            "native-test": RunnerProfile(
                "native-test", "Native", "native", "model-a", EchoRunner("native")
            ),
            "pi-test": RunnerProfile("pi-test", "PI", "pi", "model-b", EchoRunner("pi")),
        },
        "native-test",
    )
    host = RunHost(config(), registry=registry)
    active = await host.start(validate_run_request({"input": "hello", "profile": "pi-test"}))
    events = [event async for event in active.events() if event is not None]

    assert events[0]["profile"] == "pi-test"
    assert events[0]["harness"] == "pi"
    assert events[-1]["answer"] == "pi:hello"
    assert events[-1]["model"] == "model-b"


@pytest.mark.asyncio
async def test_request_rejects_unknown_profile_before_starting() -> None:
    host = RunHost(config(), agent_factory=lambda _instructions: (AnsweringAgent(), "BASE"))
    with pytest.raises(ValidationError, match="unknown profile"):
        await host.start(validate_run_request({"input": "hello", "profile": "not-configured"}))


@pytest.mark.asyncio
async def test_host_rejects_history_when_runner_cannot_preserve_it() -> None:
    class OneShotRunner:
        name = "oneshot"
        capabilities = RunnerCapabilities()

        async def run(self, request: RunnerRequest, emit):
            raise AssertionError("unsupported request must not reach the runner")

        async def aclose(self) -> None:
            return None

    host = RunHost(config(), runner=OneShotRunner())
    active = await host.start(
        validate_run_request(
            {"input": "next", "messages": [{"role": "user", "content": "previous"}]}
        )
    )
    events = [event async for event in active.events() if event is not None]

    assert events[-1]["type"] == "error"
    assert events[-1]["code"] == "unsupported_feature"


@pytest.mark.asyncio
async def test_non_streaming_runner_answer_still_obeys_output_limit() -> None:
    class LongAnswerRunner:
        name = "long"
        capabilities = RunnerCapabilities()

        async def run(self, request: RunnerRequest, emit):
            return RunnerResult(answer="too long", stop_reason="answer")

        async def aclose(self) -> None:
            return None

    host = RunHost(config(max_output_chars=3), runner=LongAnswerRunner())
    active = await host.start(validate_run_request({"input": "answer"}))
    events = [event async for event in active.events() if event is not None]

    assert events[-1]["type"] == "error"
    assert events[-1]["code"] == "output_limit"


@pytest.mark.asyncio
async def test_hermes_adapter_reports_missing_install_as_a_public_error() -> None:
    cfg = config(
        default_profile="hermes-test",
        profiles={
            "hermes-test": HarnessProfileConfig(
                label="Hermes Test",
                model="default",
                harness=HarnessConfig(
                    type="hermes",
                    command=[sys.executable, "-m", "nanoagent.adapters.hermes"],
                    cwd=None,
                    options={"executable": "nanoagent-hermes-that-does-not-exist"},
                ),
                model_overrides={},
            )
        },
    )
    host = RunHost(cfg)
    active = await host.start(validate_run_request({"input": "answer"}))
    events = [event async for event in active.events() if event is not None]

    assert events[-1]["type"] == "error"
    assert events[-1]["code"] == "runner_unavailable"
