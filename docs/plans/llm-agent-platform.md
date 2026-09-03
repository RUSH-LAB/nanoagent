# LLM agent platform

Status: NanoAgent integration implemented; durable conversations and
workspace-aware tools remain future work.

## Decision

Mochi owns the browser experience, identity, tenancy, agent definitions, and
public API. NanoAgent owns model access, the bounded agent loop, deployment
model policy, tool loading, usage, and cost accounting.

The browser never calls NanoAgent or a model provider directly. It talks only
to authenticated Mochi endpoints. Mochi calls NanoAgent over a private HTTP/SSE
connection authenticated with a deployment secret.

```text
Browser CLI pane
  -> POST /api/ai/stream
  -> Mochi API (identity, workspace, rate limit, trusted agent instructions)
  -> GET NanoAgent /v1/profiles (private, cached discovery)
  -> POST NanoAgent /v1/runs with a server-approved profile id (private SSE)
  -> harness and model selected by NanoAgent YAML
```

Mochi mirrors NanoAgent's server-owned profile catalog and stores a `profileId`
on each workspace agent. A profile is an approved harness/model pairing; the
initial configuration offers NanoAgent, Hermes Agent, and PI with DeepSeek V4
Flash. Arbitrary harnesses, commands, and model ids are rejected. Provider
credentials, tools, and execution budgets remain NanoAgent deployment policy
and never come from the browser.

## Implemented boundary

- `src/components/CommandBar/useAssistant.js` owns per-pane requests,
  cancellation, and a bounded structured conversation window.
- `src/server/routes/ai.js` authenticates, rate-limits, validates, loads trusted
  workspace agent instructions and profile selection, and preserves Mochi's
  buffered and SSE APIs.
- `src/server/ai.js` is the private NanoAgent transport. It maps NanoAgent
  `start`, `delta`, `tool`, `step`, `done`, and `error` events into Mochi's
  stable result and lifecycle shapes.
- Disconnecting a Mochi browser request aborts the upstream NanoAgent stream;
  disconnecting that stream cancels the NanoAgent run.
- Reasoning deltas and raw tool outputs are not forwarded to the browser.
- NanoAgent's initial web configuration has no tools and no host filesystem
  access.
- Legacy workspace agents with a `model` field migrate to the matching profile;
  new writes accept only a catalog `profileId`.
- Each local AI chat pins its own profile. `/harness` and `/model` inspect or
  switch that chat without changing the workspace agent's default.
- AI history remains in browser storage and is not yet shared across browsers
  or people.

The NanoAgent endpoint defaults to `http://127.0.0.1:8787`. Deployments set:

```dotenv
NANOAGENT_URL=http://nanoagent.internal:8787
NANOAGENT_API_TOKEN=...
# Optional Mochi-side guards; NanoAgent has its own independent limits.
NANOAGENT_TIMEOUT_MS=190000
NANOAGENT_MAX_STREAM_BYTES=2097152
NANOAGENT_PROFILE_CACHE_MS=30000
NANOAGENT_PROFILE_TIMEOUT_MS=5000
```

`NANOAGENT_URL=off` disables the assistant explicitly.

## Target architecture

```text
Web client
  -> Mochi AI gateway
       -> conversation and message store
       -> workspace authorization and context builder
       -> NanoAgent client
            -> bounded agent runtime
            -> server-owned model configuration
            -> server-owned tool registry
            -> tracing, usage, cost, and evaluations
       -> permission-filtered Mochi tool APIs
       -> PostgreSQL and workspace content
```

SSE remains the default transport for text and tool progress. WebSockets should
be added only if the product later needs long-lived bidirectional sessions,
voice, or multiple asynchronous events that cannot be represented cleanly as a
request stream.

## Security boundary for tools

Do not enable NanoAgent's local filesystem, shell, Python, or self-modifying
tools in the Mochi deployment. Product tools must call narrow Mochi-owned APIs.
Those APIs must authorize the originating user and workspace for every call;
NanoAgent metadata is not an authorization claim. Begin with read-only search
and document lookup. Writes require explicit user confirmation and an auditable
short-lived capability.

## Delivery TODO

### 0. NanoAgent cutover

- [x] Preserve Mochi's browser-facing streaming and buffered endpoints.
- [x] Replace Codex, Claude Code, and direct provider adapters with NanoAgent.
- [x] Propagate browser cancellation to NanoAgent.
- [x] Send bounded structured conversation history.
- [x] Add linked harness/model selectors backed by NanoAgent's profile catalog.
- [x] Normalize NanoAgent lifecycle, usage, cost, and errors.
- [x] Keep reasoning and raw tool output off the browser transport.
- [ ] Publish and pin `@nanoagent/client`; replace Mochi's dependency-free
  protocol adapter with the package after publication.
- [ ] Add a bounded NanoAgent admission queue before public production use.
- [x] Add a live NanoAgent contract check using a deterministic fake model.

### 1. Durable conversations

- [ ] Add workspace-scoped `ai_conversation`, `ai_message`, and
  `ai_message_part` tables in PostgreSQL.
- [ ] Store the agent version and NanoAgent configuration fingerprint used for
  every turn.
- [ ] Load history by cursor and synchronize it across browsers.
- [ ] Support edit-and-retry, regenerate, cancellation, and conversation
  deletion without corrupting the original audit trail.
- [ ] Define retention and export behavior before storing production chats.

### 2. Workspace tools

- [ ] Define a run-scoped capability exchange between Mochi and NanoAgent.
- [ ] Begin with read-only workspace search, document lookup, channel history,
  and people lookup.
- [ ] Filter every read by workspace and document permissions before returning
  data to NanoAgent.
- [ ] Require explicit confirmation for document edits, messages, membership
  changes, or other writes.
- [ ] Persist tool calls and redacted results as structured message parts.
- [ ] Return citations that open the exact Mochi document and section.

### 3. Production operations

- [ ] Replace in-process rate limits with a distributed limiter.
- [ ] Add per-workspace quotas, budgets, and administrator controls using
  NanoAgent's usage and cost events.
- [ ] Trace request, retrieval, tool, model, latency, and token events while
  redacting secrets and sensitive content.
- [ ] Add prompt-injection, tool-authorization, cancellation, overload, and
  model-response evaluations to CI.
- [ ] Document model-provider retention, regional processing, incident
  handling, and deletion guarantees.

## Initial production boundary

The first production release stays deliberately small:

1. One privately deployed NanoAgent service.
2. Server-approved harness/model profiles selected by stable IDs.
3. Streaming, cancellation, usage, and cost propagation.
4. Durable text conversations.
5. No autonomous background work or write-capable tools.

This validates the product boundary before Mochi takes on the operational and
authorization complexity of agents that can act.
