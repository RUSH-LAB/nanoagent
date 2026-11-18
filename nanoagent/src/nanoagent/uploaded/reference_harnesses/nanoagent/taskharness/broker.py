"""The tool broker as the harness's tools: agent tools for an agent task, plain calls for a decide task."""

from __future__ import annotations

import contextvars
import json
from dataclasses import dataclass
from typing import Any

import httpx

from nanoagent.core.tool import Tool, ToolText
from taskharness import screen
from taskharness.events import CURRENT_SPAN, SPAN_HEADER

# The model tool call being dispatched: Agent.run's on_tool hook sets it in the call's own task, the tool reads it.
CURRENT_TOOL_CALL: contextvars.ContextVar[str | None] = contextvars.ContextVar("current_tool_call", default=None)


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]


class Broker:
    """Calls tools at ``url``; ``call_of`` names the gateway model call that proposed a model tool call."""

    def __init__(self, url: str, token: str, client: httpx.AsyncClient, call_of: Any) -> None:
        self._url = url
        self._headers = {"Authorization": f"Bearer {token}"}
        self._client = client
        self._call_of = call_of

    async def call(self, name: str, arguments: dict[str, Any], *, tool_call_id: str | None = None) -> dict[str, Any]:
        """One broker call. With ``tool_call_id`` (an agent's) it carries its cause; without (a decider's) it is harness-initiated."""
        body: dict[str, Any] = {"name": name, "arguments": arguments}
        if tool_call_id is not None:
            body["cause"] = {"model_call_id": self._call_of(tool_call_id), "tool_call_id": tool_call_id}
        headers = dict(self._headers)
        if (span := CURRENT_SPAN.get()) is not None:
            headers[SPAN_HEADER] = span
        screen.calling(name, arguments)
        response = await self._client.post(self._url, json=body, headers=headers)
        try:
            payload = response.json()
        except json.JSONDecodeError:
            payload = {}
        if response.status_code != 200 or "output" not in payload:
            error = payload.get("error", {})
            message = f"tool {name} failed: {error.get('code', response.status_code)}: {error.get('message', response.text)}"
            screen.failed(message)
            raise RuntimeError(message)
        screen.answered(payload["output"])
        return payload["output"]


class BrokerTool(Tool):
    """A broker tool for the agent; its result is the output as JSON, any `images` going to the model as images."""

    def __init__(self, spec: ToolSpec, broker: Broker) -> None:
        self.NAME = spec.name
        self.PARAMETERS = spec.input_schema
        self._description = spec.description
        self._broker = broker

    @property
    def description(self) -> str:
        return self._description

    async def run(self, **arguments: Any) -> str:
        output = await self._broker.call(self.NAME, arguments, tool_call_id=CURRENT_TOOL_CALL.get())
        images = output.pop("images", [])
        return ToolText(json.dumps(output), images=images)
