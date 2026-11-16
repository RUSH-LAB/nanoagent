"""A rush.harness.v1 harness whose outcome the case's input token chooses, so one source drives every scoring, prompt and policy
scenario. It works under both participant policies and does the same thing under each:

  * coding: the result is `answer.json` in the workspace (`{"refused": reason}` to refuse); the tools list is empty.
  * task_tools: the result is RUSH_RESULT (`answered` + answer | `refused` + reason).

It sends the pinned prompt (its system text and its user text, whichever are not null, byte for byte) in one plain chat request
to the gateway (except `zero-model`, which makes none), reports what it was given in one `log` event (policy, tool names, limits,
network probes), and then does what its token says: answer the digest, answer wrongly, answer with the wrong shape, refuse, write
no result, write a malformed result, exit nonzero, or never finish. Coding-only tokens probe answer.json (a blank refusal reason, a JSON
array, a symlink to a valid answer) and `fill-disk` reports how much /tmp and the workspace take. Any other token is answered correctly.
"""

import errno
import hashlib
import json
import os
import socket
import time
import urllib.error
import urllib.request

with open(os.environ["RUSH_REQUEST"], encoding="utf-8") as source:
    request = json.load(source)
token = request["case"]["arguments"]["token"]
digest = hashlib.sha256(token.encode()).hexdigest()[:12]
policy = request["policy"]
TOKEN = os.environ["RUSH_ATTEMPT_TOKEN"]
SEQUENCE = [0]


def post(url: str, body: dict) -> bytes:
    http_request = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN})
    with urllib.request.urlopen(http_request, timeout=60) as response:
        return response.read()


def emit(event: dict) -> None:
    SEQUENCE[0] += 1
    post(request["events_url"], {"protocol": "rush.harness.v1", "emitter_id": "probe", "sequence": SEQUENCE[0], "span_id": "root", **event})


def ask_model() -> int:
    """One plain chat request with the pinned prompt; the HTTP status (a refused request is a status, not a crash)."""
    prompt = request["prompt"]
    messages = [{"role": role, "content": prompt[role]} for role in ("system", "user") if prompt[role] is not None]
    try:
        post(request["openrouter"]["base_url"] + "/chat/completions", {"model": request["openrouter"]["model"], "messages": messages, "max_tokens": 16})
    except urllib.error.HTTPError as error:
        return error.code
    return 200


def reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=5):
            return True
    except OSError:
        return False


def probes() -> dict:
    """What the harness's network reaches: a public address, the relay (its own gateway), and the worker host's loopback gateway."""
    if token != "network":
        return {}
    relay = request["openrouter"]["base_url"].split("//", 1)[1].split("/", 1)[0].rsplit(":", 1)
    return {"public": reachable("1.1.1.1", 443), "relay": reachable(relay[0], int(relay[1])), "metadata": reachable("169.254.169.254", 80), "private": reachable("10.0.0.1", 80)}


def write_result(text: str) -> None:
    """The case's result by the policy's channel: RUSH_RESULT for task_tools, answer.json for coding."""
    target = os.environ["RUSH_RESULT"] if policy == "task_tools" else os.path.join(request["workspace"], "answer.json")
    with open(target + ".tmp", "w", encoding="utf-8") as out:
        out.write(text)
    os.rename(target + ".tmp", target)


def answered(value) -> str:
    answer = {"digest": value}
    return json.dumps({"protocol": "rush.harness.v1", "status": "answered", "answer": answer}) if policy == "task_tools" else json.dumps(answer)


def refused(reason: str) -> str:
    return json.dumps({"protocol": "rush.harness.v1", "status": "refused", "reason": reason}) if policy == "task_tools" else json.dumps({"refused": reason})


emit({"event": "span.start", "kind": "agent", "name": "probe"})
emit(
    {
        "event": "log",
        "message": json.dumps(
            {
                "policy": policy,
                "tools": [tool["name"] for tool in request["tools"]["available"]],
                "limits": request["limits"],
                "task": {key: request["task"][key] for key in ("id", "kind", "plugin_name")},
                "probes": probes(),
            },
            sort_keys=True,
        ),
    }
)
emit({"event": "span.end", "status": "ok"})


def fill(path: str, cap: int = 16 << 20) -> dict:
    """Write 256 KiB chunks to ``path`` until the write fails or ``cap``: how much the volume took and the error it ended with."""
    written, error = 0, None
    try:
        with open(path, "wb") as out:
            while written < cap:
                out.write(b"x" * (256 << 10))
                out.flush()
                written += 256 << 10
    except OSError as failure:
        error = errno.errorcode[failure.errno]
    finally:
        os.remove(path)
    return {"written": written, "error": error}


if token == "fill-disk":
    # What the run's tmp_bytes and workspace_bytes allow: each volume is filled until it refuses, then emptied again.
    report = {"tmp": fill("/tmp/fill.bin"), "workspace": fill(os.path.join(request["workspace"], "fill.bin"))}
    emit({"event": "span.start", "span_id": "disk", "parent_span_id": "root", "kind": "operation", "name": "disk"})
    emit({"event": "log", "span_id": "disk", "message": json.dumps(report)})
    emit({"event": "span.end", "span_id": "disk", "status": "ok"})
if token == "many-calls":
    # More requests than the run allows: the gateway refuses the ones past max_model_calls, and the harness reports each status.
    statuses = [ask_model() for _ in range(3)]
    emit({"event": "span.start", "span_id": "calls", "parent_span_id": "root", "kind": "operation", "name": "calls"})
    emit({"event": "log", "span_id": "calls", "message": json.dumps({"statuses": statuses})})
    emit({"event": "span.end", "span_id": "calls", "status": "ok"})
elif token != "zero-model":
    ask_model()
if token == "timeout":
    time.sleep(3600)
elif token == "harness-failure":
    raise SystemExit(3)
elif token == "missing-result":
    pass
elif token == "malformed-result":
    write_result("{not json")
elif token == "wrong-answer":
    write_result(answered(hashlib.sha256(b"x").hexdigest()[:12]))
elif token == "invalid-answer":
    # Valid JSON that is not the task's output shape: a coding answer.json fails the output check, a task_tools result fails the schema.
    write_result(answered(12345))
elif token == "blank-refusal":
    write_result(refused("   "))
elif token == "array-result":
    write_result("[1, 2]")
elif token == "symlink-result":
    # A valid answer behind a link: the reader must not follow the link.
    real = os.path.join(request["workspace"], "answer-real.json")
    with open(real, "w", encoding="utf-8") as out:
        out.write(answered(digest))
    os.symlink("answer-real.json", os.path.join(request["workspace"], "answer.json"))
elif token == "verifier-crash":
    write_result(answered("0" * 12))
elif token == "refuse-answered":
    # A case to refuse that the harness answers.
    write_result(answered(digest))
elif token.startswith("refuse-") or token == "decline-answerable":
    write_result(refused("I decline to answer."))
else:
    write_result(answered(digest))
