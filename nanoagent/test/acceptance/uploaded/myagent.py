#!/usr/bin/env python3
"""A member's own agent, as test_rush_agent.py installs it in a Terminal session's `.rush/python/bin/`: a chat-completions loop over
`$OPENAI_BASE_URL` with PI's four tools (bash, edit, read, write), so the scripted upstream recognises it as `pi` and renders its acts as
`bash` calls. `myagent --version` makes no model call; `myagent "<prompt>"` works the prompt until the model answers without a tool call."""

import json
import os
import subprocess
import sys
import urllib.request

TOOLS = [
    {"type": "function", "function": {"name": name, "description": name, "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}}}
    for name in ("bash", "edit", "read", "write")
]


def ask(messages: list) -> dict:
    body = {"model": os.environ["RUSH_MODEL"], "messages": messages, "tools": TOOLS}
    sent = urllib.request.Request(os.environ["OPENAI_BASE_URL"].rstrip("/") + "/chat/completions", data=json.dumps(body).encode(), method="POST",
                                  headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"})  # fmt: skip
    with urllib.request.urlopen(sent, timeout=300) as response:
        return json.loads(response.read())["choices"][0]["message"]


def main() -> int:
    if sys.argv[1:] == ["--version"]:
        print("myagent 1.0")
        return 0
    messages: list = [{"role": "user", "content": sys.argv[-1]}]
    for _ in range(20):
        message = ask(messages)
        messages.append({"role": "assistant", "content": message.get("content"), "tool_calls": message.get("tool_calls")})
        if not message.get("tool_calls"):
            print(message.get("content") or "")
            return 0
        for call in message["tool_calls"]:
            command = json.loads(call["function"]["arguments"])["command"]
            done = subprocess.run(["bash", "-c", command], capture_output=True, text=True)
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": f"exit {done.returncode}\n{done.stdout}{done.stderr}"})
    return 1


if __name__ == "__main__":
    sys.exit(main())
