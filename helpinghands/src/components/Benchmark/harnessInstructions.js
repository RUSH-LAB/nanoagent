export const HARNESS_EXAMPLE = `protocol: rush.harness.v1
name: my-harness
version: "1"
dialects: [chat_completions]
toolchain: python-3
lockfiles: []
build:
  argv: [cp, run.py, /build-out/run.py]
  outputs: [run.py]
run:
  argv: [python, /harness/run.py]`;

const HARNESS_INSTRUCTIONS = `Help me package the program I want to test as a RUSH Lab Benchmark harness. Ask which plugin task and program I want to test, its language and dependencies, which mode it supports, and which model API it uses if any. Ask for the task's rules and input/output schemas if needed. Deliver a source ZIP and the settings to run it.

CHOOSE A MODE
- Coding (coding) suits coding agents and standalone solvers. By default, RUSH renders a user prompt with the task description, shared context, inputs, schemas and instructions for writing answer.json. The harness uses its own tools and workspace. Plugin tools are unavailable. For example, it could run a Python script to compute the sum and save {"sum":42} in answer.json.
- Task tools (task_tools) suits harnesses designed around the plugin's task instructions and approved tools. RUSH renders the task prompt from those instructions. The harness can call tools listed in the request through RUSH's broker and writes a result to RUSH_RESULT. For example, it could call the plugin's add tool and submit its output in an answered result.
Both modes use the same case inputs and the same deterministic verifier. Both can run with zero model calls.

SOURCE ZIP AND BUILD
Put harness.yaml at the ZIP root and include the source and lockfiles at their project-relative paths. Use / separators and omit the enclosing directory, links, prebuilt binaries, bytecode, installed dependencies, credentials and .git. The usual upload limit is 50 MiB. This harness.yaml runs a Python script with no external dependencies.

${HARNESS_EXAMPLE}

The dialects list declares the model API formats the harness supports through the RUSH gateway: chat_completions (OpenAI Chat Completions), responses (OpenAI Responses), and anthropic_messages (Anthropic Messages). Declare at least one, even if the harness makes no model calls; for a model-using harness, list the formats it actually supports.

Each argv is a list of strings executed directly with no extra arguments or shell expansion. Use a build script or an explicit sh -c if you need shell syntax. The build starts in the read-only source root with no network. Write all deliverables to /build-out and list their relative paths (files or directories) under build.outputs. They are then mounted read-only under /harness. The runtime starts in the writable case workspace. Stage everything the entrypoint will need.

Use lockfiles: [] when there are no external dependencies. Otherwise declare verified lockfiles for one of these Linux toolchains. The worker fetches and checks the locked dependencies before the build and makes them available read-only under /deps. Do dependency installation, compilation and bundling during the build.
- python-3 (3.12): requirements.txt with exact versions and --hash pins, or uv.lock. For requirements.txt use python -m pip install --no-index --find-links /deps --require-hashes --target /build-out/site -r requirements.txt, then add /harness/site to the runtime import path. With uv.lock the worker still stages wheels, so install the needed staged wheels offline into the output directory.
- javascript-22 and typescript-5 (Node 22): package-lock.json v2 or v3 with resolved URLs and sha256/384/512 integrity. Use /deps/node_modules and stage the runtime dependencies or bundle the program. Invoke TypeScript's compiler from the staged dependencies. npm install scripts do not run.
- cpp-20: no dependency lockfiles. Compile with g++ in the build and link statically.
- go-1: go.mod and go.sum. Build using the worker's offline file GOPROXY and -mod=readonly.
- rust-1: Cargo.lock with crate checksums. Build with --frozen --offline --config /deps/cargo-config.toml. Set CARGO_TARGET_DIR=/build-out/.target, copy the executable to its declared output path, then remove .target.
- java-21: maven.lock with every jar, including transitive dependencies, one group:artifact:version sha256:<64 hex digits> per line. Compile with javac -cp '/deps/lib/*', stage classes and jars, and use a runtime classpath such as '/harness/classes:/harness/lib/*'.

ONE CASE PER PROCESS
Read a UTF-8 JSON object from the file named by RUSH_REQUEST (/rush/request.json). Reject duplicate keys and non-finite numbers in JSON exchanged with RUSH. Read these fields from the request.
- protocol (rush.harness.v1), attempt_id, and policy (task_tools or coding).
- task contains id, kind (agent, decide or tool), description, instructions and plugin_name.
- case contains case_id, arguments (the input object), context (shared background), input_schema and output_schema (JSON Schema objects). The expected result and whether the case should be answered or refused are private.
- prompt contains system and user (each text or null) and sha256. RUSH has already rendered the prompt for this case.
- workspace is the same path as RUSH_WORKSPACE (/rush/workspace). Keep case files and evidence here. limits gives the time, model-call, token, cost, network, sandbox and build limits pinned for the run.
- openrouter contains base_url, model and dialects. tools contains url and available (entries with name, description, input_schema and output_schema). exec_url and events_url are available for managed commands and trace events.
RUSH_ATTEMPT_TOKEN is an attempt credential for these services. Keep it out of logs, files, and model messages. Runtime internet access depends on the run's limits. All model traffic goes through the supplied gateway.

SUBMIT ONE RESULT AND EXIT 0
In Task tools (task_tools), write one of the following JSON objects. Close a temporary regular file beside RUSH_RESULT (/rush/out/result.json) and atomically rename it to that path. The answer must match case.output_schema.
{"protocol":"rush.harness.v1","status":"answered","answer":{"sum":42}}
{"protocol":"rush.harness.v1","status":"refused","reason":"operands must be nonnegative"}

In Coding (coding), plugin tools are unavailable. Use your own tools and write one UTF-8 JSON object to RUSH_WORKSPACE/answer.json as a regular file.
{"sum":42}
{"refused":"operands must be nonnegative"}

For a task refusal, give a nonblank reason. The expected reference error is checked during publication. At run time a refusal passes only on a refusal case. A crash, timeout, malformed result or missing result is an execution failure. Report unexpected errors and exit nonzero. The plugin's deterministic verifier decides whether an answer is correct.

EXAMPLE run.py FOR THE add-nonnegative TASK
This standard-library example runs in either mode with the manifest above. It reads a and b, answers with their sum, and refuses negative operands. It makes zero model calls, which RUSH supports. Replace the solver with the program you want to test.

import json
import math
import os
import tempfile
from pathlib import Path

def object_from_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result

def invalid_number(value):
    raise ValueError(f"invalid JSON number: {value}")

def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        invalid_number(value)
    return number

request = json.loads(Path(os.environ["RUSH_REQUEST"]).read_text(encoding="utf-8"),
                     object_pairs_hook=object_from_pairs, parse_constant=invalid_number,
                     parse_float=finite_float)
if request["protocol"] != "rush.harness.v1" or request["task"]["id"] != "add-nonnegative":
    raise ValueError("unexpected protocol or task")
a, b = (request["case"]["arguments"][key] for key in ("a", "b"))
if type(a) is not int or type(b) is not int:
    raise ValueError("expected two integer operands")
reason = "operands must be nonnegative" if min(a, b) < 0 else None
answer = {"sum": a + b}
if request["policy"] == "task_tools":
    target = Path(os.environ["RUSH_RESULT"])
    result = {"protocol": "rush.harness.v1"}
    if reason:
        result.update(status="refused", reason=reason)
    else:
        result.update(status="answered", answer=answer)
elif request["policy"] == "coding":
    target = Path(os.environ["RUSH_WORKSPACE"]) / "answer.json"
    result = {"refused": reason} if reason else answer
else:
    raise ValueError("unsupported policy")
with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as output:
    json.dump(result, output, allow_nan=False)
os.replace(output.name, target)

IF YOUR PROGRAM USES A MODEL
Choose a supported dialect from openrouter.dialects. Send JSON with the supplied openrouter.model to openrouter.base_url plus the path below. The base URL already ends in /api/v1. Budget requests using limits.max_output_tokens_per_call and limits.max_model_calls. Use the attempt token in Authorization: Bearer <token>, or x-api-key for Anthropic Messages. Use the exact supplied system/user strings in the first generation request, including its retries until a generation completes. Omit null parts, and keep any extra text in separate messages. Disable model and provider fallback, SDK discovery calls, provider routing overrides, remote tools and provider-side conversation state.

The examples use model "vendor/model", system text "Return JSON.", and user text "Add 19 and 23." Substitute the actual model, prompt and token limit.
- chat_completions → POST /chat/completions
  {"model":"vendor/model","messages":[{"role":"system","content":"Return JSON."},{"role":"user","content":"Add 19 and 23."}],"max_tokens":256}
- responses → POST /responses
  {"model":"vendor/model","instructions":"Return JSON.","input":"Add 19 and 23.","max_output_tokens":256}
- anthropic_messages → POST /messages, with anthropic-version: 2023-06-01
  {"model":"vendor/model","system":"Return JSON.","messages":[{"role":"user","content":"Add 19 and 23."}],"max_tokens":256}
If the Anthropic SDK appends /v1/messages, configure it with base_url minus the final /v1. If the pinned user part is null and your API needs a user turn, supply a separate neutral message such as "Follow the task instructions." Preserve the pinned system text. Parse the API response and submit the task's typed output, rather than saving the whole response as the answer.

IF YOUR PROGRAM USES PLUGIN TOOLS
In Task tools mode, expose only the tools in tools.available to the model. Include their names, descriptions and input schemas (function.parameters in Chat Completions, parameters in Responses and input_schema in Anthropic Messages). To invoke an approved tool, POST to tools.url with the bearer token and a body like this.
{"name":"add","arguments":{"a":19,"b":23},"cause":{"model_call_id":"rush-call-id","tool_call_id":"model-tool-call-id"}}
For a model-requested call, use the response header X-Rush-Call-Id for model_call_id and the original tool call ID from the model's response for tool_call_id (call_id in Responses). Include cause for every model-requested call. Omit it for a harness-initiated call. The broker returns {"output":{"sum":42}} or an HTTP error with {"error":{"code":"...","message":"..."}}. Return the result to the model using the same tool call ID (Chat Completions tool message with tool_call_id, Responses function_call_output with call_id, or Anthropic user tool_result block with tool_use_id). Keep the model's tool call in the conversation history. Treat a broker error as an error rather than inventing a successful result.

COMMANDS AND OPTIONAL TRACE EVENTS
Run local subprocesses in the case workspace or POST to exec_url with the bearer token and e.g. {"argv":["python","check.py"],"cwd":".","timeout_ms":5000}. cwd is relative to RUSH_WORKSPACE. The response has termination (status exited with exit_code, signaled with signal, or timed_out) and stdout/stderr objects with base64 and truncated.
To add semantic trace coverage, POST each event to events_url with the bearer token. Start one root agent span, add X-Rush-Span-Id to related model, tool or command requests, and close the span. Sequence numbers start at 1 and increase by one per emitter. These two events mark the start and end of a successful run.
{"protocol":"rush.harness.v1","event":"span.start","emitter_id":"main","sequence":1,"span_id":"root","kind":"agent","name":"Solve case"}
{"protocol":"rush.harness.v1","event":"span.end","emitter_id":"main","sequence":2,"span_id":"root","status":"ok"}

CHECK AND UPLOAD
From the example source folder run zip harness.zip harness.yaml run.py. Check the archive contains the manifest, source and any lockfiles at their declared paths. To smoke-test locally, point RUSH_REQUEST at a request file, RUSH_WORKSPACE at a temporary directory, and RUSH_RESULT at a new result file in an existing temporary directory. Run python run.py. This is enough request data to exercise the example outside RUSH.
{"protocol":"rush.harness.v1","task":{"id":"add-nonnegative"},"policy":"task_tools","case":{"arguments":{"a":19,"b":23}}}
Check the answer. Repeat with a=-1 for a refusal, with a missing operand for an execution error, and with policy="coding" for answer.json. For a model or tool adapter, use a test HTTP server to verify the prompt, routes, authentication and tool IDs without a live key. In Benchmark → Benchmark Your Harness, choose the plugin and benchmark, select the mode and upload the ZIP; its harness.yaml declares the name, version and dialects. Tell me which ZIP and mode to use.`;

export function harnessInstructions(benchmark) {
  if (!benchmark) return HARNESS_INSTRUCTIONS;
  const {name, plugin, task_id, context, task} = benchmark;
  return `SELECTED BENCHMARK
Use this published task definition when adapting the example. Read the live case, schemas, tools and prompt from RUSH_REQUEST at runtime.
${JSON.stringify({benchmark: name, plugin_id: plugin.id, version: plugin.version, task_id, context, task}, null, 2)}

${HARNESS_INSTRUCTIONS}`;
}
