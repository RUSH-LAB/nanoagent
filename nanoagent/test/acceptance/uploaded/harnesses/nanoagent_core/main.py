"""The NanoAgent core engine as an uploaded harness (rush.harness.v1).

Runs a pinned revision of nanoagent.core.agent.Agent.run() against the attempt's OpenRouter gateway: the exact rendered
prompt is the first user message, the case's hosted tools are agent tools that POST to the tool broker with the model
call and tool call that caused them, `submit` takes the task's output schema, and the answer is written atomically.
"""

import asyncio
import contextvars
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "site"), HERE]

import httpx  # noqa: E402
from nanoagent.core.agent import Agent, Reply, ToolCall  # noqa: E402
from nanoagent.core.tool import Tool  # noqa: E402

SYSTEM_PROMPT = "You are a benchmark harness. Use the tools you are given, then submit your answer with the submit tool."
# The model tool call being dispatched in this task: Agent.run's on_tool hook sets it, the hosted tool reads it.
CURRENT_TOOL_CALL: contextvars.ContextVar[str] = contextvars.ContextVar("current_tool_call")


class GatewayModel:
    """A streaming Chat Completions ChatModel over the gateway; remembers which gateway call produced each tool call."""

    def __init__(self, request: dict, token: str, client: httpx.AsyncClient) -> None:
        self.url = request["openrouter"]["base_url"] + "/chat/completions"
        self.model = request["openrouter"]["model"]
        self.headers = {"Authorization": "Bearer " + token}
        self.client = client
        self.call_of_tool_call: dict[str, str] = {}

    async def query(self, messages, tools, *, on_delta=None) -> Reply:
        body = {"model": self.model, "messages": messages, "tools": tools, "stream": True, "stream_options": {"include_usage": True}}
        content, calls, usage = "", {}, {}
        async with self.client.stream("POST", self.url, json=body, headers=self.headers) as response:
            if response.status_code != 200:
                raise RuntimeError(f"gateway answered {response.status_code}: {(await response.aread()).decode()}")
            call_id = response.headers["X-Rush-Call-Id"]
            async for line in response.aiter_lines():
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                chunk = json.loads(line[6:])
                usage = chunk.get("usage") or usage
                for choice in chunk["choices"]:
                    delta = choice["delta"]
                    content += delta.get("content") or ""
                    for fragment in delta.get("tool_calls") or []:
                        call = calls.setdefault(fragment["index"], {"id": "", "name": "", "arguments": ""})
                        call["id"] = fragment.get("id") or call["id"]
                        call["name"] += (fragment.get("function") or {}).get("name") or ""
                        call["arguments"] += (fragment.get("function") or {}).get("arguments") or ""
        tool_calls = [ToolCall(call["id"], call["name"], call["arguments"]) for _, call in sorted(calls.items())]
        for call in tool_calls:
            self.call_of_tool_call[call.id] = call_id
        counts = {key: usage.get(key, 0) for key in ("prompt_tokens", "completion_tokens", "total_tokens")}
        return Reply(content or None, tool_calls, counts)


class HostedTool(Tool):
    """A plugin tool the broker runs; every call names the gateway call and model tool call that proposed it."""

    def __init__(self, spec: dict, url: str, token: str, model: GatewayModel, client: httpx.AsyncClient) -> None:
        self.NAME, self.PARAMETERS, self.text = spec["name"], spec["input_schema"], spec["description"]
        self.url, self.token, self.model, self.client = url, token, model, client

    @property
    def description(self) -> str:
        return self.text

    async def run(self, **arguments):
        tool_call_id = CURRENT_TOOL_CALL.get()
        cause = {"model_call_id": self.model.call_of_tool_call[tool_call_id], "tool_call_id": tool_call_id}
        response = await self.client.post(
            self.url, json={"name": self.NAME, "arguments": arguments, "cause": cause}, headers={"Authorization": "Bearer " + self.token}
        )
        if response.status_code != 200:
            raise RuntimeError(f"tool broker answered {response.status_code}: {response.text}")
        return json.dumps(response.json()["output"])


class Submit(Tool):
    """Submit the final answer; its arguments are the answer."""

    NAME = "submit"

    def __init__(self, schema: dict) -> None:
        self.PARAMETERS = schema
        self.answer: dict | None = None

    def run(self, **answer):
        self.answer = answer
        return "Submitted."


def write_result(result: dict) -> None:
    target = os.environ["RUSH_RESULT"]
    temporary = target + ".tmp"
    with open(temporary, "w", encoding="utf-8") as out:
        json.dump(result, out)
    os.rename(temporary, target)


async def main() -> None:
    with open(os.environ["RUSH_REQUEST"], encoding="utf-8") as source:
        request = json.load(source)
    token = os.environ["RUSH_ATTEMPT_TOKEN"]
    async with httpx.AsyncClient(timeout=120) as client:
        model = GatewayModel(request, token, client)
        submit = Submit(request["case"]["output_schema"])
        tools = [HostedTool(spec, request["tools"]["url"], token, model, client) for spec in request["tools"]["available"]]
        agent = Agent(model, [*tools, submit], system_prompt=request["prompt"]["system"], max_steps=request["limits"]["max_model_calls"])

        def on_tool(event: dict) -> None:
            if event["type"] == "tool_start":
                CURRENT_TOOL_CALL.set(event["id"])

        outcome = await agent.run(request["prompt"]["user"], on_tool=on_tool)
    if submit.answer is not None:
        write_result({"protocol": "rush.harness.v1", "status": "answered", "answer": submit.answer})
    else:
        write_result({"protocol": "rush.harness.v1", "status": "refused", "reason": outcome.answer or "The agent submitted no answer."})


asyncio.run(main())
