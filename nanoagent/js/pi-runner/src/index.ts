#!/usr/bin/env node

import {Agent, type AgentEvent, type ThinkingLevel} from "@earendil-works/pi-agent-core";
import {
  createProvider,
  type Api,
  type AssistantMessage,
  type Model,
  type MutableModels,
  type OpenAICompletionsOptions,
  type Provider,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import {setBedrockProviderModule} from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import {openAICompletionsApi} from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {bedrockProviderModule} from "@earendil-works/pi-ai/bedrock-provider";
import {builtinModels} from "@earendil-works/pi-ai/providers/all";
import {realpathSync} from "node:fs";
import {fileURLToPath} from "node:url";

interface RunnerRequest {
  input: string;
  messages?: unknown[];
  instructions?: string | null;
  metadata?: Record<string, unknown> | null;
  workspace?: string | null;
}

interface Envelope {
  protocol: string;
  request: RunnerRequest;
  options?: Record<string, unknown>;
}

export interface PiOptions {
  provider: string;
  model: string;
  apiKeyEnv?: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  awsRegion?: string;
  awsProfile?: string;
  temperature?: number;
  maxTokens?: number;
}

// The runner ships as one bundle (build.mjs), so Bedrock's implementation is bundled rather than
// imported at run time from a file of pi-ai's that is not there.
setBedrockProviderModule(bedrockProviderModule);

export interface Server {
  id: string;
  name: string;
  urlEnv: string;
  keyEnv: string;
  // Where, beside its /v1, the server says whether it parses tool calls (`tool_call_parser`).
  infoPath?: string;
}

/**
 * The engines that serve a model from a server of one's own, as NanoAgent names them
 * (nanoagent.inference.providers.SERVERS): each a PI provider of the models its server lists, at the
 * OpenAI-compatible /v1 address in `urlEnv`, with the key in `keyEnv` if the server was started
 * with one (--api-key).
 */
export const SERVERS: readonly Server[] = [
  {id: "vllm", name: "vLLM", urlEnv: "VLLM_BASE_URL", keyEnv: "VLLM_API_KEY"},
  {id: "sglang", name: "SGLang", urlEnv: "SGLANG_BASE_URL", keyEnv: "SGLANG_API_KEY", infoPath: "/server_info"},
];

/** What listing a server found beside its models. */
export interface ServerListing {
  // Why the server could not list its models.
  error: string | null;
  // false when the server says it parses no tool calls: SGLang started without --tool-call-parser,
  // which answers a call as text. null when it does not say: vLLM, which refuses tools it cannot call.
  tools: boolean | null;
}

// How long a server has to list its models.
const LIST_TIMEOUT_MS = 3_000;

const serverOf = (provider: string) => SERVERS.find((server) => server.id === provider);

/** The address of `server`'s server in `env`, without a trailing slash, or undefined. */
export function serverUrl(server: Server, env: NodeJS.ProcessEnv): string | undefined {
  return env[server.urlEnv]?.replace(/\/+$/, "") || undefined;
}

/**
 * A model `server` serves, as its GET /models lists it: its context is the server's max_model_len,
 * which vLLM and SGLang both list, and it costs nothing. Whether it thinks is its chat template's, so
 * a run's thinking level is the template's enable_thinking, which Qwen3's and GLM's templates read and
 * any other ignores; the system prompt goes as `system`, which every template knows.
 */
export function servedModel(server: Server, baseUrl: string, entry: {id: string; max_model_len?: unknown}): Model<"openai-completions"> {
  const contextWindow = Number.isInteger(entry.max_model_len) && (entry.max_model_len as number) > 0 ? entry.max_model_len as number : 0;
  return {
    id: entry.id,
    name: entry.id,
    api: "openai-completions",
    provider: server.id,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    contextWindow,
    maxTokens: contextWindow,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "chat-template",
      chatTemplateKwargs: {enable_thinking: {$var: "thinking.enabled"}},
    },
  };
}

const reason = (error: unknown): string => {
  const cause = (error as {cause?: {code?: string; message?: string}})?.cause;
  return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
};

/** The models `server`'s server at `baseUrl` lists, or why it could not say. */
export async function listServer(server: Server, baseUrl: string, key: string | undefined, signal: AbortSignal): Promise<Model<"openai-completions">[]> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {headers: key ? {Authorization: `Bearer ${key}`} : {}, signal});
  } catch (error) {
    const timedOut = signal.aborted;
    throw new Error(`Could not reach the ${server.name} server at ${baseUrl}: ${timedOut ? `no answer within ${LIST_TIMEOUT_MS / 1000}s` : reason(error)}`);
  }
  if (!response.ok) {
    const refused = key ? `${server.keyEnv} is not the key it was started with` : `it was started with a key (--api-key), which goes in ${server.keyEnv}`;
    const hint = response.status === 401 ? `: ${refused}` : response.status === 404 ? ": is this its /v1 address?" : "";
    throw new Error(`The ${server.name} server at ${baseUrl} answered ${response.status} to GET /models${hint}`);
  }
  const listing = await response.json().catch(() => null) as {data?: unknown} | null;
  if (!Array.isArray(listing?.data)) throw new Error(`The ${server.name} server at ${baseUrl} lists no models at GET /models`);
  return listing.data
    .filter((entry): entry is {id: string; max_model_len?: unknown} => typeof entry?.id === "string" && entry.id !== "")
    .map((entry) => servedModel(server, baseUrl, entry));
}

/**
 * Whether `server`'s server at `baseUrl` parses tool calls, as it says at its `infoPath` beside its
 * /v1; null for a server that does not say.
 */
export async function toolCalling(server: Server, baseUrl: string, key: string | undefined, signal: AbortSignal): Promise<boolean | null> {
  if (!server.infoPath || !baseUrl.endsWith("/v1")) return null;
  try {
    const response = await fetch(`${baseUrl.slice(0, -"/v1".length)}${server.infoPath}`, {headers: key ? {Authorization: `Bearer ${key}`} : {}, signal});
    const info = response.ok ? await response.json() as Record<string, unknown> | null : null;
    return info && typeof info === "object" && "tool_call_parser" in info ? Boolean(info.tool_call_parser) : null;
  } catch {
    return null;
  }
}

/**
 * `server`'s provider, configured while `env` names its server, whose models are what that server
 * lists; `listed` hears whether it parses tool calls each time it lists them.
 */
export function serverProvider(server: Server, env: NodeJS.ProcessEnv, listed: (tools: boolean | null) => void = () => {}): Provider<"openai-completions"> {
  const baseUrl = serverUrl(server, env);
  const key = env[server.keyEnv] || undefined;
  return createProvider<"openai-completions">({
    id: server.id,
    name: server.name,
    baseUrl,
    // A server started without --api-key takes any key, and the client needs one.
    auth: {apiKey: {name: `${server.name} server`, resolve: async () => (baseUrl ? {auth: {apiKey: key ?? "EMPTY"}, source: server.urlEnv} : undefined)}},
    models: [],
    fetchModels: async ({signal}) => {
      const served = await listServer(server, baseUrl!, key, signal);
      listed(await toolCalling(server, baseUrl!, key, signal));
      return served;
    },
    api: openAICompletionsApi(),
  });
}

/**
 * Add `servers`' providers to `models` and list the models of each one `env` names a server for:
 * what each such listing found (ServerListing), by provider id.
 */
export async function addServers(models: MutableModels, env: NodeJS.ProcessEnv, servers: readonly Server[] = SERVERS): Promise<Map<string, ServerListing>> {
  const tools = new Map<string, boolean | null>();
  for (const server of servers) models.setProvider(serverProvider(server, env, (value) => tools.set(server.id, value)));
  const {aborted, errors} = await models.refresh({providers: servers.map((server) => server.id), signal: AbortSignal.timeout(LIST_TIMEOUT_MS)});
  const listings = new Map<string, ServerListing>();
  for (const server of servers) {
    const url = serverUrl(server, env);
    if (!url) continue;
    let error = errors.get(server.id)?.message ?? null;
    // A refresh that ran out of time may return before a slow server's listing says so.
    if (!error && aborted && !models.getModels(server.id).length) {
      error = `Could not reach the ${server.name} server at ${url}: no answer within ${LIST_TIMEOUT_MS / 1000}s`;
    }
    listings.set(server.id, {error, tools: tools.get(server.id) ?? null});
  }
  return listings;
}

/**
 * One line of a server's event stream, with its usage's reasoning tokens where pi-ai reads them:
 * OpenAI's usage.completion_tokens_details.reasoning_tokens, where vLLM counts them. SGLang counts
 * them at usage.reasoning_tokens, which pi-ai would read as none.
 */
export function nestReasoningTokens(line: string): string {
  const data = /^data: ?(\{.*)$/.exec(line)?.[1];
  if (!data) return line;
  let chunk: {usage?: {reasoning_tokens?: unknown; completion_tokens_details?: Record<string, unknown> | null} | null};
  try {
    chunk = JSON.parse(data);
  } catch {
    return line;
  }
  const usage = chunk.usage;
  if (typeof usage?.reasoning_tokens !== "number" || usage.completion_tokens_details?.reasoning_tokens != null) return line;
  const details = {...usage.completion_tokens_details, reasoning_tokens: usage.reasoning_tokens};
  return `data: ${JSON.stringify({...chunk, usage: {...usage, completion_tokens_details: details}})}`;
}

/** fetch, with each line of an event stream it answers passed through nestReasoningTokens. */
export const serverFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const lines = (pending + decoder.decode(chunk, {stream: true})).split("\n");
      pending = lines.pop()!;
      if (lines.length) controller.enqueue(encoder.encode(`${lines.map(nestReasoningTokens).join("\n")}\n`));
    },
    flush(controller) {
      const rest = pending + decoder.decode();
      if (rest) controller.enqueue(encoder.encode(nestReasoningTokens(rest)));
    },
  }));
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {status: response.status, statusText: response.statusText, headers});
};

/**
 * How a run calls a server's model: with the run's own output limit or none, so the server leaves the
 * answer what its context does (pi-ai's own limit keeps 4096 tokens spare, which leaves a small
 * context next to nothing), its thinking level, which pi-ai's simple options call `reasoning` (none
 * when the run's is off), and serverFetch, so its usage counts SGLang's reasoning tokens.
 */
export function serverStreamOptions(streamOptions: SimpleStreamOptions | undefined, options: PiOptions): OpenAICompletionsOptions {
  const {reasoning, ...rest} = streamOptions ?? {};
  return {
    ...rest,
    maxTokens: options.maxTokens,
    ...(options.temperature === undefined ? {} : {temperature: options.temperature}),
    reasoningEffort: reasoning,
    fetch: serverFetch,
  };
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

export function parseOptions(value: Record<string, unknown> = {}): PiOptions {
  const provider = value.provider;
  const model = value.model;
  const apiKeyEnv = value.api_key_env;
  const thinkingLevel = value.thinking_level ?? "off";
  const systemPrompt = value.system_prompt ?? "You are a helpful assistant.";
  const awsRegion = value.aws_region;
  const awsProfile = value.aws_profile;
  const temperature = value.temperature;
  const maxTokens = value.max_tokens;
  if (typeof provider !== "string" || !provider) throw new Error("PI option 'provider' is required");
  if (typeof model !== "string" || !model) throw new Error("PI option 'model' is required");
  if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== "string" || !apiKeyEnv)) {
    throw new Error("PI option 'api_key_env' must be a non-empty string");
  }
  if (typeof thinkingLevel !== "string" || !THINKING_LEVELS.has(thinkingLevel as ThinkingLevel)) {
    throw new Error("PI option 'thinking_level' is invalid");
  }
  if (typeof systemPrompt !== "string") throw new Error("PI option 'system_prompt' must be a string");
  if (awsRegion !== undefined && (typeof awsRegion !== "string" || !awsRegion)) {
    throw new Error("PI option 'aws_region' must be a non-empty string");
  }
  if (awsProfile !== undefined && (typeof awsProfile !== "string" || !awsProfile)) {
    throw new Error("PI option 'aws_profile' must be a non-empty string");
  }
  if (temperature !== undefined && (typeof temperature !== "number" || temperature < 0 || temperature > 2)) {
    throw new Error("PI option 'temperature' must be a number from 0 to 2");
  }
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1)) {
    throw new Error("PI option 'max_tokens' must be a positive integer");
  }
  return {
    provider,
    model,
    apiKeyEnv: apiKeyEnv as string | undefined,
    thinkingLevel: thinkingLevel as ThinkingLevel,
    systemPrompt,
    awsRegion: awsRegion as string | undefined,
    awsProfile: awsProfile as string | undefined,
    temperature: temperature as number | undefined,
    maxTokens: maxTokens as number | undefined,
  };
}

export function usageFields(usage: Usage): {usage: Record<string, number>; cost: number} {
  const normalized: Record<string, number> = {
    // PI splits uncached input, cache reads, and cache writes. NanoAgent follows the
    // OpenAI convention where prompt_tokens is the full input and cached_tokens is a subset.
    prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
    completion_tokens: usage.output,
    total_tokens: usage.totalTokens,
    cached_tokens: usage.cacheRead,
    cache_write_tokens: usage.cacheWrite,
  };
  if (usage.cacheWrite1h !== undefined) normalized.cache_write_1h_tokens = usage.cacheWrite1h;
  if (usage.reasoning !== undefined) normalized.reasoning_tokens = usage.reasoning;
  return {
    usage: normalized,
    cost: usage.cost.total,
  };
}

export function messageText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<typeof part, {type: "text"}> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function promptText(request: RunnerRequest): string {
  const transcript = (request.messages ?? []).map((message, index) => {
    if (!message || typeof message !== "object") {
      throw new Error(`request.messages[${index}] must be an object`);
    }
    const row = message as {role?: unknown; content?: unknown};
    if (row.role !== "user" && row.role !== "assistant") {
      throw new Error(`request.messages[${index}] must have a user or assistant role`);
    }
    if (typeof row.content !== "string") {
      throw new Error(`request.messages[${index}].content must be a string`);
    }
    return `${row.role === "user" ? "User" : "Assistant"}:\n${row.content}`;
  });
  return transcript.length
    ? `Conversation history:\n\n${transcript.join("\n\n")}\n\nCurrent user request:\n${request.input}`
    : request.input;
}

function write(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function readEnvelope(): Promise<Envelope> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString();
  const value = JSON.parse(input.trim()) as Envelope;
  if (!value || value.protocol !== "nanoagent.runner.v1" || typeof value.request !== "object") {
    throw new Error("unsupported runner protocol");
  }
  if (typeof value.request.input !== "string" || !value.request.input.trim()) {
    throw new Error("request.input must be a non-empty string");
  }
  return value;
}

async function main(): Promise<void> {
  let agent: Agent | undefined;
  try {
    const envelope = await readEnvelope();
    const options = parseOptions(envelope.options);
    if (options.awsRegion) process.env.AWS_REGION = options.awsRegion;
    if (options.awsProfile) process.env.AWS_PROFILE = options.awsProfile;
    const models = builtinModels();
    const server = serverOf(options.provider);
    if (server) {
      const url = serverUrl(server, process.env);
      if (!url) throw new Error(`No ${server.name} server is set (${server.urlEnv}): add one to run ${options.model}`);
      const failed = (await addServers(models, process.env, [server])).get(server.id)?.error;
      if (failed) throw new Error(failed);
      if (!models.getModel(server.id, options.model)) {
        const served = models.getModels(server.id).map((entry) => entry.id).join(", ") || "no model";
        throw new Error(`The ${server.name} server at ${url} does not serve ${options.model}; it serves ${served}`);
      }
    }
    const model = models.getModel(options.provider, options.model);
    if (!model) throw new Error(`PI model not found: ${options.provider}/${options.model}`);
    // pi-ai's own error for a provider with no key says only that it is "not configured".
    const keyed = options.apiKeyEnv
      ? Boolean(process.env[options.apiKeyEnv])
      : (await models.getAvailable()).some((available) => available.provider === model.provider);
    if (!keyed) {
      const provider = models.getProviders().find((entry) => entry.id === model.provider)?.name ?? model.provider;
      throw new Error(`No ${provider} API key is set${options.apiKeyEnv ? ` (${options.apiKeyEnv})` : ""}: add one to run ${model.name}`);
    }
    const instructions = envelope.request.instructions?.trim();
    const systemPrompt = instructions
      ? `${options.systemPrompt.trim()}\n\nApplication instructions:\n${instructions}`
      : options.systemPrompt;
    agent = new Agent({
      initialState: {systemPrompt, model, thinkingLevel: options.thinkingLevel, tools: []},
      // The run's sampling settings go with every model call.
      streamFn: server
        ? (callModel, context, streamOptions) => models.stream(callModel, context, serverStreamOptions(streamOptions, options))
        : (callModel, context, streamOptions) => models.streamSimple(callModel, context, {
          ...streamOptions,
          ...(options.temperature === undefined ? {} : {temperature: options.temperature}),
          ...(options.maxTokens === undefined ? {} : {maxTokens: options.maxTokens}),
        }),
      getApiKey: options.apiKeyEnv ? () => process.env[options.apiKeyEnv!] : undefined,
    });
    process.once("SIGTERM", () => agent?.abort());

    let steps = 0;
    let lastUsage: Usage | undefined;
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          write({type: "delta", kind: "content", text: update.delta});
        } else if (update.type === "thinking_delta") {
          write({type: "delta", kind: "reasoning", text: update.delta});
        }
      } else if (event.type === "turn_end" && event.message.role === "assistant") {
        steps += 1;
        lastUsage = event.message.usage;
      }
    });

    await agent.prompt(promptText(envelope.request));
    const final = [...agent.state.messages].reverse().find(
      (message): message is AssistantMessage => message.role === "assistant",
    );
    if (!final) throw new Error("PI completed without an assistant message");
    if (final.stopReason === "error" || final.stopReason === "aborted") {
      write({type: "error", code: `pi_${final.stopReason}`, error: final.errorMessage ?? final.stopReason});
      return;
    }
    const normalized = usageFields(lastUsage ?? final.usage);
    write({
      type: "done",
      answer: messageText(final),
      stop_reason: final.stopReason === "stop" ? "answer" : final.stopReason,
      steps,
      ...normalized,
      error: null,
    });
  } catch (error) {
    write({type: "error", code: "pi_error", error: error instanceof Error ? error.message : String(error)});
  }
}

/**
 * The models PI can run, as models.js prints them: every provider (with whether this environment
 * holds its credentials) and every model with its context, output limit, reasoning support and
 * price per million tokens. NanoAgent serves it as GET /v1/models. A server engine (SERVERS) is set
 * once `env` names its server, which it gives as `baseUrl`, with the models that server lists now
 * and the rest of what listing them found (ServerListing: `error`, `tools`); whether such a model
 * reasons is not known (null).
 */
export async function catalog(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const models = builtinModels();
  const listings = await addServers(models, env);
  const available = new Set((await models.getAvailable()).map((model) => model.provider));
  const entry = (model: Model<Api>) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: serverOf(model.provider) ? null : model.reasoning,
    cost: {input: model.cost.input, output: model.cost.output},
  });
  return {
    providers: models.getProviders().map((provider) => {
      const server = serverOf(provider.id);
      if (!server) return {id: provider.id, name: provider.name, keySet: available.has(provider.id)};
      const baseUrl = serverUrl(server, env) ?? null;
      const listing = listings.get(provider.id);
      return {id: provider.id, name: provider.name, keySet: baseUrl !== null, baseUrl, error: listing?.error ?? null, tools: listing?.tools ?? null};
    }),
    models: models.getModels().map(entry),
  };
}

/** Whether this module is the program node was asked to run (as a URL its path is escaped). */
export function isMain(url: string): boolean {
  return Boolean(process.argv[1]) && realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]);
}

if (isMain(import.meta.url)) await main();
