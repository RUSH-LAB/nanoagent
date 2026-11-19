# RUSH benchmark API

The RUSH server side of [uploaded harness benchmarks](../plans/uploaded-harness-benchmarks.md): a member publishes a **benchmark** for a plugin version, any member runs a harness against it, and everyone sees every run's summary. The [harness contract](uploaded-harness-v1.md) defines the harness protocol, prompt and replay rules this API stores. Code: `helpinghands/src/server/routes/benchmark.js` (member), `routes/benchmark-worker.js` (worker), `benchmark/` (pure rules: `prompt.js`, `limits.js`, `plan.js`, `compare.js`, `rules.js`, `validate.js`, `harness.js`), `postgres/benchmark*.js`, migrations `0052` to `0055` (`benchmark*.sql`).

## Conventions

- JSON requests send `Content-Type: application/json`. Every error is `{"error": "<message>", "code": "<code>", ...extra}` with the status below. A message is for people; branch on `code`.
- IDs (`benchmark_id`, `run_id`, `attempt_id`, `preview_id`) are UUIDs. Digests are lowercase SHA-256 hex.
- Nanosecond times (`occurred_ns`, `start_ns`, `end_ns`) exceed 2^53: **send them as decimal strings** (a safe JSON integer is also accepted). They are returned as strings. Cursors, counts, scores and USD amounts are JSON numbers.
- The server parses JSON numbers as IEEE doubles. It does not detect duplicate object keys in a body.
- Cursors are per attempt, start at 1, and are assigned in commit order. `high_water_cursor` is the last committed cursor, 0 for none.
- Canonical JSON (prompt rendering, digests): keys sorted by Unicode code point at every depth, no non-finite numbers, no unpaired surrogates, Unicode unescaped. Prompts indent by two spaces; digests use the compact form (`{"a":1}`).

## Authentication

| Surface | Credential |
| --- | --- |
| Member API | Better Auth session: the session cookie, or `Authorization: Bearer <session token>`. The path names the workspace (`/api/workspaces/{wid}/benchmark/...`); a non-member gets `404`. Reads need `content:read`, writes `apps:use` (every role has both). |
| Benchmark publishing | The same session, no workspace: `POST /api/benchmark/benchmarks`. Any signed-in member may publish, for any published plugin version. |
| Worker credentials | The member's session, no workspace: `POST /api/benchmark/worker-credentials` with `{"name": "…"}` (1 to 100 characters) mints a credential: `201 {"credential_id", "name", "token", "created_at"}`. The token is random (`rwk_` and 256 bits) and shown only in that response; the server keeps its SHA-256. `GET /api/benchmark/worker-credentials` lists the member's credentials (`credential_id`, `name`, `created_at`, `last_used_at`, `revoked_at`, never the token). `DELETE /api/benchmark/worker-credentials/{credential_id}` revokes one (`200 {"credential_id", "revoked_at"}`, `404 unknown_credential` for another member's or an unknown id); a revoked credential never works again. |
| Worker API | `Authorization: Bearer <worker credential>` on every `/api/benchmark-worker/...` request. A worker runs on its member's computer and acts only for that member: the credential is good for these routes and nothing else. Missing, unknown or revoked: `401 unauthorized`. |

Everything a member creates (sources, previews, runs and all their attempts, events, payloads, accounting) belongs to that member in that workspace. Another member, even of the same workspace, another workspace, or a member who left gets `404` for it: the run, attempt, event, span, payload, accounting, rerun, cancel, compare and source routes are **owner-only** and never answer for another member's rows. No member response carries references; a worker does receive them (see `POST /claim`).

Benchmarks are the exception: they belong to no workspace, and every signed-in member reads every benchmark. Through `GET /benchmarks/{id}/results` a member also sees a **run summary** of every other member's runs of that benchmark. A row from another member carries no evidence (no events, spans, payloads, attempts or cases) and no source sha256, and its `run_id` opens nothing: `GET /runs/{run_id}` and everything below it answer `404` for it.

## Server configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BENCHMARK_MEMBER_BUDGET_USD` | `25` | Most one member may have reserved or spent per UTC day across all attempts. |
| `BENCHMARK_WORKSPACE_BUDGET_USD` | `100` | The same, per workspace. |
| `BENCHMARK_LEASE_SECONDS` | `60` | Lease length at claim and at each renewal. |
| `BENCHMARK_UNCERTAIN_DEADLINE_SECONDS` | `3600` | How long an unsettled or uncertain reservation stays before a claim settles it at its reserved bound. |
| `BENCHMARK_SWEEP_SECONDS` | `15` | How often the server expires leases and settles reservations past their deadline, without waiting for a claim. |
| `BENCHMARK_SOURCE_MAX_BYTES` | `52428800` | Largest source ZIP. |
| `BENCHMARK_PAYLOAD_MAX_BYTES` | `16777216` | Largest payload. |

JSON bodies may be 10 MiB.

---

# Member API

Prefix `/api/workspaces/{wid}/benchmark`.

## `GET /defaults`

What a benchmark publication starts from: the defaults its `limits` overrides sit under, the default coding template, and the endpoints a benchmark may name.

```json
{"limits": {"wall_time_ms": 600000, "max_model_calls": 50, "max_output_tokens_per_call": 4096, "max_cost_usd": 1.5,
            "cpus": 1, "memory_mb": 1024, "pids": 256, "workspace_bytes": 268435456, "workspace_files": 20000, "tmp_bytes": 67108864, "build_wall_ms": 600000,
            "build_memory_mb": 3072, "build_output_bytes": 1073741824, "build_files": 100000, "build_tmp_bytes": 536870912, "internet_access": true},
 "reference_harnesses": ["claude-code", "codex", "dsh", "hermes", "nanoagent", "pi"],
 "coding_template": "<the default coding template>", "placeholders": ["description", "context", "arguments", "input_schema", "output_schema", "workspace"],
 "renderer_version": "rush.prompt.v1",
 "endpoints": [{"label": "mock", "capabilities": {"<every limit>": 0, "internet_access": true, "models": ["vendor/model"]}, "updated_at": "…", "expires_at": "…"}]}
```

`endpoints` are the endpoint labels the caller's own worker has claimed for within the last 300 seconds (the capability window), with its latest capabilities (see `POST /claim`) and when they expire. Another member's worker is never listed. A label the caller's worker has not claimed for within the window is no longer listed and counts as `worker_unavailable`.

## Benchmarks

A **benchmark** is a case set plus a pinned run configuration (model, endpoint, limits including `internet_access`, the coding template and the task-tools instructions). It belongs to one plugin version, is immutable once published, and is named: the name is unique per `(plugin_id, plugin_version, name)`. A harness run takes everything but the policy and the harness from the benchmark. The case set under a benchmark is an implementation detail (`case_set_id` is an opaque string) that the server creates or reuses on publish.

A **benchmark summary**:

```json
{"benchmark_id": "…", "name": "acceptance-probe",
 "plugin": {"id": "classroom", "name": "Classroom", "version": "0.1.0", "sha256": "<package digest>"},
 "task_id": "sum", "task_kind": "agent", "publisher": {"id": "u1", "name": "Una", "github": "una"},
 "case_set_id": "…", "case_set_digest": "…", "digest": "…",
 "model": "vendor/model", "endpoint_profile": "label",
 "limits": {"wall_time_ms": 600000, "…": 0, "internet_access": true},
 "coding_template": "<the pinned template>", "task_instructions": "<the pinned instructions>", "renderer_version": "rush.prompt.v1",
 "published_at": "…", "case_count": 4, "answer_count": 2, "refuse_count": 2, "run_count": 4, "runner_count": 2}
```

`limits` is the effective limits (defaults under the publisher's overrides). `coding_template` and `task_instructions` are the texts that were pinned, a default included. `run_count` counts every member's runs of the benchmark (canceled ones too) and `runner_count` the distinct members who made them. `digest` is the SHA-256 of the compact canonical JSON of `{case_set_digest, model, endpoint_profile, limits, coding_template, task_instructions}`.

### `GET /benchmarks?plugin_id=&version=`

Every published benchmark (any publisher, any workspace), newest first. `plugin_id` filters to one plugin; `version` (only together with `plugin_id`, else `400 invalid_request`) to one plugin version. No filter lists all.

```json
{"benchmarks": [<benchmark summary>]}
```

### `GET /benchmarks/{benchmark_id}`

`{"benchmark": <benchmark summary> + {"task": {kind, description, instructions, input_schema, output_schema, tools, egress_hosts}, "context": "…", "cases": [{"case_id": "c1", "position": 0, "kind": "answer|refuse", "arguments": {}, "expected_error": null, "content_digest": "…"}]}}` or `404 unknown_benchmark`. The task, context and cases are the benchmark's case set for viewing, in the case set's order. References are never returned by this route. Any signed-in member reads it, not only the publisher.

### `GET /benchmarks/{benchmark_id}/results?limit=&before=`

Run summaries of every member's runs of the benchmark, newest first (`limit` 1 to 200, default 50; `before` an ISO timestamp, runs created earlier).

```json
{"runs": [<run summary>]}
```

`404 unknown_benchmark`. See **Run summary** below for the row shape and what other members' rows leave out.

### Run summary

One shape, returned by `GET /runs` (the caller's own runs) and `GET /benchmarks/{benchmark_id}/results` (everyone's):

```json
{"run_id": "…",
 "harness": {"name": "my-harness", "version": "1.3"},
 "benchmark": {"name": "acceptance-probe"},
 "plugin": {"id": "classroom", "name": "Classroom", "version": "0.1.0"},
 "model": "vendor/model", "policy": "coding",
 "user": {"id": "u1", "name": "Jane Doe", "github": "jdoe"},
 "metrics": {"total_tokens": {"total": 48210, "missing_attempts": 0}, "…": {}, "elapsed_ms": {"total": 134000, "missing_attempts": 1}},
 "status": "queued|running|complete|canceled",
 "score": {"value": 0.8, "passed": 8, "scored": 10, "total": 10, "unscored": 0, "verifier_errors": 0, "complete": true, "unavailable_reason": null},
 "created_at": "…"}
```

- `harness` is the identity the uploaded manifest declared; `user` is who ran it (`id`, `name`, and `github` the GitHub login, `null` when the member has none). The harness owner is `user`; group a harness across runs by `user.id` + `harness.name` + `harness.version`.
- `metrics.total_tokens` and `metrics.elapsed_ms` are the **metric sums** of the run detail, computed by the same code: `total` sums the newest attempt of each case that reported the metric and `missing_attempts` counts those that did not (so a live run shows partial totals). `elapsed_ms` is the sum of the attempts' `elapsed_ms`, not wall clock. `status` and `score` are the run detail's.
- A row for another member's run carries no evidence and no source sha256, and no other field than these. `GET /runs` rows for the caller's own runs have exactly the same fields.

## `POST /previews`

Resolves a run without queueing anything. The benchmark fixes everything but the policy.

```json
{"benchmark_id": "…", "policy": "coding"}
```

- `policy` is `coding` or `task_tools`. Under `coding` the prompt is the benchmark's `coding_template`, under `task_tools` its `task_instructions`, rendered per case by the renderer below. No other field is accepted: a model, limits, dialects, selection, prompt or endpoint is `400 invalid_request`. Every case of the benchmark runs.
- Errors: `404 unknown_benchmark`; `400 invalid_request`; `409 worker_unavailable` (the caller's own worker has not claimed for the benchmark's `endpoint_profile` within the capability window; the message tells the member to start RUSH Lab); `400 limit_exceeds_worker` with `exceeded: [{field, limit, max}]` (the benchmark's pinned limits are above what the latest advertised capabilities allow, or `internet_access: true` where unsupported); `400 unknown_model` with `model` and `models` (the caller's worker does not price the benchmark's pinned model: its latest advertised capabilities do not list it); `400 invalid_template` (the pinned template fails to render; publishing already refuses one).

`200`:

```json
{"preview_id": "…", "benchmark": <benchmark summary>, "policy": "coding",
 "prompt": {"source": "benchmark", "text": "<template or instructions>"},
 "limits": {"effective": {}, "capabilities": {}},
 "egress_hosts": null, "endpoint_profile": "label", "model": "vendor/model", "renderer_version": "rush.prompt.v1", "unverified_egress": true,
 "cases": [{"case_id": "c1", "position": 0, "kind": "answer", "content_digest": "…", "prompt": {"system": null, "user": "<exact rendered text>", "sha256": "…"}}]}
```

`limits.effective` is the benchmark's pinned limits. `unverified_egress` is true when `internet_access` is: model calls that bypass the gateway cannot be detected. `egress_hosts` is the tool container's network under `task_tools` (HTTPS to those hosts only, through an egress proxy; the task's `egress_hosts`), and `null` (not applicable: there is no tool container) under `coding`.

### Prompt renderer `rush.prompt.v1`

A case's prompt is `{system, user, sha256}`; either text may be `null`. `sha256` is the SHA-256 of the compact canonical JSON of `{"system": …, "user": …}` (keys sorted, no spaces, Unicode unescaped).

- **`coding`**: `{system: null, user: template.format(...)}` with Python `str.format` semantics for plain fields: `{{` and `}}` are braces; `{description}`, `{context}`, `{arguments}`, `{input_schema}`, `{output_schema}` and `{workspace}` are the placeholders and anything else is an error. The values are those `other_work` in `examples/benchmark/step2_single_run.py` formats: `description` = the task description, `context` = the case set's context stripped, `arguments` / `input_schema` / `output_schema` = `json.dumps(value, indent=2)` as Python writes it (keys in the order published, non-ASCII as `\uXXXX`), `workspace` = `/rush/workspace`. The server's default coding template (the value a benchmark publication starts from) is `prompt` in `examples/benchmark/configs/step2_single_run.yaml`; a test keeps them equal. (JavaScript cannot tell `1.0` from `1`, so a float without a fraction prints as an integer.)
- **`task_tools`**: for `agent` and `tool` tasks `{system, user}` as `task_prompt` in `src/nanoagent/plugin/tasks.py` builds them, and for `decide` tasks `{system: decide_prompt(...), user: null}`, with the benchmark's `task_instructions` in place of the task's and the plugin name for the manifest's. A test checks them byte for byte against strings the real Python functions produced.

## `POST /sources`

Body: the raw ZIP, `Content-Type: application/zip` (`415 unsupported_media_type`). Up to `BENCHMARK_SOURCE_MAX_BYTES` (`413 source_too_large`). The server checks that it starts as a ZIP and has an end-of-central-directory record (`400 invalid_zip`), and reads `harness.yaml` from its root and validates it against the `Manifest` shape of the [harness contract](uploaded-harness-v1.md) (`name`, `version` and `dialects` are required there): `400 missing_manifest` when `harness.yaml` is not at the archive root, `400 invalid_manifest` (the message names the problem, e.g. a missing `name`) when it does not validate. The worker validates the rest of the contents.

`201`:

```json
{"source_sha256": "…", "size": 1234, "harness": {"name": "my-harness", "version": "1.3", "dialects": ["chat_completions"]}}
```

A manifest `name` that is a reference harness's is refused as `400 reserved_harness_name` and stores nothing. The names are `GET /defaults`'s `reference_harnesses`; the server keeps the list, and a test keeps it equal to the folders of `nanoagent/src/nanoagent/uploaded/reference_harnesses/`.

Uploading the same bytes again is a no-op with the same answer. The source is the member's, per workspace. The harness is `(owner, name)`, owned by the uploading member, so two members may both upload `foo`. The first upload of `owner/name@version` pins its `source_sha256`; a different ZIP under the same `owner/name@version` is `409 harness_version_taken` with `{"harness": {"name", "version"}, "pinned_sha256": "…"}` and stores nothing. The same ZIP is accepted any number of times; each run is its own row.

### Reference harnesses

The reference harnesses ship in NanoAgent's package and are built by NanoAgent under their own name, with a content-derived version, so a reference never meets `harness_version_taken` (see the design document's [reference harnesses](../plans/uploaded-harness-benchmarks.md#reference-harnesses)). Their ZIPs reach RUSH only through these routes, at the trust level of private-reference pinning. Each answers `201` as `POST /sources` does (the harness echoed, stored as the member's source with the version pin) and refuses a name that is no reference (`400 unknown_reference`) and a ZIP whose manifest names another harness (`400 reference_name_mismatch`):

- `POST /sources/references/{name}`: the body is the reference's ZIP, as the CLI's `reference:` sends it (`415 unsupported_media_type`, `413 source_too_large`, as for `POST /sources`).
- `POST /sources/references/{name}/computer`: no body. Needs `apps:use`. The server asks the member's own NanoAgent for the ZIP (`GET /v1/benchmark/reference-harnesses/{name}`, relayed by the runner) and stores it. Extra errors: `503 runner_offline`, `reference_unavailable` (with the status the computer returned).

## `POST /runs`

```json
{"benchmark_id": "…", "policy": "coding", "preview_id": "…", "source_sha256": "…", "idempotency_key": "any string up to 200 chars"}
```

All five are required; any other field is `400 invalid_request`. The model, endpoint, limits, prompt and cases come from the benchmark and the harness name, version and dialects from the uploaded source's manifest. Only the submitting member's own worker, claiming with the benchmark's `endpoint_profile` label, receives the run's work.

The server, in this order:

1. Returns the original run if the key was used by this member in this workspace: `200 {"replayed": true, "run": …}`, or `409 idempotency_conflict` if the request differs. This happens even if the plugin has since been uninstalled.
2. `404 unknown_benchmark`, `404 unknown_preview`, `404 unknown_source`.
3. Resolves the request again, as a preview does (so `409 worker_unavailable`, `400 limit_exceeds_worker`, `400 unknown_model` and the rest apply: a worker that stopped pricing the benchmark's model is a refusal here, never a queued run whose attempts would be interrupted). If it no longer resolves to what the preview pinned, `409 stale_preview`:
   ```json
   {"error": "…", "code": "stale_preview", "stale": ["prompt", "cases"], "current": <the preview body, without preview_id>}
   ```
4. In one transaction pins the run: source and package bytes (content-addressed, retained after uninstall; the benchmark's stored package is used, so a benchmark of an older plugin version still runs after a newer one is installed), the benchmark id and name, the harness owner, name and version, the case set id and digest, the task and context as published, the cases with their content digests and rendered prompts, the policy, the prompt text, the effective limits, the model, endpoint and the manifest's dialects, and the case set's references; creates one attempt per case; only then are attempts claimable. `409 package_unavailable` if the plugin version is no longer published and no run kept its package.

`201 {"replayed": false, "run": <run>}`. Errors: `400 invalid_request`.

## `POST /sessions`

One session of a plugin page's Harness tab, or of `nanoagent harness`: `{"plugin_id", "task_id", "harness", "text", "interactive", "model"?}`. RUSH reads the session's case set but its case (the plugin and task `task_id`) from the member's computer, builds the reference harness `harness` (or takes the latest version of the member's own harness `harness` that a Terminal session saved into this workspace, which works under `coding`) and queues a run of the one case at once, before the case is known, on the endpoint RUSH Lab's worker serves, on `model` (an OpenRouter model id) when given, else the model every run uses. Meanwhile the member's computer fills the task's input from `text` with the model every plugin run uses and pins the case; the worker reads it, or why it could not be pinned, from `GET /attempts/{id}/case`, and until then the run's case has `arguments`, `content_digest` and `prompt` null. Every such run is a session, never a benchmark result, so `GET /runs` lists none. `interactive` (required) is whether the member is at the harness's terminal (`run.interactive` in its claim); one that is not (`nanoagent harness prompt=…`) runs on its own to its answer. A session of the Terminal (`shell`) with `interactive` true is free-form: an empty shell whose member runs any agent and prompts it themselves, the same whichever plugin's page opened it. It takes no `task_id` and no `text` (`400` with either), and nothing of the plugin is opened, read or run for it: its run keeps `plugin_id` only as the label of that page (its plugin's name, version, package and task are null), runs under the Terminal's own limits (a scored session's), and has no case set and no case, nothing filled, pinned or scored: one attempt of no case (`case_id` null) records its model calls and commands and ends `ended`. Such a session may take `resume`, the attempt id of an ended free-form session of the member's (`404 unknown_session` for anything else, `409 session_running` while it runs, `400 invalid_request` with any other harness): its run is a new session linked to that one (`resumed_from`), and its claim names it (`resume`), so the worker puts back what it kept of it on the member's computer before the shell starts, or says it kept nothing. With `resume` it may take `chat`, one of that session's chats (`{"agent", "id", "run"}`, `id` the CLI's conversation id and `run` `null`, or `id` `null` and `run` the run of a program the chat is, `{"argv", "cwd"}`; `404 unknown_chat` for one it did not hold): its claim's `resume.chat` names it, and its first terminal reopens that conversation (`claude --resume <id>`, `codex resume <id>`, `pi --session <id>`, `hermes --resume <id>`) or reruns that run's command line in its folder, or says why it cannot. A new one (no `resume`) may instead take `start`, an agent's CLI command (`claude`, one word of a harness name's characters; `400 invalid_request` otherwise, or with `resume` or any other harness): its claim carries it (`start`), and its first terminal runs it at its first prompt. Either may come with `join: true` (a session clicked on the Dashboard; `400 invalid_request` without `resume` or `start`): while the member's free-form session on that plugin still runs, the answer is that session, `joined: true`, neither ended nor joined by a second, and the page asks its worker over the terminal link to open the clicked session in its next terminal (`{"reopen", "rows", "cols"}`). `201 {"run": <run>, "attempt_id", "joined"?}`, `attempt_id` the session's one attempt; `503 runner_offline`, `409 app_unavailable`, `pin_failed` (the plugin has no such task), `400 unknown_harness`.

## `POST /imports`

A run of a reference harness made outside RUSH (NanoAgent's `examples/benchmark` step 5), kept as the caller's own scored run: `{"frame", "source_sha256", "case_id", "kind", "started_at", "execution", "correct", "verdict", "elapsed_ms", "input_tokens", "output_tokens", "cost_usd", "profile", "arguments", "expected_error", "reference", "answer", "trajectory"}`. `frame` is its case set but the cases and the package digest (`name`, `plugin_id`, `plugin_name`, `version`, `task_id`, `task`, `context`, `model`, `endpoint_profile`, as `POST /api/benchmark/benchmarks` takes them); RUSH pins the package of that version as published and checks the task against it (`404 unknown_plugin_version`, `422 task_mismatch`). `source_sha256` is the caller's source of the reference harness (`POST /sources/references/{name}`), `execution` `answered`, `refused` or `execution_failed`, `verdict` the verifier's word, `profile` the rest of its profiler's figures (`{"model_ms", "tools_ms", "overhead_ms", "cache_read_tokens", "model_calls", "tool_calls"}`, each an integer); `arguments`, `expected_error` and `reference` are the case's as a publication's case and its private reference, `answer` what the harness gave (null for none) and `trajectory` its ATIF steps. The run's one attempt is final with verdict `pass` or `fail`, metrics `elapsed_ms`, tokens and the profile's figures, and one settled admission of `cost_usd`; its case is pinned as a session's is (its arguments, content digest and the prompt RUSH renders for it under the harness's policy) with its private reference, and its trace is its events: `verifier.verdict` (`{correct, verdict}`), `harness.answer` (`{answer}`) and one `trajectory.step` per step (the step). RUSH keeps one run per plugin, task, case and harness: `201 {"run_id", "created": true, "filled": true}`, then `200 {"run_id", "created": false, "filled"}` for the same record again, `filled` whether RUSH had kept it without its case and trace or without its profile and filled them in now, and `409 idempotency_conflict` when the plugin version, `correct`, `verdict` or (when RUSH kept one) `answer` differs; nothing else is compared, so a later build of the harness (another source, time, tokens or cost) fills what was missing.

## `GET /runs?limit=&before=`

The caller's own runs in this workspace but interactive sessions (`POST /sessions`), as **run summaries** (see Run summary above), newest first. `limit` 1 to 200 (default 50); `before` an ISO timestamp (runs created earlier). Metrics sum the newest attempt of each case with the same code as `GET /runs/{run_id}`, so a list row's `metrics`, `status` and `score` equal the detail's.

```json
{"runs": [<run summary>]}
```

## `GET /runs/{run_id}`

`{"run": <run>}` or `404 unknown_run`. A run:

```json
{
  "run_id": "…", "status": "queued|running|complete|canceled", "created_at": "…", "canceled_at": null,
  "benchmark": {"benchmark_id": "…", "name": "…"}, "harness": {"name": "…", "version": "…", "dialects": []},
  "model": "…", "endpoint_profile": "…", "dialects": [], "policy": "coding|task_tools",
  "prompt": {"source": "benchmark", "text": "<template or instructions>", "renderer_version": "rush.prompt.v1"},
  "limits": {"wall_time_ms": 600000, "…": 0, "internet_access": true}, "egress_hosts": null, "unverified_egress": true,
  "selection": {"case_ids": ["c1"]}, "preview_id": "…", "source": {"sha256": "…", "size": 123},
  "case_set": {"case_set_id": "…", "name": "…", "digest": "…", "publisher": {}, "plugin": {"id": "…", "name": "…", "version": "…", "sha256": "…"},
               "task_id": "…", "task": {}, "context": "…"},
  "cases": [{
    "case_id": "c1", "position": 0, "kind": "answer", "arguments": {}, "expected_error": null, "content_digest": "…",
    "prompt": {"system": null, "user": "…", "sha256": "…"}, "latest_attempt_id": "…", "attempts": [<attempt>]
  }],
  "score": {"value": 0.5, "passed": 1, "scored": 2, "total": 2, "unscored": 0, "verifier_errors": 0, "complete": true, "unavailable_reason": null},
  "metrics": <metric sums>
}
```

`selection` is every case id of the benchmark; `cases` are those cases. `case_set.name` is the benchmark's name and `case_set.publisher` the benchmark's publisher. `dialects` are the harness manifest's. `status` is `canceled` once canceled, `complete` when every case's newest attempt is final, `running` when some started, else `queued`. `egress_hosts` is the tool container's allowed HTTPS hosts under `task_tools`, `null` (not applicable) under `coding`.

**Score.** `value` = passed / scored over each case's newest attempt: a case is *scored* when that attempt has a verdict (`pass` or `fail`), *passed* when it is `pass`. `unscored` counts the others (not final yet, ended before a verifier saw them, or a verifier error), `verifier_errors` those among them whose verifier failed, and `complete` says every newest attempt is final. `value` is `null` with `unavailable_reason` `verifier_error`, `no_scored_cases` or `scoring_pending` when none was scored. The score is provisional while `complete` is false.

**Metric sums:** for each of `total_tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, elapsed_ms`: `{"total": <sum of the newest attempts that reported it>, "missing_attempts": <count that did not>}`.

**Outcomes** stay distinguishable by `execution.status` and the verdict: `build_failed` (the source did not build: a preparation error), `execution_failed` (the harness failed, timed out, ran out of budget, or left no valid `answer.json`), `refused`, `answered`, then the verdict `pass`/`fail`, a `verifier_error` (the verifier crashed: no verdict), and the run's `score.unavailable_reason`. Verdicts are the worker's: a refusal case passes when refused and fails when answered; an answer case fails when refused.

**Attempt:**

```json
{
  "attempt_id": "…", "run_id": "…", "case_id": "…", "attempt_no": 1, "rerun_of": null,
  "state": "queued|leased|final",
  "execution": {"status": "answered|refused|execution_failed|build_failed|canceled|interrupted|ended", "reason": null},
  "verdict": "pass|fail|null", "explanation": null, "verifier_error": null,
  "coverage": {}, "metrics": {}, "sealed": true, "final_cursor": 3, "high_water_cursor": 3,
  "cancel_requested": false, "created_at": "…", "claimed_at": "…", "finalized_at": "…"
}
```

`execution` is `null` until final.

## `GET /attempts/{attempt_id}`

`{"attempt": <attempt> + "kind", "content_digest", "prompt": {"system", "user", "sha256"}}` or `404 unknown_attempt`.

## `GET /attempts/{attempt_id}/events?after=<cursor>&limit=<n>`

`after` default 0; `limit` default 200, max 1000. Events with `cursor > after`, ordered by cursor.

```json
{"events": [{"cursor": 2, "event_id": "…", "source": "gateway", "kind": "model_call", "sequence": 2, "occurred_ns": "1700000000123456789", "data": {}, "payload_sha256s": ["…"], "received_at": "…"}],
 "has_more": false, "sealed": false, "final_cursor": null, "high_water_cursor": 3}
```

## `GET /attempts/{attempt_id}/stream?after=<cursor>`

Server-sent events. A reconnect resumes with `after` or the `Last-Event-ID` header. Each committed event after the cursor:

```text
id: <cursor>
event: event
data: <the event object above>
```

When the attempt is sealed and every event up to its final cursor was sent: `event: sealed` with `data: {"final_cursor": N}`, then the stream ends. `: heartbeat` comments arrive while idle. A sealed attempt streams what remains, then `sealed`. `404` for an attempt the caller cannot see.

## `GET /attempts/{attempt_id}/terminal-link`

Where the member reaches the terminals of their own Harness tab session on their computer: `200 {"port", "token"}` once its worker has started them, the worker's link on `127.0.0.1:<port>`, which takes `token` (RUSH Lab connects the page to it; what is typed and what the terminals write never pass through RUSH). Terminal `0` is the harness's; a free-form session's member opens more (`1` to `31`), all in its one VM. RUSH holds the request up to 20 s for the worker, then answers `204`. `404` for an attempt that is not the caller's own session. What the terminals wrote reaches RUSH too, in the background, and is kept (4 MiB at most together).

## `GET /attempts/{attempt_id}/spans?kind=&status=&q=&limit=`

`limit` default 1000, max 5000. `q` is a case-insensitive substring match on span id, name, target and scope.

```json
{"spans": [{"id": "s1", "kind": "tool", "name": "…", "parent": "root", "scope": null, "status": "ok", "start_ns": "…", "end_ns": "…", "provenance": "harness", "target": "…", "attributes": {}}],
 "links": [{"kind": "caused_by", "from": "s1", "to": "root", "method": "broker", "attributes": {}}]}
```

Links are always all of the attempt's.

## `GET /attempts/{attempt_id}/payloads/{sha256}`

The bytes, `Content-Disposition: attachment`, with the stored `Content-Type`, `X-Rush-Redaction: none|redacted|truncated` and `X-Content-Type-Options: nosniff`. `404 unknown_payload` / `unknown_attempt`.

## `GET /attempts/{attempt_id}/accounting`

```json
{"attempt_id": "…", "calls": [{
  "call_id": "…",
  "admission": {"status": "reserved|uncertain|settled", "reserve_usd": 0.4, "cost_usd": null, "provenance": null, "created_at": "…", "settled_at": null},
  "accounting": {"version": 2, "record": {}}
}], "totals": {"calls": 2, "reserved_usd": 0.4, "settled_usd": 0.1, "uncertain_calls": 1}}
```

`accounting` is the call's latest version, or `null`. `reserved_usd` sums reservations not yet settled. `settled_usd` sums the settled calls' costs, and is `null` (unknown, never zero) when calls were made but none has a settled cost; `uncertain_calls` counts the calls whose cost is not known.

## `POST /runs/{run_id}/cases/{case_id}/rerun`

Queues a new attempt (`attempt_no` + 1, `rerun_of` the newest) using the run's retained source and package, whether or not the plugin is still installed. `201 {"attempt_id", "attempt_no"}`. Errors: `404 unknown_run` (also for another member or one who left), `404 unknown_case`, `409 run_canceled`, `409 attempt_active` (the newest attempt is not final).

## `POST /runs/{run_id}/cancel`

Marks the run canceled. Queued attempts end `canceled` at once; leased ones are told at their next renewal or admission (`409 canceled`) and finalize themselves. `200 {"canceled_attempts": n, "signaled_attempts": n}`; repeating is harmless.

## `GET /compare?a=<run>&b=<run>`

Compares two runs that share a task verifier. `409 not_same_verifier` (with `differing`: `package_sha256` and/or `task_id`) unless both pin the same plugin package digest and task id; `404 unknown_run`; `400` for ids that are not UUIDs. Benchmarks, plugin versions that share a package digest, harnesses, policies, models, prompts and limits may differ; runs of one benchmark always share a verifier. Runs of different plugin versions with different package digests are refused as `not_same_verifier`.

```json
{
  "verifier": {"package_sha256": "…", "task_id": "…"},
  "a": {"run_id": "…", "status": "…", "case_set_id": "…", "case_set_name": "…", "policy": "…", "model": "…", "endpoint_profile": "…", "score": {}, "source": {}, "created_at": "…"}, "b": {},
  "config": [{"field": "limits.memory_mb", "a": 1024, "b": 512, "differs": true}],
  "differences": ["limits.memory_mb", "model"],
  "prompt_diff": {
    "a_kind": "template|instructions", "b_kind": "template|instructions",
    "text": [{"type": "same|removed|added", "text": "line(s)"}],
    "rendered": [{"content_digest": "…", "a_case_id": "c1", "b_case_id": "x9", "identical": false, "system": [<parts>], "user": [<parts>]}]
  },
  "shared": [{"content_digest": "…", "kind": "answer", "a": <side>, "b": <side>}],
  "only_a": [{"content_digest": "…", "kind": "answer", "case_id": "…", …<side>}], "only_b": [],
  "unverified_egress": {"a": true, "b": false}
}
```

`config` lists every setting, with `differs`: `benchmark_id`, `harness` (`name@version`), `case_set_id`, `case_set_digest`, `policy`, `model`, `endpoint_profile`, `dialects`, every `limits.<name>` (`internet_access` included), `egress_hosts` (`null` under `coding`), `selection` (the resolved case ids), `renderer_version`. `prompt_diff.text` is a line diff (`diff` package) of the two runs' template or instructions text; `rendered` has one entry per shared case, with line diffs of `system` and `user` (a `null` text counts as empty) only when the rendered prompts differ. Cases are aligned by `content_digest` (the pinned kind, arguments, expected error and reference), not by case id; the n-th occurrence of a digest in one run matches the n-th in the other. A `<side>` is `{case_id, attempt_id, outcome, execution_reason, verdict, explanation, verifier_error, tokens: {total, input, output}, cost_usd, uncertain_cost, latency_ms}` for the case's newest attempt (`outcome` is its `execution.status`, else its state; `cost_usd` sums its admissions' settled costs and is `null` when any call is not settled with a known cost, since a reserve is a spending bound and not a cost; `uncertain_cost` is true when a call's cost is uncertain). `unverified_egress` is true for a run with `internet_access`.

## `GET /compare/attempts?a=<attempt>&b=<attempt>`

The comparison of two sealed attempts of one pinned case, computed by NanoAgent from their stored events and payloads. `409 not_same_verifier` (package digest or task id differ), `409 not_same_case` (content digests differ), `409 attempt_not_sealed`, `404 unknown_attempt`. `200 {"header": {attempt_a, attempt_b, case: {package_sha256, task_id, content_digest}, …conditions, redactions, missing_payloads}, "rows": […], "first_difference": …}`.

---

# Benchmark publishing

## `POST /api/benchmark/benchmarks`

Any signed-in member's session, no workspace. Publishes a benchmark bound to one published plugin version of any plugin; the publisher is the caller. A benchmark is immutable. The case-set fields are derived by `nanoagent.uploaded.case_sets` from the plugin package and a plugin benchmark case file; the member supplies the case file, the package source, a name and the run configuration. There is no route that publishes a case set alone.

```json
{
  "name": "lowercase [a-z0-9._-], up to 128",
  "plugin_id": "p", "plugin_name": "P", "version": "1.0.0", "package_sha256": "<that version's package digest>", "task_id": "sum",
  "task": {"kind": "agent|decide|tool", "description": "…", "instructions": "<manifest default>", "input_schema": {}, "output_schema": {},
           "tools": [{"name": "read", "description": "…", "input_schema": {}, "output_schema": {}, "writes": false}],
           "egress_hosts": ["api.example.com"]},
  "context": "the case set's shared context",
  "cases": [{"case_id": "c1", "kind": "answer", "arguments": {}, "expected_error": null},
            {"case_id": "r1", "kind": "refuse", "arguments": {}, "expected_error": "pinned error text"}],
  "private": {"c1": {}, "r1": "pinned error text"},
  "model": "vendor/model", "endpoint_profile": "label",
  "limits": {"max_model_calls": 20, "internet_access": false},
  "coding_template": null, "task_instructions": null
}
```

- `version` is the plugin version the benchmark is tied to. `task.tools` is what `run_task` gives the agent (the reference tool excluded); `egress_hosts` is sorted without repeats (`400 invalid_request` otherwise; `[]` is none). `private` has exactly one reference per case: for an answer case the pinned output object, or `null` for a task the verifier judges without one; for a refusal case the pinned error string (and `expected_error` is required). References are stored where only the worker API reads them. The worker runs on the member's computer, so a member who runs a benchmark receives its references with each claim and can read them: references are not hidden from whoever runs the benchmark. (The wire keeps the names `private` and `private_reference`.)
- `model` and `endpoint_profile` are required. `limits` holds overrides only (`null` is the default); an unknown name or an invalid value is `400 invalid_request`. The effective limits, `internet_access` included, are the defaults under the overrides, and are pinned and shown.
- `coding_template` and `task_instructions` are strings or `null` for the default (the server's coding template; the task's `instructions`). Both are pinned as text, because the runner picks the policy. CRLF and CR become LF; blank is `400 empty_template|empty_instructions`, over 100000 characters `400 template_too_long|instructions_too_long`, an unpaired surrogate `400 invalid_template|invalid_instructions`; a template that fails to render is `400 invalid_template`.
- `endpoint_profile` must have been advertised for by the publishing member's own worker within the capability window, else `409 worker_unavailable` (an unknown endpoint is refused). A limit above what the latest advertised capabilities allow, or `internet_access: true` where they say it is unsupported, is `400 limit_exceeds_worker` with `exceeded: [{field, limit, max}]`. A `model` that the latest advertised capabilities do not list (`capabilities.models`) is `400 unknown_model` with `{model, models}`, so no benchmark can pin a model whose attempts the publisher's worker could not price. A refused publication stores nothing.

The server computes each case's `reference_sha256` (SHA-256 of the compact canonical JSON of its reference) and `content_digest` (SHA-256 of the compact canonical JSON of `{kind, arguments, expected_error, reference_sha256}`), the case set's digest (SHA-256 of the compact canonical JSON of `{package_sha256, task_id, task, context, cases: [{case_id, content_digest}]}`), and the benchmark's `digest` (see Benchmarks). It creates the case set, or reuses an identical one.

**Naming.** A name is unique per `(plugin_id, version, name)`: `classroom` may exist for 0.1.0 and for 0.2.0. Publishing the same name for the same plugin version again with identical content (the same `digest`) is `200 {"created": false, …}` and stores nothing; with different content it is `409 benchmark_name_taken` and stores nothing.

`201 {"created": true, "benchmark": <benchmark summary>}`; an identical republish `200 {"created": false, "benchmark": …}`. Errors: `400 invalid_request`, `400 empty_template|empty_instructions|template_too_long|instructions_too_long|invalid_template|invalid_instructions`, `400 limit_exceeds_worker`, `400 unknown_model`, `401`, `404 unknown_plugin_version` (the id, version and digest are not one published row), `409 worker_unavailable`, `409 benchmark_name_taken`.

## `POST /api/workspaces/{wid}/benchmark/benchmarks/pinned`

Needs `apps:use`. It publishes from the member's computer, so that the plugin's reference tool pins each case on the member's computer and the private references never reach the browser. The body is the `POST /api/benchmark/benchmarks` body without the derived case-set fields (`plugin_name`, `package_sha256`, `task_id` and `task`, which the case file names, `context`, `private`; `version` too, which is the installed one) and with the case file in place of `cases`:

```json
{"name": "…", "plugin_id": "p", "cases": <the plugin benchmark case file>,
 "model": "vendor/model", "endpoint_profile": "label", "limits": {}, "coding_template": null, "task_instructions": null}
```

The server installs the app on the member's computer if needed and sends the computer's NanoAgent only `{name, cases}` (the case file without its `_` class tag); the computer pins on it with the package it runs and answers the derived case-set fields. The server builds the publication from NanoAgent's own text plus the member's `model`, `endpoint_profile`, `limits`, `coding_template` and `task_instructions` (nothing else the member sent), and publishes it with the naming rules and responses of `POST /api/benchmark/benchmarks` (`201 {"created": true, "benchmark": …}`, `200 {"created": false, …}`, the same errors). Extra errors: `503 runner_offline`, `409 app_unavailable` and `409 fs-disabled`, `pin_failed` (with the status the computer returned).

---

# Worker API

Prefix `/api/benchmark-worker`. All bodies are JSON unless noted. A **fence** is the integer a claim returns; it increments each time a job is leased. Attempt routes take it in the body as `fence`, byte routes in the header `X-Rush-Fence`. A fenced route answers:

| Condition | Response |
| --- | --- |
| Fence is not the attempt's current fence, or the attempt was interrupted | `409 lease_lost` |
| Lease expired (the attempt becomes `interrupted`, evidence kept) | `409 lease_lost` |
| Attempt already finalized by this fence | `409 sealed` |
| Unknown attempt, or an attempt of another member's run | `404 unknown_attempt` |

An interrupted attempt is final: a retry needs a new attempt, which only a member's rerun creates.

## `POST /claim`

```json
{"worker_id": "w-1", "endpoint_profile": {"label": "mock", "mode": "mock"},
 "capabilities": {"wall_time_ms": 600000, "max_model_calls": 100, "max_output_tokens_per_call": 8192, "max_cost_usd": 5, "concurrency": 8, "interactive_slots": 1,
                  "cpus": 4, "memory_mb": 4096, "pids": 1024, "workspace_bytes": 1073741824, "workspace_files": 50000, "tmp_bytes": 268435456, "build_wall_ms": 1200000,
                  "build_memory_mb": 4096, "build_output_bytes": 2147483648, "build_files": 200000, "build_tmp_bytes": 1073741824, "internet_access": true,
                  "models": ["vendor/model"]},
 "interactive": false}
```

`interactive` (required, a boolean) says which attempts the claim takes: `true` only a session's that someone works at (a Terminal, or a Harness tab session with the member at it), `false` only the others. A worker claims each kind in its own slots, `concurrency` for the others and `interactive_slots` (1) for a session someone works at, so a scored run (a one-shot session, a benchmark attempt) runs beside an open Terminal. `wait_s` (optional, 0 to 30, default 0) is how long RUSH holds a claim that finds nothing to lease: it answers as soon as the member's work is queued (`POST /runs`, `/sessions`, a rerun), else `204` once `wait_s` has passed. `capabilities` is required (`400 invalid_request` if any limit is missing or invalid): the maximum the worker applies for each numeric limit (the worker also sends `concurrency`, how many attempts it runs at once, at most its machine's CPUs, and `interactive_slots`; the server does not store or check it, a run has no concurrency limit, and a request that sends `limits.concurrency` is `400 invalid_request`) and whether it can give a harness `internet_access`, and `models`, the names of the models it prices (the keys of its `prices`; a non-empty list of strings, else `400 invalid_request`). Every claim stores them as the latest for the credential's member and the endpoint `label`; that member's previews and runs for that label are checked against them (`409 worker_unavailable` before their worker has advertised, or when it has not claimed for the label within the last 300 seconds, `400 limit_exceeds_worker`, `400 unknown_model`).

The claim first expires stale leases (attempts become `interrupted`, sealed at their last committed cursor) and settles reservations past their deadline at the reserved bound. Then it leases the oldest queued attempt of a run whose `user_id` is the credential's member and whose `endpoint_profile` equals `label` (a worker never receives another member's run), whose pinned limits are all within the claiming worker's `capabilities`; a canceled run's queued work is never leased. `204` for none.

Job (`200`):

```json
{
  "kind": "attempt", "attempt_id": "…", "attempt_no": 1, "fence": 1, "lease_expires_at": "…", "lease_seconds": 60,
  "run": {"run_id": "…", "model": "…", "endpoint_profile": "…", "dialects": [], "source_sha256": "…", "policy": "coding|task_tools",
          "limits": {"wall_time_ms": 600000, "…": 0, "internet_access": true}, "prompt_source": "benchmark", "renderer_version": "rush.prompt.v1",
          "interactive": false, "prompt_bound": true},
  "plugin": {"id": "…", "name": "…", "version": "…", "sha256": "…"},
  "free_form": false,
  "resume": null,
  "start": null,
  "case_pending": false,
  "case_set": {"case_set_id": "…", "digest": "…"},
  "task": {"id": "sum", "kind": "agent|decide|tool", "description": "…", "instructions": "…", "plugin_name": "…", "tools": [{"name": "…", "description": "…", "input_schema": {}, "output_schema": {}, "writes": false}], "egress_hosts": ["api.example.com"]},
  "case": {"case_id": "c1", "position": 0, "kind": "answer|refuse", "arguments": {}, "context": "…", "input_schema": {}, "output_schema": {}, "content_digest": "…"},
  "prompt": {"system": null, "user": "…", "sha256": "…"},
  "private_reference": {}
}
```

`free_form` is `true` for a free-form Terminal session (`POST /sessions`), whose attempt has no task and no case: `task`, `case_set`, `case`, `prompt` and `private_reference` are `null`, `plugin` has its `id` alone (the others `null`, and there is no package to fetch), the worker reads no result and runs no verifier, and finalizes it `ended` (only such an attempt may end so, and it may not end `answered` or `refused`). `resume` is `{"attempt_id", "at", "chat"}` for a free-form session that resumes an ended one (`at` when that one was finalized, ISO 8601; `chat` the chat of it to reopen, `{"agent", "id", "run"}`, or `null`), else `null`: the worker keeps each ended free-form session's workspace on the member's computer (nanoagent.uploaded.resume), never sending it to RUSH, and puts it back before the shell starts. `start` is the agent CLI command a new free-form session's first terminal runs at its first prompt (`POST /sessions` `start`), else `null`. `case_pending` is `true` for a session whose case is still being pinned: `case_set`, `case`, `prompt` and `private_reference` are then `null`, and the worker reads them from `GET /attempts/{id}/case` before the harness starts. `run.interactive` is `true` for a Harness tab session's run, whose member works at the harness's terminal (the worker serves its terminals to the member's page on their computer and tells RUSH where, `POST /attempts/{id}/terminal-link`). `run.prompt_bound` is whether the gateway holds the attempt to its pinned prompt (until one call completes, each carries it): `false` only for a session of `shell` or of a harness saved from one, whose agent is whatever the member runs. `task.instructions` is the instructions the run works: under `task_tools` the benchmark's pinned `task_instructions`, under `coding` the task's default. `task.egress_hosts` is the tool container's network under `task_tools`; the worker applies it only for that policy. `case.input_schema` / `output_schema` are the task's. `case.kind` and `private_reference` stay on the worker, which is the member's own computer; the claim hands them to the member's machine, so the references are not private from the member running the benchmark. `private_reference` is the pinned output object (or `null`) of an answer case and the pinned error string of a refusal case. A run's scoring is computed by the server from the attempts' verdicts; there are no scoring jobs.

## `POST /attempts/{id}/renew`

`{"fence": 1}` → `200 {"lease_expires_at": "…", "lease_seconds": 60}`. A canceled run: `409 canceled`. `lease_seconds` is how long a claim or renewal keeps the lease, counted from when the server received it; the worker fences its own services on it (no new gateway, tool, exec or event work once it passes without a renewal).

Expired leases do not wait for a claim: the server sweeps every `BENCHMARK_SWEEP_SECONDS` and before member reads of a run, attempt, run list or accounting. Attempts whose lease ran out become `interrupted` (evidence kept), and reservations past their deadline settle at the reserved bound.

## `GET /attempts/{id}/source`, `GET /attempts/{id}/package`

Header `X-Rush-Fence`. The retained source ZIP, or the plugin package, as `application/octet-stream` with `X-Rush-Sha256`. Missing header `400 invalid_request`.

## `POST /attempts/{id}/admissions`

```json
{"fence": 1, "call_id": "call-1", "reserve_usd": 0.4}
```

One transaction with row locks: records a unique admission and reserves `reserve_usd` against the attempt, the member and the workspace. `201 {"call_id", "reserve_usd"}`. Errors: `409 duplicate_call`; `409 canceled`; `409 lease_lost`; `402 budget_exhausted` with `scope`:

| `scope` | Exhausted |
| --- | --- |
| `calls` | `limits.max_model_calls` admissions already made |
| `attempt` | the attempt's reserved plus settled spend + this reservation exceeds `limits.max_cost_usd` |
| `member` | the member's committed spend today (UTC) + this reservation exceeds `BENCHMARK_MEMBER_BUDGET_USD` |
| `workspace` | likewise for `BENCHMARK_WORKSPACE_BUDGET_USD` |

Checked in that order; nothing is reserved on refusal. A reservation stays against the budgets, even for a call with an uncertain outcome, until settled.

## `POST /attempts/{id}/admissions/{call_id}/settle`

```json
{"fence": 1, "outcome": "settled", "cost_usd": 0.1, "provenance": {"source": "usage"}}
```

`outcome` is `settled` (requires `cost_usd`) or `uncertain` (`cost_usd` ignored; the reservation is kept until it is settled or its deadline passes, when a claim settles it at `reserve_usd` with `provenance.settled_by = "deadline_sweep"`). `provenance` is an object. **The fence is ignored**: settlement is allowed after the lease is lost, so spend is never dropped. `200 {"call_id", "status", ...}`. Settling a settled call again with the same cost is `200`; with another cost `409 already_settled`. `404 unknown_call`. Budgets move by `cost_usd - reserve_usd`.

## `POST /attempts/{id}/events`

```json
{"fence": 1, "events": [{"event_id": "e1", "source": "gateway", "kind": "model_call", "sequence": 1, "occurred_ns": "1700000000123456789", "data": {}, "payload_sha256s": ["…"]}]}
```

1 to 500 events; `data` is an object; `occurred_ns` and `payload_sha256s` optional. The attempt row is locked and each new event gets the next cursor, in request order. The batch is atomic. `200`:

```json
{"receipts": [{"event_id": "e1", "cursor": 1, "duplicate": false}], "high_water_cursor": 1}
```

An event with a known `event_id` and identical canonical content (`source, kind, sequence, occurred_ns, data, payload_sha256s`) returns its original cursor with `duplicate: true`. Different content: `409 conflicting_duplicate` (nothing from the batch is stored). After the seal: `409 sealed`.

## `PUT /attempts/{id}/payloads/{sha256}`

Raw bytes. Headers: `X-Rush-Fence`, `X-Rush-Redaction: none|redacted|truncated` (required), `Content-Type` (stored). `200 {"sha256", "size", "created"}`; storing the same payload again is `created: false`. Errors: `400 digest_mismatch` (bytes do not hash to the path), `413 payload_too_large`, `409 sealed|lease_lost`. Events reference payloads by digest; the server does not require a payload to exist first.

## `POST /attempts/{id}/terminal`

`{"fence": N, "terminal": T, "offset": <byte>, "data": "<base64>"}`: what terminal `T` (0 the harness's, to 31) wrote from byte `offset`, at most 256 KiB a request. `offset` is the bytes that terminal holds so far: `200 {"next_offset"}`; a retried offset with the same bytes is kept once, other bytes `409 conflicting_duplicate`, a later offset `409 terminal_gap`, past 4 MiB for the attempt's terminals together `413 too_large`. `{"fence": N, "terminal": T, "closed": true}`, after its last output: terminal `T` ended, `200 {"closed": true}` (a retry is kept once).

## `GET /attempts/{id}/case`

Header `X-Rush-Fence`. The case of a job claimed with `case_pending`: `200 {"case_set", "case", "prompt", "private_reference"}` as a claim carries them, once the member's computer has pinned it. RUSH holds the request up to 20 s for the pin, then answers `204`. `422 case_failed` with why the case could not be pinned (or that RUSH lost the pin, past its pin timeout): the attempt ends `execution_failed`, reason `case_failed: <why>`, unscored.

## `POST /attempts/{id}/terminal-link`

`{"fence": N, "port": P, "token": "<secret>"}`: the session's terminals are served on `127.0.0.1:P` to whoever sends `token`, which RUSH hands only to the session's member (`GET /attempts/{id}/terminal-link`). `200 {"linked": true}`; `403 not_a_session` for a run nobody works in.

## `GET /attempts/{id}/watch`

Header `X-Rush-Fence`. A session's watch: `409 canceled` as soon as it is canceled (its member left its page or opened another), `409 lease_lost` or `409 sealed` as soon as that happens, so the worker ends the case at once; `204` when none did within 15 s.

## `POST /attempts/{id}/score`

`{fence}`. The case a scored `rush <command>` in the attempt's Terminal session works (the first time the session's shell expands "$RUSH_PROMPT"): the first task of the session's plugin, its case filled from the task's description and pinned on the member's computer as a one-shot session's is. `200 {plugin: {id, name, version, sha256}, task: {id, plugin_name, …the task}, package, case: {case_id, kind, arguments, expected_error, content_digest, reference}, prompt}`: `prompt` the coding prompt rendered for the case (the shell's `RUSH_PROMPT`), `case.reference` its private reference and `package` the package installed there, in base64, its bytes checked to be that sha256, with which the worker verifies the run on the answer.json it leaves. Nothing of it is kept: the run's verdict goes on its process in the session's trace (`process.rush`), which the Dashboard shows on its row. `pin_failed`, `package_unavailable`, `503 runner_offline` without the member's computer, `403 not_a_session` for a run nobody works in.

## `POST /attempts/{id}/tools`

`{fence}`. What `nanoagent` (and `mgen`) in the attempt's Terminal session works with, asked for the first time either runs there: the first task of the session's plugin, opened on the member's computer as `POST /attempts/{id}/score` opens it, and the package installed there as that version (NanoAgent's `GET /v1/installs/{sha256}/package`, the plugin the Session tab's agent runs), its bytes checked to be that sha256. `200 {plugin: {id, name, version, sha256}, task: {id, kind, description, instructions, plugin_name, input_schema, output_schema, tools, egress_hosts}, package}`, `package` the package's bytes in base64. The worker then boots the plugin's tool VM beside the session's case and serves its tools through the broker to a token only that NanoAgent process holds; no other process in the session calls them. `package_unavailable` when the member's computer cannot give that package or gives other bytes, `503 runner_offline` without the member's computer, `403 not_a_session` for a run nobody works in.

## `POST /attempts/{id}/spans`

The span index and causal links, apart from events. Rejected after the seal.

```json
{"fence": 1,
 "spans": [{"id": "s1", "kind": "tool", "name": "read-file", "parent": "root", "scope": "agent", "status": "ok", "start_ns": "…", "end_ns": "…", "provenance": "harness", "target": "…", "attributes": {}}],
 "links": [{"kind": "caused_by", "from": "s1", "to": "root", "method": "broker", "attributes": {}}]}
```

`id`, `kind` and `name` are required for a span; `kind`, `from`, `to` for a link. Reporting a span again fills missing fields (`end_ns`, `status`) and merges `attributes`; links are unique by `(kind, from, to)`. `200 {"spans": n, "links": n}`.

## `POST /attempts/{id}/finalize`

```json
{
  "fence": 1,
  "execution": {"status": "answered", "reason": null},
  "verdict": "pass", "explanation": null, "verifier_error": null,
  "coverage": {"status": "complete"}, "metrics": {"total_tokens": 10, "elapsed_ms": 100},
  "final_cursor_expected": 3
}
```

`execution.status` is `answered`, `refused`, `execution_failed`, `build_failed`, `canceled` or `ended` (`interrupted` is the server's). `ended` is a free-form Terminal session's, which had no case, and only such an attempt's; it never ends `answered` or `refused` (`422 invalid_status`). `verdict` is `pass` or `fail`, the plugin task verifier's decision under its table (a refusal case passes when refused and fails when answered; an answer case fails when refused), and only comes with `answered`, `refused` or `execution_failed` (`400 verdict_not_allowed`); an `execution_failed` attempt sent with `fail` counts as a scored failure, one sent without a verdict is unscored. `verifier_error` (a string; the verifier crashed) replaces the verdict, comes only with `answered` or `refused`, and leaves the case unscored; members see it. Both together is `400 invalid_request`. `resumable` (optional, a boolean, only for a free-form session: `422 invalid_request` otherwise) is whether the worker kept the session on the member's computer to resume; RUSH stores it with the attempt and learns nothing else of what was kept. With it, such a session sends `chats`, the conversations its agent CLIs held (each `{"agent", "id", "title", "started_at", "ended_at", "started_ns", "ended_ns"}`: the CLI's command and its own conversation id, its first prompt, its first and last message by the CLI's clock and on the attempt's records' clock), which the Dashboard lists by agent, and `evicted`, the attempt ids of the member's older sessions the worker removed to keep this one, which RUSH marks no longer resumable, and `workspace`, its files (the workspace less `.rush/` and caches, `nanoagent.uploaded.workspace_upload`): `{"sha256", "bytes", "chunks"}`, a tar.zst the worker uploaded first as the attempt's payloads, `chunks` their digests in order (`422 invalid_request` when one was not uploaded or their sizes do not add up to `bytes`), or `{"error"}`, why none was uploaded (over the worker's `workspace_upload_bytes`, unreadable, or refused); the attempt shows the error, or the bytes, as `workspace`, and the trace export links the archive (`GET /api/traces/workspaces/{attempt_id}`, to its member, or a platform administrator from the CLI's connection). `coverage` and `metrics` are objects stored as sent; the metric sums read `total_tokens`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `elapsed_ms`. `final_cursor_expected` must equal the committed high-water mark (`409 cursor_mismatch` with `high_water_cursor`). `explanation` (optional, only with a `fail` verdict) is one of `invalid_answer`, `refused_answer_case`, `answered_refusal_case`, `execution_failed` (`nanoagent.plugin.verifier.TASK_VERIFIER_EXPLANATIONS`), and is stored and returned beside the verdict (`null` for a pass and for a failure `verify_task` alone judged). Unknown fields (`score`) are ignored.

One transaction stores status, verdict or verifier error, coverage, metrics, the high-water mark, and seals the stream. `200 {"attempt_id", "sealed": true, "final_cursor", "replayed": false}`. Finalizing again identically returns `replayed: true`; differently `409 conflicting_duplicate`.

## `POST /attempts/{id}/accounting`

```json
{"call_id": "call-1", "version": 1, "record": {"cost_usd": 0.1, "generation_id": "gen-1"}}
```

No fence; allowed after the seal and after lease loss; never rewrites events. The call must have been admitted (`404 unknown_call`). Versions are separate records (`version` ≥ 1); the same version with the same record is a no-op `200 {"created": false}`, with a different record `409 conflicting_duplicate`. Members read the highest version.

---

# Future: shared traces and harness archives

Not built. A database of every run's trace and harness ZIP that other members can open from the all-members results. The API returns only run summaries today and is shaped so this follows without reshaping:

- Results rows are keyed by `run_id`, and evidence (events, spans, payloads) is already stored per attempt, so a row can later link to its trace.
- `owner/name@version` names exactly one ZIP (the `harness_version_taken` pin), so a gallery shows one archive per version.
- Sharing is opt-in (`shared_at` on the run) because a ZIP or trace may carry secrets; read policies on the evidence tables would admit shared runs. Until then the run, attempt and event routes stay owner-only.
- ZIPs and payloads move from Postgres `bytea` to object storage.
