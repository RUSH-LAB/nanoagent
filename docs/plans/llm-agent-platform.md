# LLM agent platform

Status: future work. The current implementation is a local product prototype.

## Decision

Mochi owns the agent experience and its server-side API. During local product
development, that API may invoke the developer's installed Claude Code or Codex
CLI as a fake inference backend. Production will call hosted LLM APIs through
a provider-neutral gateway owned by Mochi.

The browser must never call a model provider directly or receive provider
credentials. It talks only to Mochi endpoints.

## Current local prototype

The existing path is sufficient for testing the product interaction:

```text
CLI pane -> POST /api/ai/stream -> Mochi API -> selected local CLI process
                                      |             (Claude Code or Codex)
                                      +-> SSE text deltas -> CLI pane
```

- `src/components/CommandBar/useAssistant.js` owns streaming, cancellation,
  per-pane requests, and the short client-side context window.
- `src/server/routes/ai.js` authenticates, rate-limits, validates, and exposes
  streaming and buffered endpoints.
- `src/server/ai.js` launches Claude Code or Codex in an isolated work
  directory. Claude tools are disabled; Codex runs ephemerally in a read-only
  sandbox and is explicitly instructed not to use tools.
- `src/server/agent-runtime.js` is the provider-neutral orchestration boundary.
  It owns bounded turns, tool allowlists, authorization hooks, execution, and
  normalized lifecycle events. Local CLIs and future hosted APIs each perform
  only one inference turn behind `src/server/ai.js`.
- The SSE route can carry normalized runtime lifecycle events alongside text
  deltas. Today's UI ignores them; future tool-progress UI can consume them
  without replacing the transport.
- Workspace agents provide reusable names, descriptions, and system
  instructions. The browser sends only an agent id; the server loads the trusted
  definition from workspace storage. Agents do not yet have durable
  conversations or enabled tools.
- AI conversation history currently lives in browser storage and is not shared
  across browsers or people.

Each workspace agent selects its local provider. To force the fallback provider
when no agent selection is present:

```bash
AI_PROVIDER=claude-code npm start
```

Use `AI_PROVIDER=codex` to select Codex instead. The corresponding CLI must be
installed and authenticated. Both modes must remain disabled in production
because they borrow local credentials and launch a process for each request.
Local chat favors latency over deep reasoning by default: Claude Code runs with
`--effort low`, and Codex uses `model_reasoning_effort="none"`. Developers
can override these with `CLAUDE_AI_EFFORT` and `CODEX_AI_REASONING_EFFORT`.

## Target architecture

```text
Web client
  -> Mochi AI gateway
       -> conversation and message store
       -> agent runtime and context builder
       -> permission-aware tool registry
       -> retrieval over workspace content
       -> provider adapter (OpenAI first; others optional)
       -> tracing, usage, quotas, and evaluations
```

SSE remains the default transport for text and tool progress. WebSockets should
be added only if the product later needs long-lived bidirectional sessions,
voice, or multiple asynchronous events that cannot be represented cleanly as a
request stream.

## Delivery TODO

### 0. Local product prototype

- [x] Stream text into independent CLI panes.
- [x] Cancel an in-flight response when the user stops it or closes the pane.
- [x] Define workspace agents and apply their instructions.
- [x] Create a built-in Mochi agent, default it to Codex, and allow Claude Code or Codex per agent.
- [x] Keep the model process away from repository files and tools.
- [ ] Add a visible local-provider badge to diagnostics, not to every chat.
- [ ] Add one end-to-end test covering a stubbed streamed agent response.

### 1. Provider gateway

- [x] Define a provider interface for streaming, cancellation, usage, errors,
  model capabilities, and tool calls.
- [ ] Implement OpenAI Responses API as the first production adapter.
- [ ] Keep provider keys in server-side secrets only.
- [ ] Make model selection a server policy; do not trust arbitrary model names
  from the browser.
- [ ] Add retry and fallback rules only for failures that are safe to replay.
- [ ] Normalize provider errors and token-usage records into Mochi types.

### 2. Durable conversations

- [ ] Add workspace-scoped `ai_conversation`, `ai_message`, and
  `ai_message_part` tables in PostgreSQL.
- [ ] Store the agent version and model configuration used for every turn.
- [ ] Load history by cursor and synchronize it across browsers.
- [ ] Support edit-and-retry, regenerate, cancellation, and conversation
  deletion without corrupting the original audit trail.
- [ ] Define retention and export behavior before storing production chats.

### 3. Agent runtime and tools

- [x] Introduce a bounded server-owned runtime with a tool registry contract.
- [x] Require an allowlist and authorization hook for every tool invocation.
- [ ] Add concrete typed schemas and production tools to the registry.
- [ ] Begin with read-only tools: workspace search, document lookup, channel
  history, and people lookup.
- [ ] Require explicit confirmation for writes such as editing documents,
  messaging people, or changing channel membership.
- [ ] Persist tool calls and results as structured message parts.
- [ ] Bound turns, tool loops, wall time, output size, and cost.

### 4. Workspace knowledge

- [ ] Chunk and index workspace documents with source and permission metadata.
- [ ] Use PostgreSQL plus `pgvector` initially; avoid a second database until
  measured scale requires one.
- [ ] Filter retrieval by workspace and document permissions before ranking.
- [ ] Return citations that open the exact Mochi document and section.
- [ ] Evaluate retrieval quality with a maintained workspace question set.

### 5. Production operations

- [ ] Replace in-process rate limits with a distributed limiter.
- [ ] Add per-workspace quotas, usage records, budgets, and administrator
  controls.
- [ ] Trace request, retrieval, tool, provider, latency, and token events while
  redacting secrets and sensitive content.
- [ ] Add prompt-injection tests, tool authorization tests, and model-response
  evaluations to CI.
- [ ] Document provider data retention, regional processing, incident handling,
  and deletion guarantees.

## Initial production boundary

The first production release should be deliberately smaller than the complete
agent platform:

1. OpenAI as one server-side provider.
2. Durable text conversations.
3. Streaming and cancellation.
4. Read-only workspace search with citations.
5. No autonomous background work and no write-capable tools.

That boundary validates the product before Mochi takes on the risk and
operational complexity of agents that can act.
