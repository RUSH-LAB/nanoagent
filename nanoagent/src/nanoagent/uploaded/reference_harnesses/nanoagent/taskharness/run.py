"""One attempt: read the request, work the task, write the result."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx

from taskharness.broker import Broker, ToolSpec
from taskharness.events import CURRENT_SPAN, PROTOCOL, Spans
from taskharness.model import GatewayModel
from taskharness.work import work_agent, work_decide


def write_result(result: dict[str, Any]) -> None:
    target = Path(os.environ["RUSH_RESULT"])
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(json.dumps(result), encoding="utf-8")
    temporary.rename(target)


async def attempt(request: dict[str, Any], token: str) -> dict[str, Any]:
    """The result of the attempt; raises when the work fails, so the worker sees a failed harness."""
    task, case, prompt, limits = request["task"], request["case"], request["prompt"], request["limits"]
    tools = [ToolSpec(t["name"], t["description"], t["input_schema"], t["output_schema"]) for t in request["tools"]["available"]]
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        model = GatewayModel.connect(
            base_url=request["openrouter"]["base_url"],
            token=token,
            model=request["openrouter"]["model"],
            max_tokens=limits["max_output_tokens_per_call"],
        )
        spans = Spans(request["events_url"], token, client)
        broker = Broker(request["tools"]["url"], token, client, model.call_of)
        root = await spans.start("agent", f"nanoagent {task['id']}")
        CURRENT_SPAN.set(root)
        try:
            # A tool task is worked as an agent task: the agent is given the tools it would call.
            if task["kind"] == "decide":
                output = await work_decide(
                    system=prompt["system"],
                    arguments=case["arguments"],
                    input_schema=case["input_schema"],
                    output_schema=case["output_schema"],
                    tools=tools,
                    broker=broker,
                    model=model,
                    max_steps=limits["max_model_calls"],
                    spans=spans,
                    root_span=root,
                )
                result = {"protocol": PROTOCOL, "status": "answered", "answer": output}
            else:
                outcome = await work_agent(
                    system=prompt["system"],
                    user=prompt["user"],
                    output_schema=case["output_schema"],
                    tools=tools,
                    broker=broker,
                    model=model,
                    max_steps=limits["max_model_calls"],
                )
                result = (
                    {"protocol": PROTOCOL, "status": "answered", "answer": outcome.output}
                    if outcome.output is not None
                    else {"protocol": PROTOCOL, "status": "refused", "reason": outcome.refusal}
                )
        except BaseException:
            await spans.end(root, "error")
            raise
        finally:
            await model.aclose()
        await spans.end(root)
        return result
