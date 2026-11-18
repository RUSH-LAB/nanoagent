"""NanoAgent's chat client pointed at the attempt's gateway, as the agent's chat model and the decider's decision model."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx

from nanoagent.core.agent import Reply, ToolCall
from nanoagent.inference.backends.sglang import ChatBackend
from nanoagent.inference.types import Answer
from taskharness import screen
from taskharness.events import CALL_HEADER, CURRENT_SPAN, SPAN_HEADER


class GatewayModel:
    """A `ChatModel` and a `DecisionModel` over the gateway.

    It remembers which gateway call (``X-Rush-Call-Id``) produced each model tool call, which the broker asks for as the
    cause of the tool call. The structured answer a decider asks for carries ``provider.require_parameters: true`` (the
    chat client's behaviour with ``require_parameters=True``, the value its OpenRouter provider sets).
    """

    def __init__(self, backend: ChatBackend) -> None:
        self._backend = backend
        self._last_call: str | None = None
        self._call_of_tool_call: dict[str, str] = {}
        # httpx's own hooks on the chat client's HTTP client: the span header out, the call id back.
        http: httpx.AsyncClient = backend._client._client
        hooks = http.event_hooks
        http.event_hooks = {
            "request": [self._tag_span, *hooks["request"]],
            "response": [self._note_call, *hooks["response"]],
        }

    @classmethod
    def connect(cls, *, base_url: str, token: str, model: str, max_tokens: int, max_retries: int = 2) -> GatewayModel:
        return cls(
            ChatBackend(
                model,
                base_url=base_url,
                api_key=token,
                temperature=None,
                max_tokens=max_tokens,
                max_retries=max_retries,
                require_parameters=True,
            )
        )

    async def _tag_span(self, request: httpx.Request) -> None:
        if (span := CURRENT_SPAN.get()) is not None:
            request.headers[SPAN_HEADER] = span

    async def _note_call(self, response: httpx.Response) -> None:
        self._last_call = response.headers.get(CALL_HEADER, self._last_call)

    def call_of(self, tool_call_id: str) -> str:
        return self._call_of_tool_call[tool_call_id]

    async def query(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]], *, on_delta: Callable[[str, str], None] | None = None) -> Reply:
        response = await self._backend.generate(messages, tools=tools, on_delta=on_delta)
        for call in response.tool_calls:
            if self._last_call is not None:
                self._call_of_tool_call[call.id] = self._last_call
        screen.said(response.text or "")  # shown as it comes, before the tools it calls run
        return Reply(
            content=response.text,
            tool_calls=[ToolCall(id=call.id, name=call.name, arguments=call.arguments) for call in response.tool_calls],
            usage=response.usage,
            cost=response.cost,
            reasoning=response.reasoning,
        )

    async def answer(self, messages: list[dict[str, Any]], *, name: str, schema: dict[str, Any]) -> Answer:
        return await self._backend.answer(messages, name=name, schema=schema)

    async def aclose(self) -> None:
        await self._backend.aclose()
