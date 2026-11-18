"""A scripted rush.harness.v1 harness: it runs the steps of script.json against the attempt's services and reports what each
one saw as one harness `log` event, so an acceptance test can assert exactly what the gateway, tool broker, command service and
event intake answered. The interpreter decides nothing: every request, header, credential and expectation is in the script.

Steps (all fields but `op` optional):

* model: one generation request through the gateway. `dialect`, `stream`, `as` (label), `model` (override), `extra` (body fields),
  `prompt` (default true: the rendered prompt is the first user message), `tools` (default true: the available tools),
  `token` (good | none | bad | api-key | `x-api-key:<credential>` | any other text, sent as a bearer), `span`, `retries` (re-sends the same body when it fails or its stream is cut),
  `after` + `results` (a follow-up turn carrying the proposals of an earlier call and tool results by label).
* tool: POST /tools. `name`, `arguments`, `cause` ({from: label, index} or explicit ids), `as`, `span`, `token`.
* exec: POST /exec. `argv`, `cwd`, `timeout_ms`, `span`, `as`.
* subprocess: a direct subprocess (not through /exec). `argv`.
* http: a direct outbound request to `url`; the observation is the error name.
* raw: any request to the service origin. `method`, `path`, `body`, `token`.
* span: `action` start | end, `id`, `kind`, `name`, `parent`, `status`, `data`.
* event: one raw harness event `body` (sequence filled in unless `sequence` is given).
* write: write `text` to the workspace file `name`.
* read: read the workspace file `path` (the observation holds its text, or the error).
* parallel: run `steps` concurrently.
* sleep: `seconds`.
* answer / refuse: write the result (atomically) and stop.
"""

import base64
import json
import os
import socket
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "site"), HERE]

import httpx  # noqa: E402

with open(os.environ["RUSH_REQUEST"], encoding="utf-8") as source:
    REQUEST = json.load(source)
with open(os.path.join(HERE, "script.json"), encoding="utf-8") as source:
    SCRIPT = json.load(source)
TOKEN = os.environ["RUSH_ATTEMPT_TOKEN"]
BASE = REQUEST["openrouter"]["base_url"]
ORIGIN = BASE[: -len("/api/v1")]
WORKSPACE = os.environ["RUSH_WORKSPACE"]
SUFFIX = {"chat_completions": "/chat/completions", "responses": "/responses", "anthropic_messages": "/messages"}

LOCK = threading.RLock()
OBSERVATIONS: list[dict] = []
MODELS: dict[str, dict] = {}
TOOLS: dict[str, dict] = {}
SEQUENCE = [0]
CLIENT = httpx.Client(timeout=120)


def headers(token: str, span: str | None, extra: dict | None = None) -> dict:
    out = dict(extra or {})
    if token == "good":
        out["Authorization"] = "Bearer " + TOKEN
    elif token == "api-key":
        out["x-api-key"] = TOKEN
    elif token == "bad":
        out["Authorization"] = "Bearer " + TOKEN + "x"
    elif token.startswith("x-api-key:"):  # any other credential is used as given: another attempt's token, say
        out["x-api-key"] = token[len("x-api-key:") :]
    elif token != "none":
        out["Authorization"] = "Bearer " + token
    if span:
        out["X-Rush-Span-Id"] = span
    return out


def observe(step: dict, **fields) -> dict:
    record = {"op": step["op"], "as": step.get("as"), **fields}
    with LOCK:
        OBSERVATIONS.append(record)
    return record


def error_of(response: httpx.Response) -> dict:
    try:
        return (response.json() or {}).get("error") or {}
    except ValueError:
        return {}


def emit(event: dict) -> httpx.Response:
    with LOCK:  # sequences are consecutive per emitter, so numbering and sending are one step
        if "sequence" not in event:
            SEQUENCE[0] += 1
            event = {**event, "sequence": SEQUENCE[0]}
        body = {"protocol": "rush.harness.v1", "emitter_id": "main", **event}
        response = CLIENT.post(REQUEST["events_url"], json=body, headers=headers("good", None))
        if response.status_code != 200 and body["sequence"] == SEQUENCE[0]:
            SEQUENCE[0] -= 1  # a refused event takes no sequence number, so the next one is not a gap
        return response


# -- model ---------------------------------------------------------------------------------------------------------------


def tool_definitions(dialect: str) -> list:
    out = []
    for tool in REQUEST["tools"]["available"]:
        if dialect == "chat_completions":
            out.append({"type": "function", "function": {"name": tool["name"], "description": tool["description"], "parameters": tool["input_schema"]}})
        elif dialect == "responses":
            out.append({"type": "function", "name": tool["name"], "description": tool["description"], "parameters": tool["input_schema"]})
        else:
            out.append({"name": tool["name"], "description": tool["description"], "input_schema": tool["input_schema"]})
    return out


def follow_up(step: dict, dialect: str) -> list:
    """Messages (or input items) that replay an earlier call's proposals and carry tool results back."""
    earlier = MODELS[step["after"]]
    results = {item["index"]: TOOLS[item["tool"]] for item in step.get("results", [])}
    proposals = earlier["proposals"]
    if dialect == "chat_completions":
        calls = [{"id": p["id"], "type": "function", "function": {"name": p["name"], "arguments": p["raw"]}} for p in proposals]
        out = [{"role": "assistant", "content": earlier["text"] or None, "tool_calls": calls}]
        out += [{"role": "tool", "tool_call_id": proposals[i]["id"], "content": json.dumps(r["output"])} for i, r in sorted(results.items())]
    elif dialect == "responses":
        out = [{"type": "function_call", "call_id": p["id"], "name": p["name"], "arguments": p["raw"]} for p in proposals]
        out += [{"type": "function_call_output", "call_id": proposals[i]["id"], "output": json.dumps(r["output"])} for i, r in sorted(results.items())]
    else:
        out = [{"role": "assistant", "content": [{"type": "tool_use", "id": p["id"], "name": p["name"], "input": json.loads(p["raw"] or "{}")} for p in proposals]}]
        out += [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": proposals[i]["id"], "content": json.dumps(r["output"])}]} for i, r in sorted(results.items())]
    return out


def model_body(step: dict, dialect: str) -> dict:
    body: dict = {"model": step.get("model") or REQUEST["openrouter"]["model"], "stream": bool(step.get("stream"))}
    prompt = REQUEST["prompt"]["user"] if step.get("prompt", True) else "hello"
    extra = follow_up(step, dialect) if step.get("after") else []
    # The gateway's first-prompt rule: a pinned system text (task_tools agent) rides along byte for byte.
    system = REQUEST["prompt"]["system"] if step.get("prompt", True) else None
    if dialect == "responses":
        body["input"] = [*([{"role": "system", "content": system}] if system else []), {"role": "user", "content": prompt}, *extra]
        body["max_output_tokens"] = 64
    else:
        lead = [{"role": "system", "content": system}] if system and dialect == "chat_completions" else []
        body["messages"] = [*lead, {"role": "user", "content": prompt}, *extra]
        body["max_tokens"] = 64
        if system and dialect != "chat_completions":
            body["system"] = system
    if dialect == "chat_completions" and body["stream"]:
        body["stream_options"] = {"include_usage": True}
    if step.get("tools", True):
        body["tools"] = tool_definitions(dialect)
    body.update(step.get("extra", {}))
    return body


class Assembly:
    """Tool proposals, text and whether the stream finished, from one response in any dialect."""

    def __init__(self, dialect: str) -> None:
        self.dialect, self.calls, self.text, self.complete, self.order = dialect, {}, "", False, []

    def call(self, key, **fields) -> dict:
        if key not in self.calls:
            self.calls[key] = {"id": "", "name": "", "raw": ""}
            self.order.append(key)
        self.calls[key].update({k: v for k, v in fields.items() if v})
        return self.calls[key]

    def frame(self, event: str | None, data: dict) -> None:
        if self.dialect == "chat_completions":
            for choice in data.get("choices") or []:
                delta = choice.get("delta") or {}
                self.text += delta.get("content") or ""
                for fragment in delta.get("tool_calls") or []:
                    function = fragment.get("function") or {}
                    call = self.call(fragment["index"], id=fragment.get("id"), name=function.get("name"))
                    call["raw"] += function.get("arguments") or ""
        elif self.dialect == "responses":
            kind = data.get("type")
            if kind == "response.output_item.added" and (data.get("item") or {}).get("type") == "function_call":
                item = data["item"]
                self.call(data["output_index"], id=item.get("call_id"), name=item.get("name"))
            elif kind == "response.function_call_arguments.delta":
                self.call(data["output_index"])["raw"] += data["delta"]
            elif kind == "response.output_text.delta":
                self.text += data["delta"]
            elif kind in ("response.completed", "response.failed", "response.incomplete"):
                self.complete = kind == "response.completed"
        else:
            kind = data.get("type")
            if kind == "content_block_start" and (data.get("content_block") or {}).get("type") == "tool_use":
                block = data["content_block"]
                self.call(data["index"], id=block.get("id"), name=block.get("name"))
            elif kind == "content_block_delta":
                delta = data.get("delta") or {}
                if delta.get("type") == "input_json_delta":
                    self.call(data["index"])["raw"] += delta["partial_json"]
                elif delta.get("type") == "text_delta":
                    self.text += delta["text"]
            elif kind == "message_stop":
                self.complete = True

    def body(self, data: dict) -> None:
        """A non-streamed response."""
        self.complete = True
        if self.dialect == "chat_completions":
            message = ((data.get("choices") or [{}])[0]).get("message") or {}
            self.text = message.get("content") or ""
            for index, call in enumerate(message.get("tool_calls") or []):
                self.call(index, id=call["id"], name=call["function"]["name"])["raw"] = call["function"]["arguments"]
        elif self.dialect == "responses":
            for index, item in enumerate(data.get("output") or []):
                if item.get("type") == "function_call":
                    self.call(index, id=item["call_id"], name=item["name"])["raw"] = item["arguments"]
        else:
            for index, block in enumerate(data.get("content") or []):
                if block.get("type") == "tool_use":
                    self.call(index, id=block["id"], name=block["name"])["raw"] = json.dumps(block["input"])

    def proposals(self) -> list:
        return [self.calls[key] for key in sorted(self.order)]


def send_model(step: dict, body: dict, dialect: str) -> dict:
    url = ORIGIN + step["path"] if step.get("path") else BASE + SUFFIX[dialect]
    assembly = Assembly(dialect)
    frames = 0
    started = time.monotonic()
    request = CLIENT.build_request("POST", url, json=body, headers=headers(step.get("token", "good"), step.get("span"), step.get("headers")))
    response = CLIENT.send(request, stream=True)
    try:
        status = response.status_code
        call_id = response.headers.get("X-Rush-Call-Id")
        error = {}
        if status == 200 and body["stream"]:
            event = None
            for line in response.iter_lines():
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: "):
                    payload = line[6:]
                    if payload == "[DONE]":
                        assembly.complete = True
                        continue
                    frames += 1
                    assembly.frame(event, json.loads(payload))
        else:
            raw = response.read()
            if status == 200:
                assembly.body(json.loads(raw))
            else:
                error = error_of(response)
                if not error:
                    try:
                        error = {"message": raw.decode()[:200]}
                    except ValueError:
                        error = {}
    finally:
        response.close()
    return {"status": status, "call_id": call_id, "code": error.get("code") or error.get("type"), "complete": assembly.complete and status == 200, "frames": frames,
            "text": assembly.text, "proposals": assembly.proposals(), "seconds": round(time.monotonic() - started, 3)}


def do_model(step: dict) -> None:
    dialect = step.get("dialect", "chat_completions")
    body = model_body(step, dialect)
    attempts = []
    for _ in range(1 + step.get("retries", 0)):
        try:
            outcome = send_model(step, body, dialect)
        except httpx.HTTPError as error:
            outcome = {"status": None, "call_id": None, "code": type(error).__name__, "complete": False, "frames": 0, "text": "", "proposals": []}
        attempts.append(outcome)
        if outcome["complete"] or (outcome["status"] is not None and outcome["status"] not in (429, 500, 502, 503, 504) and outcome["status"] != 200):
            break
        time.sleep(0.05)
    last = attempts[-1]
    if step.get("as"):
        MODELS[step["as"]] = {"call_id": last["call_id"], "proposals": [{"id": p["id"], "name": p["name"], "raw": p["raw"]} for p in last["proposals"]], "text": last["text"]}
    observe(step, dialect=dialect, attempts=[{k: v for k, v in a.items() if k != "text"} for a in attempts], proposals=[{**p, "arguments": parse(p["raw"])} for p in last["proposals"]], text=last["text"])


def parse(raw: str):
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {"unparsed": raw}


# -- tools, commands, events ------------------------------------------------------------------------------------------


def cause_of(step: dict):
    cause = step.get("cause")
    if cause is None:
        return None
    if "from" in cause:
        earlier = MODELS[cause["from"]]
        return {"model_call_id": earlier["call_id"], "tool_call_id": cause.get("tool_call_id") or earlier["proposals"][cause["index"]]["id"]}
    return cause


def do_tool(step: dict) -> None:
    body = {"name": step["name"], "arguments": step.get("arguments", {})}
    if (cause := cause_of(step)) is not None:
        body["cause"] = cause
    response = CLIENT.post(REQUEST["tools"]["url"], json=body, headers=headers(step.get("token", "good"), step.get("span")))
    payload = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    error = payload.get("error") or {}
    if step.get("as") and response.status_code == 200:
        TOOLS[step["as"]] = {"output": payload["output"]}
    observe(step, name=step["name"], status=response.status_code, call_id=response.headers.get("X-Rush-Call-Id"), code=error.get("code"), message=error.get("message"), output=payload.get("output"))


def do_exec(step: dict) -> None:
    body = {"argv": step["argv"], "cwd": step.get("cwd", "."), "timeout_ms": step.get("timeout_ms", 20000)}
    response = CLIENT.post(REQUEST["exec_url"], json=body, headers=headers(step.get("token", "good"), step.get("span")), timeout=120)
    payload = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    error = payload.get("error") or {}
    fields: dict = {"status": response.status_code, "call_id": response.headers.get("X-Rush-Call-Id"), "code": error.get("code"), "message": error.get("message")}
    if response.status_code == 200:
        out, err = (base64.b64decode(payload[name]["base64"]) for name in ("stdout", "stderr"))
        fields |= {"termination": payload["termination"], "stdout_bytes": len(out), "stderr_bytes": len(err), "stdout_truncated": payload["stdout"]["truncated"],
                   "stderr_truncated": payload["stderr"]["truncated"], "stdout_head": out[:120].decode(errors="replace"), "stderr_head": err[:120].decode(errors="replace")}
    observe(step, argv=step["argv"], cwd=body["cwd"], **fields)


def do_subprocess(step: dict) -> None:
    done = subprocess.run(step["argv"], capture_output=True, text=True, timeout=60, cwd=WORKSPACE, check=False)
    observe(step, argv=step["argv"], exit_code=done.returncode, stdout=done.stdout[:200])


def do_http(step: dict) -> None:
    try:
        response = httpx.get(step["url"], timeout=step.get("timeout", 5))
        outcome = {"error": None, "status": response.status_code}
    except httpx.HTTPError as error:
        cause = error.__cause__
        errno_name = None
        while cause is not None and errno_name is None:
            errno_name = getattr(cause, "errno", None)
            cause = cause.__cause__
        outcome = {"error": type(error).__name__, "errno": errno_name, "status": None, "message": str(error)[:200]}
    observe(step, url=step["url"], **outcome)


def do_tcp(step: dict) -> None:
    try:
        socket.create_connection((step["host"], step["port"]), timeout=step.get("timeout", 5)).close()
        outcome = {"error": None}
    except OSError as error:
        outcome = {"error": type(error).__name__, "errno": error.errno}
    observe(step, host=step["host"], port=step["port"], **outcome)


def do_raw(step: dict) -> None:
    response = CLIENT.request(step.get("method", "POST"), ORIGIN + step["path"], json=step.get("body"), headers=headers(step.get("token", "good"), None))
    error = error_of(response)
    observe(step, method=step.get("method", "POST"), path=step["path"], status=response.status_code, code=error.get("code"))


def resolved(value):
    """A string "$label" in span data is the gateway call ID of the model step with that label."""
    if isinstance(value, str) and value.startswith("$") and value[1:] in MODELS:
        return MODELS[value[1:]]["call_id"]
    if isinstance(value, dict):
        return {key: resolved(item) for key, item in value.items()}
    if isinstance(value, list):
        return [resolved(item) for item in value]
    return value


def do_span(step: dict) -> None:
    data = resolved(step.get("data", {}))
    if step["action"] == "start":
        event = {"event": "span.start", "span_id": step["id"], "kind": step["kind"], "name": step["name"], "data": data}
        if step.get("parent"):
            event["parent_span_id"] = step["parent"]
    else:
        event = {"event": "span.end", "span_id": step["id"], "status": step.get("status", "ok"), "data": data}
    response = emit(event)
    observe(step, id=step["id"], action=step["action"], status=response.status_code, code=error_of(response).get("code"))


def do_event(step: dict) -> None:
    response = emit(step["body"] | ({"sequence": step["sequence"]} if "sequence" in step else {}))
    observe(step, status=response.status_code, code=error_of(response).get("code"))


def do_read(step: dict) -> None:
    try:
        with open(os.path.join(WORKSPACE, step["path"]), encoding="utf-8") as source:
            observe(step, path=step["path"], text=source.read())
    except OSError as error:
        observe(step, path=step["path"], error=type(error).__name__)


def do_write(step: dict) -> None:
    with open(os.path.join(WORKSPACE, step["name"]), "w", encoding="utf-8") as out:
        out.write(step["text"])
    observe(step, name=step["name"])


def finish(result: dict) -> None:
    target = os.environ["RUSH_RESULT"]
    with open(target + ".tmp", "w", encoding="utf-8") as out:
        json.dump(result, out)
    os.rename(target + ".tmp", target)


def run(step: dict) -> None:
    match step["op"]:
        case "model":
            do_model(step)
        case "tool":
            do_tool(step)
        case "exec":
            do_exec(step)
        case "subprocess":
            do_subprocess(step)
        case "http":
            do_http(step)
        case "tcp":
            do_tcp(step)
        case "raw":
            do_raw(step)
        case "span":
            do_span(step)
        case "event":
            do_event(step)
        case "write":
            do_write(step)
        case "read":
            do_read(step)
        case "sleep":
            time.sleep(step["seconds"])
        case "parallel":
            threads = [threading.Thread(target=run, args=(child,)) for child in step["steps"]]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        case other:
            raise SystemExit(f"unknown op {other!r}")


def report() -> None:
    with LOCK:
        message = json.dumps(OBSERVATIONS)
    emit({"event": "log", "span_id": "root", "message": message})


def main() -> None:
    if SCRIPT.get("root", True):
        emit({"event": "span.start", "span_id": "root", "kind": "agent", "name": "scripted harness"})
    final = None
    try:
        for step in SCRIPT["steps"]:
            if step["op"] in ("answer", "refuse"):
                final = step
                break
            run(step)
    except Exception as error:
        observe({"op": "crash"}, error=f"{type(error).__name__}: {error}")
        report()
        raise
    report()
    if SCRIPT.get("root", True):
        emit({"event": "span.end", "span_id": "root", "status": "ok"})
    if final is None:
        return
    if final["op"] == "answer":  # "$token" is this attempt's own credential, for a later attempt to try
        finish({"protocol": "rush.harness.v1", "status": "answered", "answer": {key: TOKEN if value == "$token" else value for key, value in final["answer"].items()}})
    else:
        finish({"protocol": "rush.harness.v1", "status": "refused", "reason": final["reason"]})


main()
