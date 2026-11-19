"""The Anthropic Python SDK as an uploaded harness: it appends `/v1/messages` to the base URL it is given, so it is configured with
the gateway's base URL minus its final `/v1` segment. One streamed request proposes the plugin's write_note, the broker runs it with
the proposal as its cause, a second request carries the result, and the answer is submitted atomically.
"""

import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "site"), HERE]

import anthropic  # noqa: E402

with open(os.environ["RUSH_REQUEST"], encoding="utf-8") as source:
    request = json.load(source)
token = os.environ["RUSH_ATTEMPT_TOKEN"]
base_url = request["openrouter"]["base_url"]
assert base_url.endswith("/api/v1"), base_url
client = anthropic.Anthropic(base_url=base_url[: -len("/v1")], api_key=token)
model = request["openrouter"]["model"]
tools = [{"name": t["name"], "description": t["description"], "input_schema": t["input_schema"]} for t in request["tools"]["available"]]
messages = [{"role": "user", "content": request["prompt"]["user"]}]
# The gateway's first-prompt rule: the pinned system text (task_tools agent) rides in Anthropic's `system` field.
system = {} if request["prompt"]["system"] is None else {"system": request["prompt"]["system"]}

raw = client.messages.with_raw_response.create(model=model, max_tokens=64, messages=messages, tools=tools, stream=True, **system)
call_id = raw.headers["x-rush-call-id"]
blocks = {}
with raw.parse() as stream:
    for event in stream:
        if event.type == "content_block_start" and event.content_block.type == "tool_use":
            blocks[event.index] = {"id": event.content_block.id, "name": event.content_block.name, "json": ""}
        elif event.type == "content_block_delta" and event.delta.type == "input_json_delta":
            blocks[event.index]["json"] += event.delta.partial_json
[tool_use] = [{"id": b["id"], "name": b["name"], "input": json.loads(b["json"])} for b in blocks.values()]

body = {"name": tool_use["name"], "arguments": tool_use["input"], "cause": {"model_call_id": call_id, "tool_call_id": tool_use["id"]}}
http_request = urllib.request.Request(
    request["tools"]["url"], json.dumps(body).encode(), {"Content-Type": "application/json", "Authorization": "Bearer " + token}
)
with urllib.request.urlopen(http_request, timeout=120) as response:
    output = json.load(response)["output"]

messages += [
    {"role": "assistant", "content": [{"type": "tool_use", "id": tool_use["id"], "name": tool_use["name"], "input": tool_use["input"]}]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_use["id"], "content": json.dumps(output)}]},
]
client.messages.create(model=model, max_tokens=64, messages=messages, tools=tools, **system)

target = os.environ["RUSH_RESULT"]
with open(target + ".tmp", "w", encoding="utf-8") as out:
    json.dump({"protocol": "rush.harness.v1", "status": "answered", "answer": {"path": output["path"], "bytes": output["bytes"]}}, out)
os.rename(target + ".tmp", target)
