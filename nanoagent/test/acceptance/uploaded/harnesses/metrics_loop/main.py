"""A model-driven agent loop for the metrics and comparison gates: it asks the model, runs the tools it proposes
(concurrently) and submits the answer
the model gives through `submit`. `script.json` (beside this file) only shapes the harness, never the model's behavior:

  dialect          chat_completions | responses | anthropic_messages (every request is streamed)
  instrument       report spans and waits to the events endpoint; false is an opaque harness that reports nothing
  retries/backoff_s  how often, and after how long, a 429 or 5xx answer is asked again
  busy_s           CPU seconds the harness spends in a loop before its first request
  local_branch_s   CPU seconds a parallel subagent branch spends while the first request is in flight
  early_tools      launch each tool the moment its proposal is complete in the stream (responses and anthropic_messages only),
                   while the model's response is still arriving; false launches them all after the response ends
  reject_first     send one request the gateway must refuse before dispatch (a `route` fallback), then the real one
  hold_root        never end the root span (an instrumented harness that stops reporting)
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "script.json"), encoding="utf-8") as source:
    SCRIPT = json.load(source)
with open(os.environ["RUSH_REQUEST"], encoding="utf-8") as source:
    REQUEST = json.load(source)
TOKEN = os.environ["RUSH_ATTEMPT_TOKEN"]
DIALECT = SCRIPT["dialect"]
BASE = REQUEST["openrouter"]["base_url"]
MODEL = REQUEST["openrouter"]["model"]
SYSTEM = REQUEST["prompt"]["system"] or "You are a benchmark harness. Use the tools you are given, then submit your answer with the submit tool."


class Events:
    """Harness events: one emitter, consecutive sequences, spans started and ended."""

    def __init__(self) -> None:
        self.sequence = 0
        self.lock = threading.Lock()

    def send(self, body: dict) -> None:
        if not SCRIPT["instrument"]:
            return
        with self.lock:
            self.sequence += 1
            event = {"protocol": "rush.harness.v1", "emitter_id": "loop", "sequence": self.sequence, **body}
            http_request = urllib.request.Request(REQUEST["events_url"], json.dumps(event).encode(), {"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN})
            urllib.request.urlopen(http_request, timeout=60).read()

    def start(self, span: str, kind: str, name: str, parent: str | None = None, data: dict | None = None) -> None:
        self.send({"event": "span.start", "span_id": span, "kind": kind, "name": name, **({"parent_span_id": parent} if parent else {}), "data": data or {}})

    def end(self, span: str, status: str = "ok", data: dict | None = None) -> None:
        self.send({"event": "span.end", "span_id": span, "status": status, "data": data or {}})


EVENTS = Events()
COUNTER = iter(range(1, 10_000))
COUNTER_LOCK = threading.Lock()
REJECTED: list[int] = []


def new_span(prefix: str) -> str:
    with COUNTER_LOCK:
        return f"{prefix}-{next(COUNTER)}"


def busy(seconds: float) -> None:
    end = time.process_time() + seconds
    while time.process_time() < end:
        pass


def post(url: str, body: dict, headers: dict) -> urllib.response.addinfourl:
    return urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json", **headers}), timeout=300)


def run_tool(name: str, arguments: dict, model_call: str, tool_call: str, parent: str) -> str:
    """A hosted tool through the broker, under its own tool span."""
    span = new_span("tool")
    EVENTS.start(span, "tool", name, parent)
    try:
        with post(REQUEST["tools"]["url"] + "", {"name": name, "arguments": arguments, "cause": {"model_call_id": model_call, "tool_call_id": tool_call}}, {"Authorization": "Bearer " + TOKEN, "X-Rush-Span-Id": span}) as response:
            output = response.read().decode()
    except urllib.error.HTTPError as error:
        output = error.read().decode()
        EVENTS.end(span, "error")
        return output
    EVENTS.end(span)
    return json.dumps(json.loads(output)["output"])


class Round:
    """One physical streamed request and what the model proposed in it."""

    def __init__(self) -> None:
        self.call_id = ""
        self.text = ""
        self.proposals: list[dict] = []  # {id, name, arguments (a JSON text)}
        self.early: dict[str, threading.Thread] = {}  # tool threads launched on a frame before the stream ended


def tool_specs() -> list[dict]:
    tools = [{"name": t["name"], "description": t["description"], "schema": t["input_schema"]} for t in REQUEST["tools"]["available"]]
    return [*tools, {"name": "submit", "description": "Submit the final answer.", "schema": REQUEST["case"]["output_schema"]}]


def request_for(history: list) -> tuple[str, dict, dict]:
    specs = tool_specs()
    if DIALECT == "chat_completions":
        tools = [{"type": "function", "function": {"name": s["name"], "description": s["description"], "parameters": s["schema"]}} for s in specs]
        body = {"model": MODEL, "messages": history, "tools": tools, "stream": True, "stream_options": {"include_usage": True}}
        return "/chat/completions", body, {"Authorization": "Bearer " + TOKEN}
    if DIALECT == "responses":
        tools = [{"type": "function", "name": s["name"], "description": s["description"], "parameters": s["schema"]} for s in specs]
        return "/responses", {"model": MODEL, "input": history, "tools": tools, "stream": True}, {"Authorization": "Bearer " + TOKEN}
    tools = [{"name": s["name"], "description": s["description"], "input_schema": s["schema"]} for s in specs]
    body = {"model": MODEL, "max_tokens": 1024, "system": SYSTEM, "messages": history, "tools": tools, "stream": True}
    return "/messages", body, {"x-api-key": TOKEN, "anthropic-version": "2023-06-01"}


def lines_of(response):
    for raw in response:
        line = raw.decode().rstrip("\r\n")
        if line.startswith("data: ") and line != "data: [DONE]":
            yield json.loads(line[6:])


def launch_early(current: Round, proposal: dict, outputs: dict[str, str]) -> None:
    """Start a proposed tool now, from the frame that completed it."""
    if proposal["name"] == "submit" or proposal["id"] in current.early:
        return
    thread = threading.Thread(target=lambda: outputs.__setitem__(proposal["id"], run_tool(proposal["name"], json.loads(proposal["arguments"]), current.call_id, proposal["id"], "root")))
    current.early[proposal["id"]] = thread
    thread.start()


def read_round(response, current: Round, parent: str, outputs: dict[str, str]) -> None:
    """Fill ``current`` from the stream, launching tools early when the script asks for it."""
    early = SCRIPT.get("early_tools")
    items: dict[str, dict] = {}  # responses: the function-call items announced so far, by item id
    calls: dict[int, dict] = {}
    blocks: dict[int, dict] = {}
    for chunk in lines_of(response):
        if DIALECT == "chat_completions":
            for choice in chunk.get("choices") or []:
                delta = choice["delta"]
                current.text += delta.get("content") or ""
                for fragment in delta.get("tool_calls") or []:
                    call = calls.setdefault(fragment["index"], {"id": "", "name": "", "arguments": ""})
                    call["id"] = fragment.get("id") or call["id"]
                    call["name"] += (fragment.get("function") or {}).get("name") or ""
                    call["arguments"] += (fragment.get("function") or {}).get("arguments") or ""
        elif DIALECT == "responses":
            if chunk.get("type") == "response.output_item.added" and chunk["item"]["type"] == "function_call":
                items[chunk["item"]["id"]] = chunk["item"]
            elif early and chunk.get("type") == "response.function_call_arguments.done":
                # The arguments are complete here, the earliest frame that makes the proposal callable.
                item = items[chunk["item_id"]]
                launch_early(current, {"id": item["call_id"], "name": chunk.get("name") or item["name"], "arguments": chunk["arguments"]}, outputs)
            if chunk.get("type") == "response.completed":
                for item in chunk["response"]["output"]:
                    if item["type"] == "function_call":
                        current.proposals.append({"id": item["call_id"], "name": item["name"], "arguments": item["arguments"]})
                    elif item["type"] == "message":
                        current.text += "".join(part.get("text", "") for part in item["content"])
        else:
            kind = chunk.get("type")
            if kind == "content_block_start":
                block = chunk["content_block"]
                blocks[chunk["index"]] = {"id": block.get("id", ""), "name": block.get("name", ""), "type": block["type"], "arguments": ""}
            elif early and kind == "content_block_stop" and blocks[chunk["index"]]["type"] == "tool_use":
                block = blocks[chunk["index"]]
                launch_early(current, {"id": block["id"], "name": block["name"], "arguments": block["arguments"] or "{}"}, outputs)
            elif kind == "content_block_delta":
                delta = chunk["delta"]
                blocks[chunk["index"]]["arguments"] += delta.get("partial_json", "")
                current.text += delta.get("text", "")
    if DIALECT == "chat_completions":
        current.proposals = [calls[i] for i in sorted(calls)]
    elif DIALECT == "anthropic_messages":
        current.proposals = [{"id": b["id"], "name": b["name"], "arguments": b["arguments"] or "{}"} for _, b in sorted(blocks.items()) if b["type"] == "tool_use"]


def ask(history: list, parent: str, outputs: dict[str, str]) -> Round:
    """One physical request, repeated after a 429 or 5xx answer; every attempt is a branch wait on its own call."""
    path, body, headers = request_for(history)
    if SCRIPT.get("reject_first") and not REJECTED:
        REJECTED.append(1)  # the gateway refuses a fallback route before it dispatches, so this request never reaches upstream
        try:
            post(BASE + path, {**body, "route": "fallback"}, {**headers, "X-Rush-Span-Id": parent}).read()
        except urllib.error.HTTPError as error:
            error.read()
    for attempt in range(SCRIPT.get("retries", 0) + 1):
        current = Round()
        wait = new_span("wait")
        try:
            response = post(BASE + path, body, {**headers, "X-Rush-Span-Id": parent})
        except urllib.error.HTTPError as error:
            current.call_id = error.headers["X-Rush-Call-Id"]
            error.read()
            EVENTS.start(wait, "operation", "failed request", parent, {"waits_on_call": current.call_id})
            EVENTS.end(wait, "error")
            if error.code not in (429, 500, 502, 503) or attempt == SCRIPT.get("retries", 0):
                raise
            pause = new_span("backoff")
            EVENTS.start(pause, "operation", "retry backoff", parent)
            time.sleep(SCRIPT["backoff_s"])
            EVENTS.end(pause)
            continue
        current.call_id = response.headers["X-Rush-Call-Id"]
        EVENTS.start(wait, "operation", "await model", parent, {"waits_on_call": current.call_id})
        with response:
            read_round(response, current, parent, outputs)
        EVENTS.end(wait)
        return current
    raise AssertionError("unreachable")


def conversation_after(history: list, current: Round, outputs: dict[str, str]) -> None:
    if DIALECT == "chat_completions":
        message = {"role": "assistant", "content": current.text or None}
        if current.proposals:
            message["tool_calls"] = [{"id": p["id"], "type": "function", "function": {"name": p["name"], "arguments": p["arguments"]}} for p in current.proposals]
        history.append(message)
        history.extend({"role": "tool", "tool_call_id": p["id"], "content": outputs[p["id"]]} for p in current.proposals)
    elif DIALECT == "responses":
        for p in current.proposals:
            history.append({"type": "function_call", "call_id": p["id"], "name": p["name"], "arguments": p["arguments"]})
            history.append({"type": "function_call_output", "call_id": p["id"], "output": outputs[p["id"]]})
    else:
        history.append({"role": "assistant", "content": [{"type": "tool_use", "id": p["id"], "name": p["name"], "input": json.loads(p["arguments"])} for p in current.proposals]})
        history.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": p["id"], "content": outputs[p["id"]]} for p in current.proposals]})


def write_result(result: dict) -> None:
    target = os.environ["RUSH_RESULT"]
    with open(target + ".tmp", "w", encoding="utf-8") as out:
        json.dump(result, out)
    os.rename(target + ".tmp", target)


def local_branch(seconds: float) -> threading.Thread:
    span = "branch-1"

    def work() -> None:
        EVENTS.start(span, "subagent", "local work", "root", {"parent_blocked": False})
        busy(seconds)
        EVENTS.end(span)

    thread = threading.Thread(target=work)
    thread.start()
    return thread


def main() -> None:
    EVENTS.start("root", "agent", "loop")
    if SCRIPT.get("busy_s"):
        busy(SCRIPT["busy_s"])
    branch = local_branch(SCRIPT["local_branch_s"]) if SCRIPT.get("local_branch_s") else None
    prompt = REQUEST["prompt"]["user"]
    # The gateway's first-prompt rule: the pinned system text (task_tools agent) and user text, byte for byte.
    history: list = (
        [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]
        if DIALECT in ("chat_completions", "responses")
        else [{"role": "user", "content": prompt}]
    )
    answer = None
    reason = "The agent submitted no answer."
    for _ in range(REQUEST["limits"]["max_model_calls"]):
        outputs: dict[str, str] = {}
        current = ask(history, "root", outputs)
        if not current.proposals:
            reason = current.text or reason
            break
        threads: list[threading.Thread] = list(current.early.values())
        for p in current.proposals:
            if p["name"] == "submit":
                answer = json.loads(p["arguments"])
                outputs[p["id"]] = "Submitted."
            elif p["id"] not in current.early:
                threads.append(threading.Thread(target=lambda p=p: outputs.__setitem__(p["id"], run_tool(p["name"], json.loads(p["arguments"]), current.call_id, p["id"], "root"))))
                threads[-1].start()
        for thread in threads:
            thread.join()
        if answer is not None:
            break
        conversation_after(history, current, outputs)
    if branch is not None:
        branch.join()
    if not SCRIPT.get("hold_root"):
        EVENTS.end("root")
    if answer is not None:
        write_result({"protocol": "rush.harness.v1", "status": "answered", "answer": answer})
    else:
        write_result({"protocol": "rush.harness.v1", "status": "refused", "reason": reason})


main()
