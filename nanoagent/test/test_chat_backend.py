from __future__ import annotations

from types import SimpleNamespace

import pytest

from nanoagent.inference.backends.sglang import ChatBackend
from nanoagent.inference.config import LeanInferConfig

SCHEMA = {"type": "object", "properties": {"next": {"type": "string", "enum": ["a", "b"]}}, "required": ["next"]}


class FakeCompletions:
    def __init__(self, content: str, finish_reason: str = "stop") -> None:
        self.content = content
        self.finish_reason = finish_reason
        self.request: dict | None = None

    async def create(self, **request):
        self.request = request
        message = SimpleNamespace(content=self.content, tool_calls=None)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message, finish_reason=self.finish_reason)],
            usage=SimpleNamespace(prompt_tokens=7, completion_tokens=3, total_tokens=10),
        )


def _backend(provider: str, completions: FakeCompletions, **config) -> ChatBackend:
    backend = ChatBackend.from_config(
        LeanInferConfig(provider=provider, model="m", base_url="http://localhost/v1", input_price=1.0, **config)
    )
    backend._client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    return backend


async def test_an_answer_is_held_to_its_schema_by_a_provider_that_honours_it() -> None:
    completions = FakeCompletions('{"next": "b"}')
    backend = _backend("openrouter", completions, api_key="k", extra_body={"provider": {"order": ["x"]}})

    answer = await backend.answer([{"role": "user", "content": "pick"}], name="decide", schema=SCHEMA)

    assert completions.request["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "decide", "schema": SCHEMA, "strict": True},
    }
    assert completions.request["extra_body"] == {"provider": {"order": ["x"], "require_parameters": True}}
    assert answer.value == {"next": "b"}
    assert answer.usage["total_tokens"] == 10 and answer.cost == 7 / 1_000_000


async def test_an_sglang_answer_sends_no_provider_routing() -> None:
    completions = FakeCompletions('{"next": "a"}')
    await _backend("sglang", completions).answer([{"role": "user", "content": "pick"}], name="decide", schema=SCHEMA)
    assert "extra_body" not in completions.request


@pytest.mark.parametrize(
    ("content", "finish_reason", "message"),
    [
        ("not json", "stop", "is not JSON"),
        ('["a"]', "stop", "is not a JSON object"),
        ('{"next": ', "length", "cut off at the token limit"),
    ],
)
async def test_an_answer_that_is_not_one_object_raises(content: str, finish_reason: str, message: str) -> None:
    backend = _backend("sglang", FakeCompletions(content, finish_reason))
    with pytest.raises(ValueError, match=message):
        await backend.answer([{"role": "user", "content": "pick"}], name="decide", schema=SCHEMA)
