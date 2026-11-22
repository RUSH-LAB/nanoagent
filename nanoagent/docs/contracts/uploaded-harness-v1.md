# RUSH uploaded harness contract v1

The [schema](../../src/nanoagent/uploaded/uploaded-harness-v1.schema.json) defines the wire shapes. Validate YAML-parsed `harness.yaml` against `Manifest`, the worker's input against `Request`, the submission against `Result`, each harness event against `HarnessEvent`, tool traffic against `ToolCall` and `ToolResult`, and managed commands against `ExecCall` and `ExecResult`. Use JSON Schema 2020-12 with format checks enabled. The worker also enforces the lifecycle, path, prompt, and capability rules below.

## Package, build, and entry point

Upload one source ZIP with `harness.yaml` at its root. The worker parses the manifest as a UTF-8 YAML mapping with string keys, JSON-compatible values, and unique keys. Archive paths are canonical relative paths with `/` separators. Reject duplicate or colliding paths, traversal, links, special files, and prebuilt executables, libraries or bytecode. Validate size limits before unpacking and during extraction. The source digest identifies the immutable upload.

The same manifest works for interpreted and compiled languages. An interpreted build can stage source and dependencies in `/build-out`. Each language's published toolchain ID resolves to pinned build and runtime images and a dependency policy. Dependencies come from the declared, verified lockfiles. Use `lockfiles: []` for a project with no external dependencies. Each build runs in a disposable guest with a read-only dependency input and a clean `/build-out`. The supervisor accepts only the declared relative paths under `/build-out` and makes them available read-only under `/harness`.

The manifest declares the harness's identity and the model API dialects it calls, besides how it is built and run. All three are required:

| Field | Rule |
| --- | --- |
| `name` | Lowercase slug: `^[a-z0-9][a-z0-9._-]*$`, 1 to 64 characters. With the uploading member it names the harness (`owner/name`), so two members may both have `foo`. The names of the reference harnesses (`claude-code`, `codex`, `dsh`, `hermes`, `nanoagent`, `pi`) are reserved: a member's own upload with one is refused (`400 reserved_harness_name`). |
| `version` | A non-empty token: `^[A-Za-z0-9][A-Za-z0-9._+-]*$`, 1 to 64 characters. Semantic versioning is not required. The first upload of `owner/name@version` pins its source sha256; a different ZIP under the same version is refused by the server (`409 harness_version_taken`). A reference harness's version is derived from its content (a short sha256 of its folder's files), so the same reference always has the same version and a changed one a new version. |
| `dialects` | A non-empty list without repeats of `chat_completions`, `responses`, `anthropic_messages`: the dialects the harness calls. A run enables exactly these; the gateway refuses a call in another (`404 dialect_not_enabled`). They are not chosen at run time. |

```yaml
protocol: rush.harness.v1
name: my-harness
version: "1"
dialects: [chat_completions]
toolchain: go-1
lockfiles: [go.mod, go.sum]
build:
  argv: [go, build, -mod=vendor, -o, /build-out/harness, ./cmd/harness]
  outputs: [harness]
run:
  argv: [/harness/harness]
```

Execute `argv` directly from the corresponding isolated guest. The build starts at the source project root and the runtime starts at `/rush/workspace`. The supervisor appends no arguments. `run.argv` may name a language interpreter, flags and staged source. The guest receives platform-owned environment values and the following per-attempt inputs.

| Variable | Value or purpose |
| --- | --- |
| `RUSH_REQUEST` | `/rush/request.json`, the read-only case request. |
| `RUSH_RESULT` | `/rush/out/result.json`, where a harness that submits through the plugin's tools leaves its result (`nanoagent`'s `submit`). Every other harness ignores it: the outcome is read from the frozen workspace after the harness exits. |
| `RUSH_WORKSPACE` | `/rush/workspace`, the case's writable workspace. |
| `RUSH_ATTEMPT_TOKEN` | Short-lived credential scoped to the attempt's gateways. Send it as a bearer token or in `x-api-key` for an Anthropic client. The gateway strips it before forwarding. |
| `RUSH_TERMINAL` | The terminal this process runs on: `0` for the harness's own; `1`, `2`, ... for each further terminal of a free-form session. |

The process decodes one UTF-8 JSON object from `RUSH_REQUEST`. Reject duplicate keys and non-finite numbers at every wire boundary. The request is closed (no other fields):

```json
{
  "protocol": "rush.harness.v1",
  "attempt_id": "<uuid>",
  "task": {"id": "...", "kind": "agent | decide | tool", "description": "...", "plugin_name": "..."},
  "free_form": false,
  "case": {"case_id": "..."},
  "prompt": {"system": "<the answer format>", "user": "<the case's prompt>", "sha256": "<prompt_sha256>"},
  "harness": "claude | codex | pi | dsh | hermes | nanoagent | rush <command>",
  "workspace": "/rush/workspace",
  "openrouter": {"base_url": "http://<host>/api/v1", "model": "...", "dialects": ["chat_completions"]},
  "tools": {"url": "http://<host>/tools", "available": [{"name": "...", "description": "...", "input_schema": {}, "output_schema": {}}]},
  "exec_url": "http://<host>/exec",
  "events_url": "http://<host>/events",
  "limits": {"wall_time_ms": 600000, "max_model_calls": 50, "internet_access": true, "...": "every limit of the run"},
  "interactive": false
}
```

`task` and `case` are the public task and case: the case's `arguments`, its `input_schema` and `output_schema`, `kind` and the private reference stay on the worker and never enter the VM, so every harness works from the prompt's text alone. `harness` is the agent the case runs (`null` in a free-form session): a CLI named in the shell harness's `harnesses.yaml` or a member's own `rush <command>`. `prompt.user` is the case's own prompt, byte for byte, as the benchmark published it, `sha256` its digest (`prompt_sha256`). `prompt.system` is the answer format, one fixed text for every case followed by the task's `output_schema`: where to write `answer.json` (the answer object itself, or `{"refused": "<why>"}`). The gateway adds it to the system prompt of every model request of the case session, after the agent's own system prompt (Chat Completions: a system message; Responses: `instructions`; Anthropic Messages: `system`), so an agent need not send it; it is recorded as forwarded. `free_form` is `true` only for the Terminal (`shell`) of a session someone is at, who runs any agent there and prompts it themselves: the session is the same empty shell whichever plugin's page opened it and has no task, case set or case, so `task`, `case` and `prompt` are `null`, nothing is written into the workspace for a task, and when they leave the shell the attempt ends `ended`, unscored, with its model calls, commands and workspace snapshot recorded as any attempt's. `limits` are the run's effective limits (all of them, with the defaults in the API's [`GET /defaults`](rush-benchmark-api.md#get-defaults)), as the worker applies them. The guest can read its task workspace (the case's fixtures, seeded before the session starts) and receives no private verifier inputs.

The harness runs on a terminal (a PTY, `TERM=xterm-256color`): what it writes there, its stdout and stderr together, is shown live to the member (`GET /attempts/{id}/terminal`). `interactive` is `true` when a member is at that terminal (a plugin page's Harness tab session): what they type reaches the harness's stdin, the terminal takes their window's size, and they end the session themselves, so a harness runs its CLI interactively. When it is `false` nobody types (stdin stays open with nothing on it), and the harness works the case to its end on its own. In a free-form session the member opens more terminals (at most 32 in all, ids 0 to 31) in the same VM and workspace: each runs `run.argv` again on a PTY of its own, with the same environment but `RUSH_TERMINAL`, its id, and is traced as the harness is, so its commands are recorded with the attempt's. Closing a terminal kills every process whose environment has its `RUSH_TERMINAL`. The session ends when its last terminal does, the harness's or another; the wall time bounds them all.

### Results

There are no participant policies: a harness is an agent CLI run in the shell (`claude`, `codex`, `pi`, `dsh`, `hermes`, `nanoagent`, or a member's own as `rush <command>`), and it works with its own tools. `nanoagent` alone is given the plugin's task tools (`tools.available` lists them, served by the broker at `tools.url`); for every other harness `tools.available` is empty and no tool container exists. The first message the agent gets is the case's prompt; the shell exports it as `RUSH_PROMPT` and runs the harness's headless command from `harnesses.yaml` with it as the last argument (`<headless command> "$RUSH_PROMPT"`), with no bash around it, and exits with its status. A member's `rush <command>` runs through `rush` with the prompt appended.

After the harness exits, the supervisor revokes service admission and stops the harness, descendants, managed commands and plugin tools, the worker freezes the workspace and the outcome seam (`nanoagent.uploaded.outcome`) reads the result from the frozen copy: a regular file, not a link, UTF-8 JSON object, for now `answer.json` (the task's output as a JSON object, or `{"refused": "<reason>"}`, that key alone, a nonblank string), as `nanoagent.uploaded.answer.read_answer` reads it. An absent file is `missing_result`; an unreadable, non-object or malformed one (or a blank refusal reason) is `invalid_result`. The answer is not checked against the output schema by the reader: an answer of the wrong shape is a failed case (`invalid_answer`).

Only a harness that exited `0` within its limits reaches the outcome seam and the verifier; a timeout, signal, nonzero exit or workspace over its bound is `execution_failed` with the reason `timed_out`, `signaled`, `nonzero_exit` or `invalid_result`, and the verifier is not called. The verdict keeps the verifier's check names and statuses (`checks: [{name, status}]`, status `passed`, `failed` or `skipped`; never their messages or values), which only the run's member reads.

Outcomes stay distinguishable: execution error (`nonzero_exit`, `signaled`, `timed_out`, `invalid_result`, `missing_result`; or a budget, such as the model-call limit, the harness hit), refused, answered (then a verifier pass or fail), verifier error, and score unavailable.

### Limits, capabilities and the network

The claim carries the run's effective `limits`, and the worker applies each to the attempt: `wall_time_ms` (the harness's wall clock), `max_model_calls` and `max_output_tokens_per_call` (the gateway), `max_cost_usd` (admission reserves each call's bounded spend against it), `cpus`, `memory_mb`, `pids`, `workspace_bytes`, `workspace_files` and `tmp_bytes` (the sandboxes; `workspace_bytes` and `workspace_files` also bound the workspace snapshot the verifier reads), `build_wall_ms`, `build_memory_mb`, `build_output_bytes`, `build_files` and `build_tmp_bytes` (the build, below) and `internet_access`. Every limit is recorded in `attempt.started`. No limit applies to an attempt that the run's `limits` do not show.

The build has limits of its own because its output volume and its `/tmp` are tmpfs charged to the build's memory: `build_memory_mb` is the build container's memory (both volumes and the build's processes share it), `build_output_bytes` the size of the output volume and of what is copied out of it, `build_files` the file count of that output, `build_tmp_bytes` the size of the build's `/tmp` (the run's `tmp_bytes` is the harness's own and does not apply to the build). The defaults (3 GiB, 1 GiB, 100,000 files, 512 MiB, in that order) fit every reference harness and the toolchain fixtures; the largest output, `dsh`, is 591 MiB in 44,506 files, and the largest `/tmp` use, the `go-1` toolchain compiling the standard library into its build cache, is about 400 MiB. At the defaults the two volumes take at most 1.5 GiB of the build's 3 GiB, which leaves 1.5 GiB for its processes. `cpus`, `pids` and the wall clock (`build_wall_ms`) are the build's too. These are platform invariants, not limits: the 4 MiB `/rush/out` volume and the 1 MiB `result.json` that carry the harness's result, the 1 MiB of stdout and stderr captured from each container (the rest is dropped, not an error), the 64 MiB and 64-process budget of the infrastructure containers that hold the volumes, and the drain and plugin-sync timeouts of the worker; none of them scales with a harness's work. With each claim the worker advertises `capabilities`: its maximum for each numeric limit and whether it supports `internet_access`; it refuses an attempt whose limits exceed them.

The harness VM's network policy reaches the attempt's gateway, tool broker and command service (one relay address on the worker) and denies everything else. With `internet_access: false` nothing else is reachable. With `internet_access: true` it also reaches public addresses, resolving names through its sandbox's resolver. Blocked, as unreachable from the harness: private ranges (10/8, 172.16/12, 192.168/16, fc00::/7), CGNAT 100.64/10, loopback, link-local (cloud metadata included), multicast, and every other port of the worker host. The fence is the VM's own network policy; a worker with `egress.enabled` proves it at startup (a probe VM must not reach a listener on the host) and refuses to start otherwise. The build is network-less. The tool VM (only `nanoagent` is given one) has no network of its own either; its only way out is an egress proxy, as for a plugin run locally (`nanoagent.plugin.egress`): `CONNECT host:443` to the hosts the plugin declares (`manifest.permissions.network_hosts`, published as `task.egress_hosts`, sorted), where every resolved address must be public; any other host, port, plain HTTP or private address is refused with 403. The plugin's processes get `HTTPS_PROXY` and `HTTP_PROXY` for it. An empty host list means no network at all. The hosts are pinned in `attempt.started` (`egress_hosts`). Every other harness has no tool VM. Model calls must go through the gateway; a bypass cannot be detected, so runs with internet access are shown as unverified egress in comparisons.

### Published toolchains and lockfiles

Images are pinned by multi-architecture digest in `nanoagent.uploaded.toolchains`. The worker stages the verified closure from the registry its YAML names for the toolchain (`dependencies.index_urls`), then mounts it read-only at `/deps` in the network-less build. A dependency missing from the registry fails the build with `dependency_unavailable`; bytes that differ from the lock fail it with `hash_mismatch`; an unhashed or unsupported entry fails with `unhashed_requirement` or `unsupported_lockfile_directive`. An unknown toolchain ID is rejected as `unknown_toolchain` before any container starts.

| Toolchain | Build image | Runtime image | `lockfiles` | Resolver and offline policy |
| --- | --- | --- | --- | --- |
| `python-3` | `python:3.12-slim` | same | `requirements.txt` with `--hash` pins, or `uv.lock` | Hashed wheels from a PEP 503 index; `pip install --no-index --find-links /deps`. |
| `cpp-20` | `gcc:14-bookworm` | `debian:bookworm-slim` | `[]` | No dependencies; link statically. |
| `rust-1` | `rust:1.90-slim-bookworm` | `debian:bookworm-slim` | `[Cargo.lock]` | Crates from `static.crates.io` paths, each checked against the lock `checksum`, unpacked as a vendor directory; build with `--frozen --offline --config /deps/cargo-config.toml`. |
| `go-1` | `golang:1.24-bookworm` | `debian:bookworm-slim` | `[go.mod, go.sum]` | Module `.mod` and `.zip` files by GOPROXY path, checked against the go.sum `h1:` hashes, served as a file GOPROXY (`file:///deps/proxy`, `GOSUMDB=off`, `-mod=readonly`); the go command verifies go.sum again. |
| `typescript-5`, `javascript-22` | `node:22-bookworm-slim` | same | `[package-lock.json]` | Lockfile v2 or v3 `resolved` paths, checked against `integrity` (sha256, sha384 or sha512), unpacked at `/deps/node_modules` as npm lays them out. npm itself is not run and no install script runs. |
| `java-21` | `eclipse-temurin:21-jdk-jammy` | `eclipse-temurin:21-jre-jammy` | `[maven.lock]` | Jars from Maven repository paths, checked against `maven.lock`, staged at `/deps/lib`; `javac -cp '/deps/lib/*'`. |

`maven.lock` has one jar per line, `group:artifact:version sha256:<64 hex digits>`, with `#` comments. It lists the complete classpath: POMs are not followed, so an unlisted transitive jar is missing from the classpath. In a Java build, copy the jars into `/build-out/lib` and run with `-cp '/harness/classes:/harness/lib/*'`. A Rust build must keep its target directory under `/build-out` (build scripts cannot execute from `/tmp`) and remove it before the build ends.

## Benchmark scoring

The whole harness is the unit under test. The selected plugin package supplies the deterministic scoring code: the plugin's ordinary `verify_task`, run in the existing deterministic verifier validation and isolated process runner (determinism check, read-only workspace), against the case's pinned private reference. The plugin's task verifier is the only scoring mode. Both policies use the same verifier and verdict rules, which match the plugin benchmark's local `judge`.

A case is an answer case (its pinned reference is an output object, or null when the verifier judges the task without one) or a refusal case (its pinned reference is the error string the task's reference tool gave). Per case the worker records `pass` or `fail`; the run's score is passed cases over scored cases.

| Outcome | Case type | Verdict, explanation code |
| --- | --- | --- |
| `answered` | answer case | The answer is built into the task's output class and passed to `verify_task` with the pinned reference (None when there is none). Valid: `pass`. Invalid: `fail`, no code. An answer that does not build: `fail`, `invalid_answer`. |
| `answered` | refusal case | `fail`, `answered_refusal_case`. |
| `refused` | refusal case | `pass`. The reason text is not judged. |
| `refused` | answer case | `fail`, `refused_answer_case`. |
| `execution_failed` | either | `fail`, `execution_failed`. |

A verifier exception, timeout or nondeterminism (including a plugin whose `verify_task` needs a reference the case does not pin), or a pinned reference that is neither a mapping, a string nor null, is a verifier error: the case stays unscored and the run's score unavailable. The explanation codes are exactly `execution_failed`, `refused_answer_case`, `answered_refusal_case` and `invalid_answer` (`nanoagent.plugin.verifier.TASK_VERIFIER_EXPLANATIONS`). Keep execution status and evidence coverage independent of verdicts. Private inputs and verifier diagnostics stay private.

## Prompt contract

A published benchmark is immutable and pins the model, endpoint, limits and every case's prompt, so a run chooses only the harness (and the cases). What a run pins is in the API's [`POST /runs`](rush-benchmark-api.md#post-runs).

A case's prompt is the text its author published, the same for every harness; it is kept byte for byte and its `prompt_sha256` is the SHA-256 of its UTF-8 bytes. There is no template, renderer or per-policy rendering. The worker exports it as `RUSH_PROMPT` and the agent's first terminal runs the agent with it.

A request delivers the case prompt when it carries it byte-exact as a user message:

| Dialect | `user` |
| --- | --- |
| `chat_completions` | a `user` message whose content is the string, or that has a standalone text part equal to it |
| `anthropic_messages` | the same, in `messages` |
| `responses` | the whole string `input`, or a user message item whose content is the string or a single `input_text` part |

The gateway adds `prompt.system` to every request itself (see above), so the harness sends none of it.

Agent CLIs make side requests of their own (a title, a background-model call) that do not carry the prompt, so the gateway does not require the prompt of every request. Until the prompt is delivered:

- a request with no user message equal to the prompt is forwarded and does not count as delivering it;
- a request that does not carry the prompt byte-exact but whose first user message has a text part containing it (with a prefix, suffix or wrapper around it) or differing from it only by surrounding whitespace is a rewritten case prompt and is rejected with `first_prompt_rewritten`.

Once a request has delivered the prompt, the check ends. The `model_call.admitted` record carries `prompt_delivered`, true on the one call that delivered it; the trace shows it per model call, and an attempt whose harness never delivered it carries the issue `prompt_not_delivered` ("prompt not delivered"). Text that quotes only part of the prompt inside another message is not detected as a rewrite.

The harness can add its own messages, select approved tools and manage subsequent context. A harness may submit a result with zero model calls.

## OpenRouter boundary

All inference goes through the attempt-scoped RUSH gateway to OpenRouter. The guest cannot reach upstream directly. Route each API dialect to its matching endpoint with its native request and response format.

The harness configures its client from `request.openrouter.base_url`, `model` and `dialects`, and uses `RUSH_ATTEMPT_TOKEN` as its gateway credential. `base_url` includes the `/api/v1` suffix and selects the gateway, which forwards using a server-side credential. The worker's YAML sets `openrouter.label`, `openrouter.mode`, `openrouter.upstream_base_url` and, for `mock`, `openrouter.mock_hosts`; the key is always the worker's `OPENROUTER_API_KEY` environment variable. The `openrouter` mode uses the approved OpenRouter HTTPS origin. The `mock` mode is for Dev acceptance and uses a configured test service with a synthetic credential. An absent or invalid configuration fails clearly. The [design document provides both YAML examples](../plans/uploaded-harness-benchmarks.md#openrouter-endpoint-configuration).

| `dialects` value | Route relative to `openrouter.base_url` | Capture |
| --- | --- | --- |
| `chat_completions` | `POST /chat/completions` | Assemble streamed tool arguments by choice and tool index, associate tool IDs with results, and retain final usage chunks even when `choices` is empty. |
| `responses` | `POST /responses` | Preserve output item IDs, function-call deltas, `call_id`, and terminal events including failure. |
| `anthropic_messages` | `POST /messages` | Preserve content-block indices and IDs, tool input JSON deltas, `tool_use`/`tool_result` pairs, and usage across lifecycle events. Keep `msg_…` as a message ID and capture the OpenRouter generation ID separately from headers when present. |

Configure an Anthropic SDK that appends `/v1/messages` with the gateway base URL minus its final `/v1` segment. Route the resulting request to `/api/v1/messages`.

The gateway pins model, provider routing, output budget, and maximum calls. Disable model and provider fallbacks. Reject attempts to add routing alternatives (a caller `provider` is `provider_routing_forbidden`, except exactly `{"require_parameters": true}` on a request that carries `response_format`, which equals what the gateway sets; the gateway sets `provider.require_parameters: true` itself on every request that carries `response_format`), OpenRouter plugins, remote server tools, or provider-side conversation state. Enable OpenRouter metadata for observed routing. SDK discovery or count endpoints require an explicit allowlist entry and contract test. An unsupported path or parameter produces a specific error. Keep the sanitized submitted request and the effective upstream request when the gateway adds policy parameters.

Admission requires the current fenced lease, the attempt token and available attempt, member and workspace budget. Before dispatch, record a unique physical call admission and reserve its bounded spend in the same transaction. A request that may have reached upstream keeps its reservation until its accounting is known or the reconciliation deadline settles it at the reserved bound. A lease change or cancellation rejects new calls, aborts local streams and preserves the accounting record for calls already dispatched. OpenRouter acceptance may be uncertain after a disconnect or crash. Automatic recovery never reissues an uncertain call. A separate admitted retry gets its own call ID and accounting record.

Record every HTTP attempt, including failure before a response, non-streaming errors, and interrupted streams. Preserve structured request/response content and replayable redacted streamed frames, HTTP status, first-byte and completion timing, and allowed response headers. Coalesce fragments by the dialect's IDs and offsets for display while preserving the original frame order. Track tool proposals, tool invocation, and matching results as separate observations. OpenRouter sees the model's tool proposal and any result sent back to the model. The RUSH tool broker and the runtime collector provide evidence of actual execution.

Record broker call ID, optional harness operation/span ID, upstream message or response ID, generation ID, requested and resolved model/provider, token classes, and per-request cost and its provenance. Missing counts or cost stay unknown. If a `gen-…` is available, reconcile in the background via `GET /api/v1/generation?id=…` with bounded retries. Replace provisional fields with available provider accounting without double-counting the physical call. The live probe found generation lookup can lag completion. Historical reads never initiate reconciliation or a generation request. [OpenRouter tool calls](https://openrouter.ai/docs/guides/features/tool-calling) · [Streaming](https://openrouter.ai/docs/api_reference/streaming) · [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) · [Generation lookup](https://openrouter.ai/docs/api/api-reference/generations/get-generation)

### Token accounting

Produce one normalized usage record per physical generation request. Use provider-reported native token counts. Store input inclusive of cache reads and writes, output inclusive of reasoning, and total tokens as input plus output. Report cache-read and cache-write tokens separately as parts of input. Compare the normalized total with any supplied total and retain discrepancies with provenance. Cache reads, writes and reasoning are never added a second time.

| Dialect | Input and output normalization |
| --- | --- |
| Chat Completions | Use `prompt_tokens` and `completion_tokens`. Read cache reads from `prompt_tokens_details.cached_tokens` and cache writes from `prompt_tokens_details.cache_write_tokens`. |
| Responses | Use `input_tokens` and `output_tokens`. Read cache reads and writes from the corresponding fields in `input_tokens_details`. |
| Anthropic Messages | Add the uncached `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` to get inclusive input. Use `output_tokens` for output. Merge cumulative usage fields across lifecycle events by taking the latest authoritative value for each field. |

OpenRouter's [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) and the [Anthropic Messages usage contract](https://platform.claude.com/docs/en/api/typescript/messages) define the source fields. Reconcile using confirmed accounting with equivalent token semantics, retaining the earlier values and source identifiers. Keep unreported values unknown unless the pinned dialect rules establish zero. Record zero for a call proven never to have reached upstream and for a complete attempt with zero dispatched calls. For each partial aggregate, expose the known subtotal and the number of calls missing that field. Persist accounting independently of the sealed trace. Use the plan's [timing definitions](../plans/uploaded-harness-benchmarks.md#primary-metrics-and-timing-analysis) for elapsed time, measured local work and the latency-adjusted estimate derived from reported token counts at a pinned reference rate.

## Tool and trace interfaces

Send `POST` to `tools.url` with JSON containing `name` and `arguments` for an approved plugin tool. For a model-requested call, include `cause` with `model_call_id` from the gateway response and `tool_call_id` from the model response. Verify the pair and tool name in the same attempt. Compare canonical typed arguments with the complete model proposal. Record changed arguments as an adaptation with the original proposal and actual call preserved. Reject unknown proposals and mismatched tool names. The broker validates the input and tool output schemas and returns `{ "output": { … } }` or an HTTP error with `{ "error": { "code": "…", "message": "…" } }`. The same gateway credential authorizes this operation. For every harness but `nanoagent` `tools.available` is empty. A broker call without `cause` is a harness-initiated call (a decide task's tool calls, built from the decider's answers): it counts toward a complete trace, and the span in `X-Rush-Span-Id` links it to the decision that produced it.

Run the tool broker's plugin processes in a separate per-attempt sandbox. The task names the callable tools. Give tools only the permitted case workspace. The tool container has no network but the egress proxy of the plugin's declared hosts, and no ambient host, member or deployment credentials. Keep private references, verifier files, the request and the result directory out of this mount. Reference tools run privately and are absent from the guest allowlist. Give a writing tool exclusive workspace access among brokered calls. Read-only brokered calls can run concurrently. The harness shares that bounded workspace and can coordinate its own reads and writes with returned tool calls. Revoke admission and terminate in-flight tool work on teardown before freezing it.

Send `POST` to `exec_url` with `argv`, `cwd` and `timeout_ms` as an `ExecCall`, using the same attempt token. The supervisor executes the vector directly inside the harness sandbox with its case identity and resource limits. `cwd` is a canonical path relative to `RUSH_WORKSPACE`, with `.` for the root. Reject paths that escape through a link and arguments containing NUL. A command is bounded by its timeout and the case deadline. Return an `ExecResult` with termination and stdout/stderr as bounded base64 byte streams with explicit truncation flags. Admission and launch errors use the tool error envelope. Return the observed command ID in `X-Rush-Call-Id`. Link it to process evidence through supervisor launch identity. Direct subprocesses remain available and have protected exec and exit evidence. Stream capture for them depends on instrumented execution.

Send one `HarnessEvent` per `POST` to `events_url`. The gateway attaches attempt identity, receipt time and the `harness` origin. A harness identifies its emitters and assigns consecutive sequences starting at 1 per emitter. Optional `elapsed_us` is measured on the emitter's monotonic clock relative to its first event. Use it for durations within that emitter and use recorded IDs for causality across sources. Each span has one start and at most one end. An attempt has one root `agent` span. Internal subagent, decision, in-process tool and memory spans descend from it. Topology and start/end pairing are validated separately from JSON shape. Optional span `data` fields carry wait and reference instrumentation. A span whose start has `data.waits_on_call` set to a gateway `X-Rush-Call-Id` records a branch blocked on that call, and its end may set `data.unblocked_by_frame` to the response frame index that released it. A `subagent` span with `data.parent_blocked: true` holds its parent in a join for its whole duration. `data.call_id` and `data.refs` name observed calls the span refers to; RUSH validates them and keeps them as harness-reported. Measured time outside OpenRouter waits and the latency-adjusted estimate stay **Unknown** unless the attempt has a closed root `agent` span, no rejected events or sequence gaps, and only valid references. Use `X-Rush-Span-Id` on model, plugin tool and managed command calls to associate observed activity with a harness span. Respond with `X-Rush-Call-Id` for precise links. A successful event write returns a receipt, and re-sending the same event with the same sequence and content returns the same receipt. Conflicting duplicates fail.

Every case has an authoritative timeline from the supervisor, gateway, permitted plugin tool broker and process collector. The trace covers the harness phase only: the build and the verifier are not phases, spans, events, sources or timings in it. A failed build is reported on the attempt as execution status `build_failed` with its reason code (for example `build_timeout`), and the deterministic verifier's result is stored on the attempt (verdict, explanation code or verifier error), neither shown as trace evidence. Harness-emitted events provide semantic context with a distinct origin. The trace lists expected sources, observed coverage, and loss and truncation information. Missing required evidence or semantic spans marks the trace partial. Only a complete trace for the pinned policy qualifies for verified comparisons. Protected exec and exit observations, including diagnostics when collection fails, are a release gate for the selected sandbox backend.

## Durable replay

Persist one immutable run manifest and one trace per case attempt in workspace-scoped PostgreSQL. Use the run, case, and attempt IDs for historical navigation. Store summary and span index rows, canonical events with a per-attempt replay cursor, and large redacted payloads and artifacts in bounded blob storage. Retain the exact case prompt and scoring inputs under their run permissions. Seal the trace with redacted requests and responses, timing evidence, known usage, tool results, process evidence, case verdict and score, and coverage. The app reads trace data after case completion even if the plugin is uninstalled or its current prompt changes. A worker may append separately versioned accounting enrichment after a trace is sealed. It cannot rewrite or reorder the recorded events.

Serialize cursor allocation with event commits per attempt. Replaying from a cursor returns every later committed event once to a deduplicating client. Finalization stores a high-water mark and seals the event stream in one transaction. The append path rejects conflicting event duplicates and writes from fenced workers. A live subscriber can reconnect via the last cursor. Apply workspace membership and attempt visibility checks to payloads, downloads, search and deep links. Reopening a trace after the app, worker, or database restarts is a read of stored data. **Run again** creates a new attempt that can make its own model calls.

## Platforms and release gate

The worker is a NanoAgent process on the member's computer whose sandboxes are microVMs (see the design document's [local worker](../plans/uploaded-harness-benchmarks.md#local-worker)). RUSH Lab Dev builds for macOS and Windows; Linux desktops are not supported. A change is released after the mock-driven CLI acceptance suite passes and a real benchmark verifies it end to end through the entry point that changed. The [design document](../plans/uploaded-harness-benchmarks.md#end-to-end-acceptance) defines the gates and the failure-fixing cycle.
