"""The mock against real client libraries: a failing acceptance test must point at the pipeline, not the mock."""

from __future__ import annotations

import json
import textwrap
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import anthropic
import openai
import pytest
from mockllm import MockProvider, NormalizedUsage, Scenario, Turn, Usage, load_scenario
from mockllm.engine import Stream

MODEL = "test/model"
KEY = "sentinel-key"
TOOLS = [
    {"type": "function", "function": {"name": "wait", "parameters": {"type": "object", "properties": {"wait_seconds": {"type": "number"}}}}},
    {"type": "function", "function": {"name": "submit", "parameters": {"type": "object", "properties": {"digest": {"type": "string"}}}}},
]
ANTHROPIC_TOOLS = [{"name": "wait", "input_schema": {"type": "object"}}, {"name": "submit", "input_schema": {"type": "object"}}]
RESPONSES_TOOLS = [
    {"type": "function", "name": "wait", "parameters": {"type": "object"}},
    {"type": "function", "name": "submit", "parameters": {"type": "object"}},
]

FULL = Turn(
    ttfb=0.2,
    stream=Stream(chunks=5, gap=0.05),
    reasoning="Need to wait, then answer.",
    text="Working on it.",
    act={"wait": 1.5},
    usage=Usage(prompt=1000, cached=600, completion=50, reasoning=20, cache_write=100),
)
ANSWER = Turn(
    ttfb=0.1,
    stream=Stream(chunks=2, gap=0.02),
    act={"answer": {"digest": "@digest"}},
    usage=Usage(prompt=1200, cached=1000, completion=30, reasoning=10),
)


def scenario(*turns: Turn, side: Usage = Usage()) -> Scenario:
    return Scenario(name="t", turns=list(turns), side_usage=side)


@pytest.fixture(scope="module")
def mock() -> Iterator[MockProvider]:
    with MockProvider() as provider:
        yield provider


def chat_client(handle) -> openai.OpenAI:
    return openai.OpenAI(base_url=handle.base_url, api_key=KEY, max_retries=0)


def chat_stream(client: openai.OpenAI, **extra):
    return client.chat.completions.stream(
        model=MODEL, messages=[{"role": "user", "content": "hi"}], tools=TOOLS, stream_options={"include_usage": True}, **extra
    )


def test_chat_stream_matches_scenario_and_ledger(mock: MockProvider) -> None:
    handle = mock.register(scenario(FULL, ANSWER), harness="nanoagent", model=MODEL, refs={"digest": "abc"})
    client = chat_client(handle)
    start = time.perf_counter()
    with chat_stream(client) as stream:
        first = stream.get_final_completion()
    elapsed = time.perf_counter() - start
    message = first.choices[0].message
    assert message.content == "Working on it."
    assert first.choices[0].finish_reason == "tool_calls"
    [call] = message.tool_calls
    assert call.function.name == "wait"
    assert json.loads(call.function.arguments) == {"wait_seconds": 1.5}
    assert first.usage.prompt_tokens == 1000
    assert first.usage.prompt_tokens_details.cached_tokens == 600
    assert first.usage.completion_tokens_details.reasoning_tokens == 20
    # ttfb 0.2 + 5 chunks * 0.05
    assert 0.45 <= elapsed < 0.9
    with chat_stream(client) as stream:
        second = stream.get_final_completion()
    [call] = second.choices[0].message.tool_calls
    assert call.function.name == "submit" and json.loads(call.function.arguments) == {"digest": "abc"}

    ledger = handle.ledger
    ledger.assert_clean()
    one, two = ledger.main_calls
    assert one.request.model == MODEL
    assert [t.name for t in one.request.tools] == ["wait", "submit"]
    assert one.request.stream_options == {"include_usage": True}
    assert one.request.auth == KEY and one.request.auth_header == "authorization"
    assert one.usage == NormalizedUsage(input=1000, cached=600, cache_write=100, output=50, reasoning=20)
    assert 0.2 <= one.first_byte - one.arrival < 0.35
    assert 0.45 <= one.span < 0.7
    assert ledger.usage() == NormalizedUsage(2200, 1600, 100, 80, 30)
    assert two.span == ledger.server_spans()[1]


def test_chat_reasoning_deltas_stream_before_content(mock: MockProvider) -> None:
    handle = mock.register(scenario(FULL), harness="nanoagent", model=MODEL)
    kinds: list[str] = []
    with chat_stream(chat_client(handle)) as stream:
        for event in stream:
            if event.type == "chunk" and event.chunk.choices:
                delta = event.chunk.choices[0].delta
                kinds += [name for name in ("reasoning", "content", "tool_calls") if getattr(delta, name, None)]
    assert kinds.index("reasoning") < kinds.index("content") < kinds.index("tool_calls")
    assert kinds.count("tool_calls") > 2  # id and name first, then argument fragments


def test_chat_non_streaming_side_call(mock: MockProvider) -> None:
    handle = mock.register(scenario(FULL, side=Usage(prompt=7, completion=3)), harness="nanoagent", model=MODEL)
    reply = chat_client(handle).chat.completions.create(model="other/small", messages=[{"role": "user", "content": "title?"}])
    assert reply.choices[0].message.content == "ok" and reply.usage.prompt_tokens == 7
    reply = chat_client(handle).chat.completions.create(model=MODEL, messages=[{"role": "user", "content": "no tools"}])
    assert reply.usage.completion_tokens == 3
    [one, two] = handle.ledger.side_calls
    assert one.request.model == "other/small" and two.request.model == MODEL
    assert handle.ledger.main_calls == []
    assert handle.ledger.usage("side") == NormalizedUsage(14, 0, 0, 6, 0)
    # the scenario's turn was not consumed
    chat_stream(chat_client(handle)).__enter__().get_final_completion()
    assert len(handle.ledger.main_calls) == 1


def anthropic_client(handle) -> anthropic.Anthropic:
    return anthropic.Anthropic(base_url=handle.anthropic_base_url, api_key=KEY, max_retries=0)


def test_anthropic_stream_matches_scenario(mock: MockProvider) -> None:
    handle = mock.register(scenario(FULL), harness="nanoagent", model=MODEL)
    start = time.perf_counter()
    with anthropic_client(handle).messages.stream(
        model=MODEL, max_tokens=100, messages=[{"role": "user", "content": "hi"}], tools=ANTHROPIC_TOOLS
    ) as stream:
        message = stream.get_final_message()
    assert 0.45 <= time.perf_counter() - start < 0.9
    thinking, text, tool = message.content
    assert thinking.thinking == "Need to wait, then answer." and thinking.signature
    assert text.text == "Working on it."
    assert tool.name == "wait" and tool.input == {"wait_seconds": 1.5}
    assert message.stop_reason == "tool_use"
    assert message.usage.input_tokens == 300  # excludes cache
    assert message.usage.cache_read_input_tokens == 600 and message.usage.cache_creation_input_tokens == 100
    assert message.usage.output_tokens == 50
    [call] = handle.ledger.main_calls
    assert call.request.auth_header == "authorization" and call.request.auth == KEY  # SDK 2.x sends a bearer
    assert call.request.path.endswith("/api/v1/messages")
    # input is the total including cache; Anthropic carries no reasoning count
    assert call.usage == NormalizedUsage(input=1000, cached=600, cache_write=100, output=50, reasoning=0)


def test_anthropic_query_string_and_non_streaming(mock: MockProvider) -> None:
    handle = mock.register(scenario(ANSWER), harness="nanoagent", model=MODEL, refs={"digest": "d"})
    body = json.dumps({"model": MODEL, "max_tokens": 10, "messages": [], "tools": ANTHROPIC_TOOLS}).encode()
    request = urllib.request.Request(
        handle.anthropic_base_url + "/v1/messages?beta=true", body, {"x-api-key": KEY, "content-type": "application/json"}
    )
    with urllib.request.urlopen(request) as response:
        message = json.load(response)
    assert message["content"] == [{"type": "tool_use", "id": "call_0", "name": "submit", "input": {"digest": "d"}}]
    assert handle.ledger.main_calls[0].request.stream is False
    assert (handle.ledger.main_calls[0].request.auth_header, handle.ledger.main_calls[0].request.auth) == ("x-api-key", KEY)


def test_responses_stream_matches_scenario(mock: MockProvider) -> None:
    handle = mock.register(scenario(FULL, ANSWER), harness="nanoagent", model=MODEL, refs={"digest": "z"})
    client = openai.OpenAI(base_url=handle.base_url, api_key=KEY, max_retries=0)
    start = time.perf_counter()
    with client.responses.stream(model=MODEL, input="hi", tools=RESPONSES_TOOLS) as stream:
        deltas = [e.type for e in stream if e.type.endswith(".delta")]
        final = stream.get_final_response()
    assert 0.45 <= time.perf_counter() - start < 0.9
    assert deltas[0] == "response.reasoning_summary_text.delta"
    assert "response.output_text.delta" in deltas and "response.function_call_arguments.delta" in deltas
    reasoning, message, call = final.output
    assert reasoning.summary[0].text == "Need to wait, then answer."
    assert message.content[0].text == "Working on it."
    assert call.name == "wait" and json.loads(call.arguments) == {"wait_seconds": 1.5} and call.call_id == "call_0"
    assert final.usage.input_tokens == 1000 and final.usage.input_tokens_details.cached_tokens == 600
    assert final.usage.output_tokens == 50 and final.usage.output_tokens_details.reasoning_tokens == 20
    plain = client.responses.create(model=MODEL, input="again", tools=RESPONSES_TOOLS, stream=True)
    assert json.loads([e for e in plain if e.type == "response.completed"][0].response.output[0].arguments) == {"digest": "z"}
    first, second = handle.ledger.main_calls
    assert first.usage == NormalizedUsage(1000, 600, 0, 50, 20)  # no cache-write field in this dialect
    assert [t.name for t in first.request.tools] == ["wait", "submit"]


@pytest.mark.parametrize(
    ("dialect", "payload", "last_frame"),
    [
        ("chat/completions", {"model": MODEL, "stream": True, "messages": [{"role": "user", "content": "hi"}]}, "data: [DONE]"),
        # OpenRouter ends a Responses stream with [DONE] after response.completed; a mock that did not hid a parsing bug once.
        ("responses", {"model": MODEL, "stream": True, "input": "hi"}, "data: [DONE]"),
        # The Messages stream ends with message_stop and carries no [DONE].
        ("messages", {"model": MODEL, "stream": True, "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]}, None),
    ],
)
def test_streams_end_as_openrouters_do(mock: MockProvider, dialect: str, payload: dict, last_frame: str | None) -> None:
    handle = mock.register(scenario(ANSWER), harness="nanoagent", model=MODEL, refs={"digest": "z"})
    request = urllib.request.Request(f"{handle.base_url}/{dialect}", json.dumps(payload).encode(), {"content-type": "application/json", "authorization": f"Bearer {KEY}", "x-api-key": KEY})
    with urllib.request.urlopen(request) as response:
        frames = [frame for frame in response.read().decode().split("\n\n") if frame.strip()]
    if last_frame is None:
        assert frames[-1].startswith("event: message_stop") and not any("[DONE]" in frame for frame in frames)
    else:
        assert frames[-1] == last_frame and frames[-2].startswith(("data: {", "event: response.completed"))


def post(url: str, payload: dict | None = None, method: str = "POST") -> tuple[int, str]:
    request = urllib.request.Request(url, json.dumps(payload or {}).encode(), {"content-type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def test_unknown_path_token_and_method_are_599_violations(mock: MockProvider) -> None:
    handle = mock.register(scenario(FULL), harness="nanoagent", model=MODEL)
    before = len(mock.violations)
    assert post(f"{mock.root}/r/nope/api/v1/chat/completions")[0] == 599
    assert post(f"{mock.root}/api/v1/chat/completions")[0] == 599
    assert post(f"{handle.base_url}/embeddings")[0] == 599
    assert post(f"{handle.anthropic_base_url}/v1/messages/count_tokens")[0] == 599
    assert post(f"{handle.base_url}/models", method="GET")[0] == 599
    assert len(mock.violations) == before + 2
    assert len(handle.ledger.violations) == 3  # embeddings, count_tokens and the GET
    with pytest.raises(AssertionError, match="protocol violations"):
        handle.ledger.assert_clean()


def test_exhausted_script_is_599_and_a_violation(mock: MockProvider) -> None:
    handle = mock.register(scenario(ANSWER), harness="nanoagent", model=MODEL)
    client = chat_client(handle)
    chat_stream(client).__enter__().get_final_completion()
    with pytest.raises(openai.APIStatusError) as error:
        chat_stream(client).__enter__()
    assert error.value.status_code == 599
    assert "no turns left" in handle.ledger.violations[0]
    assert handle.ledger.calls[-1].kind == "violation"


def test_missing_tool_fails_loudly(mock: MockProvider) -> None:
    handle = mock.register(scenario(FULL), harness="nanoagent", model=MODEL)
    with pytest.raises(openai.APIStatusError) as error:
        chat_client(handle).chat.completions.create(model=MODEL, messages=[], tools=TOOLS[1:])
    assert error.value.status_code == 599
    assert "'wait'" in handle.ledger.violations[0]


def test_prefixed_tool_names_are_found(mock: MockProvider) -> None:
    handle = mock.register(scenario(FULL), harness="nanoagent", model=MODEL)
    prefixed = [{"type": "function", "function": {"name": "mcp__probe__wait", "parameters": {}}}]
    reply = chat_client(handle).chat.completions.create(model=MODEL, messages=[], tools=prefixed)
    assert reply.choices[0].message.tool_calls[0].function.name == "mcp__probe__wait"


def test_injected_429_is_consumed_then_the_retry_succeeds(mock: MockProvider) -> None:
    handle = mock.register(scenario(Turn(status=429), ANSWER), harness="nanoagent", model=MODEL, refs={"digest": "x"})
    client = openai.OpenAI(base_url=handle.base_url, api_key=KEY, max_retries=2)  # the SDK retries a 429 itself
    with chat_stream(client) as stream:
        completion = stream.get_final_completion()
    assert completion.choices[0].message.tool_calls[0].function.name == "submit"
    error, main = handle.ledger.calls
    assert (error.kind, error.status, error.usage) == ("error", 429, None)
    assert (main.kind, main.status) == ("main", 200)
    assert [call.kind for call in handle.ledger.main_calls] == ["main"]


def test_error_bodies_follow_each_dialect(mock: MockProvider) -> None:
    handle = mock.register(scenario(Turn(status=500, repeat=0)), harness="nanoagent", model=MODEL)
    status, text = post(f"{handle.base_url}/chat/completions", {"model": MODEL, "tools": TOOLS})
    assert status == 500 and json.loads(text)["error"]["code"] == 500
    status, text = post(f"{handle.base_url}/messages", {"model": MODEL, "tools": ANTHROPIC_TOOLS})
    assert status == 500 and json.loads(text)["type"] == "error"
    status, text = post(f"{handle.base_url}/responses", {"model": MODEL, "tools": RESPONSES_TOOLS})
    assert status == 500 and "message" in json.loads(text)["error"]
    assert [c.kind for c in handle.ledger.calls] == ["error"] * 3  # repeat=0 serves every request


def test_runs_stay_isolated_under_concurrency(mock: MockProvider) -> None:
    first = mock.register(scenario(FULL), harness="nanoagent", model=MODEL)
    second = mock.register(scenario(ANSWER), harness="nanoagent", model=MODEL, refs={"digest": "q"})
    results: dict[str, str] = {}

    def work(name: str, handle) -> None:
        with chat_stream(chat_client(handle)) as stream:
            results[name] = stream.get_final_completion().choices[0].message.tool_calls[0].function.name

    threads = [threading.Thread(target=work, args=pair) for pair in (("a", first), ("b", second))]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert results == {"a": "wait", "b": "submit"}
    assert len(first.ledger.calls) == len(second.ledger.calls) == 1
    assert first.ledger.main_calls[0].usage.input == 1000 and second.ledger.main_calls[0].usage.input == 1200


def test_scenario_yaml_loads_with_defaults(tmp_path: Path) -> None:
    path = tmp_path / "s.yaml"
    path.write_text(
        textwrap.dedent(
            """\
            _ > mockllm.engine.Scenario:
            name: two-step-answer
            case: acceptance-probe-01
            turns:
              - ttfb: 0.60
                stream: {chunks: 10, gap: 0.05}
                reasoning: "Need to wait."
                text: "Working."
                act: {wait: 1.0}
                usage: {prompt: 1000, completion: 50, reasoning: 20}
              - act: {answer: {digest: "@reference"}}
                usage: {prompt: 1200, cached: 1000}
              - status: 429
            side_usage: {prompt: 5, completion: 1}
            expect: {correct: true, verdict_contains: ""}
            na: {codex: "cannot emit parallel calls"}
            """
        )
    )
    loaded = load_scenario(path)
    assert loaded.turns[0].stream == Stream(chunks=10, gap=0.05)
    assert loaded.turns[0].act == {"wait": 1.0} and loaded.turns[0].usage.reasoning == 20
    assert loaded.turns[1].stream == Stream() and loaded.turns[1].usage.cached == 1000
    assert loaded.turns[2].status == 429 and loaded.turns[2].repeat == 1
    assert loaded.side_usage.prompt == 5 and loaded.expect.correct is True and loaded.na == {"codex": "cannot emit parallel calls"}
    path.write_text("_ > mockllm.engine.Scenario:\nname: x\nturns: [{typo: 1}]\n")
    with pytest.raises(Exception, match="typo"):
        load_scenario(path)
