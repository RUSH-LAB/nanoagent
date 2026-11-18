"""A standard-library harness that makes the gateway, the tool broker and the command service work at the same time, so
recovery acceptance tests can fault them in flight. The case's `token` argument chooses the behavior:

* `race:N`   one request alone (it carries the prompt), then N concurrent requests; the result is a refusal naming each
             request's HTTP status (the gateway's evidence says which were admitted).
* `hold`     one request alone, then at once a slow model stream, a slow workspace-writing tool and a slow command; the
             harness never finishes by itself (cancellation or lease loss ends it).
* `drain`    like `hold`, but the harness writes its result and exits while the tool and the stream are still running.
* `slow`     one request alone, then a model request the upstream answers only after a long delay (a crash is injected
             while it is in flight).
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request

with open(os.environ["RUSH_REQUEST"], encoding="utf-8") as source:
    REQUEST = json.load(source)
TOKEN = os.environ["RUSH_ATTEMPT_TOKEN"]
BASE = REQUEST["openrouter"]["base_url"]
TOOLS_URL = REQUEST["tools"]["url"]
EXEC_URL = REQUEST["exec_url"]
PROMPT = REQUEST["prompt"]["user"]
MODEL = REQUEST["openrouter"]["model"]
MODE = REQUEST["case"]["arguments"]["token"]
# The mock treats a request as a scripted model turn only when it carries tools.
TOOL_DEFINITION = {"type": "function", "function": {"name": "noop", "description": "unused", "parameters": {"type": "object", "properties": {}}}}


def post(url, body, *, read=True, timeout=600):
    data = json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read() if read else b""
            return response.status, payload
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def chat(stream=False):
    system = [{"role": "system", "content": REQUEST["prompt"]["system"]}] if REQUEST["prompt"]["system"] is not None else []
    body = {"model": MODEL, "messages": [*system, {"role": "user", "content": PROMPT}], "tools": [TOOL_DEFINITION], "stream": stream}
    if stream:
        body["stream_options"] = {"include_usage": True}
    return post(BASE + "/chat/completions", body)


def write_result(result):
    target = os.environ["RUSH_RESULT"]
    with open(target + ".tmp", "w", encoding="utf-8") as out:
        json.dump({"protocol": "rush.harness.v1", **result}, out)
    os.rename(target + ".tmp", target)


def slow_tool(seconds):
    return post(TOOLS_URL, {"name": "slow_write", "arguments": {"name": "progress.bin", "seconds": seconds}})


def slow_command(seconds):
    return post(EXEC_URL, {"argv": ["sleep", str(seconds)], "cwd": ".", "timeout_ms": int(seconds * 1000) + 5000})


def threads(*targets):
    started = [threading.Thread(target=target, daemon=True) for target in targets]
    for thread in started:
        thread.start()
    return started


def refuse(reason):
    write_result({"status": "refused", "reason": reason})


status, _ = chat()
if MODE.startswith("race:"):
    statuses = []
    workers = threads(*[lambda: statuses.append(chat()[0]) for _ in range(int(MODE.split(":")[1]))])
    for worker in workers:
        worker.join()
    refuse(f"first={status} statuses={sorted(statuses)}")
elif MODE == "slow":
    refuse(f"second={chat()[0]}")
else:
    started = threads(lambda: chat(stream=True), lambda: slow_tool(120), lambda: slow_command(120))
    if MODE == "drain":
        time.sleep(float(REQUEST["case"]["arguments"]["wait_seconds"]))
        refuse("exited with a stream, a tool and a command in flight")
    else:
        for thread in started:
            thread.join()
        refuse("finished by itself")
