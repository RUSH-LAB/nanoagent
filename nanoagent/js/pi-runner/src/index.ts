#!/usr/bin/env node

import {Agent, type AgentEvent, type ThinkingLevel} from "@earendil-works/pi-agent-core";
import type {Api, AssistantMessage, Model, Usage} from "@earendil-works/pi-ai";
import {setBedrockProviderModule} from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import {bedrockProviderModule} from "@earendil-works/pi-ai/bedrock-provider";
import {builtinModels} from "@earendil-works/pi-ai/providers/all";
import {createCodingTools} from "@earendil-works/pi-coding-agent";
import {realpathSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {Profiler} from "./profile.js";

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
  // "coding": PI's own coding tools (read, bash, edit, write) in the request's workspace; else none.
  tools?: "coding";
}

// The runner ships as one bundle (build.mjs), so Bedrock's implementation is bundled rather than
// imported at run time from a file of pi-ai's that is not there.
setBedrockProviderModule(bedrockProviderModule);

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
  const tools = value.tools;
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
  if (tools !== undefined && tools !== "coding") throw new Error("PI option 'tools' must be 'coding' when set");
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
    tools,
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

/** PI's coding tools in the request's workspace, when the options ask for them. */
function codingTools(options: PiOptions, request: RunnerRequest) {
  if (options.tools !== "coding") return [];
  if (!request.workspace) throw new Error("PI's coding tools need request.workspace");
  return createCodingTools(request.workspace);
}

/** The text of a tool's result. */
function resultText(result: {content?: {type: string; text?: string}[]} | undefined): string {
  return (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
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
      initialState: {systemPrompt, model, thinkingLevel: options.thinkingLevel, tools: codingTools(options, envelope.request)},
      // The run's sampling settings go with every model call.
      streamFn: (callModel, context, streamOptions) => models.streamSimple(callModel, context, {
        ...streamOptions,
        ...(options.temperature === undefined ? {} : {temperature: options.temperature}),
        ...(options.maxTokens === undefined ? {} : {maxTokens: options.maxTokens}),
      }),
      getApiKey: options.apiKeyEnv ? () => process.env[options.apiKeyEnv!] : undefined,
    });
    process.once("SIGTERM", () => agent?.abort());

    const profiler = new Profiler();
    const passed = (step: Record<string, unknown> | undefined) => {
      if (step) write({type: "step", step: step.step, cost: 0, usage: step.usage, metrics: step});
    };
    const toolArguments = new Map<string, unknown>();
    let cost = 0;
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "turn_start") {
        passed(profiler.modelStart());
      } else if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
          profiler.firstToken();
        }
        if (update.type === "text_delta") {
          write({type: "delta", kind: "content", text: update.delta});
        } else if (update.type === "thinking_delta") {
          write({type: "delta", kind: "reasoning", text: update.delta});
        }
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message;
        const failed = message.stopReason === "error" || message.stopReason === "aborted";
        profiler.modelEnd(usageFields(message.usage).usage, failed ? message.errorMessage ?? message.stopReason : null);
        cost += message.usage.cost.total;
      } else if (event.type === "tool_execution_start") {
        toolArguments.set(event.toolCallId, event.args);
        profiler.toolStart(event.toolCallId, event.toolName);
        write({type: "tool_start", id: event.toolCallId, name: event.toolName});
      } else if (event.type === "tool_execution_end") {
        profiler.toolEnd(event.toolCallId, event.isError);
        write({
          type: "tool",
          id: event.toolCallId,
          name: event.toolName,
          arguments: toolArguments.get(event.toolCallId) ?? {},
          output: resultText(event.result),
          is_error: event.isError,
        });
      } else if (event.type === "turn_end") {
        passed(profiler.close());
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
    const profile = profiler.finish();
    write({
      type: "done",
      answer: messageText(final),
      stop_reason: final.stopReason === "stop" ? "answer" : final.stopReason,
      steps: (profile.steps as unknown[]).length,
      usage: profile.usage,
      cost,
      error: null,
      metrics: {...profile, reported: {cost}},
    });
  } catch (error) {
    write({type: "error", code: "pi_error", error: error instanceof Error ? error.message : String(error)});
  }
}

/**
 * The models PI can run, as models.js prints them: every provider (with whether this environment
 * holds its credentials) and every model with its context, output limit, reasoning support and
 * price per million tokens. NanoAgent serves it as GET /v1/models.
 */
export async function catalog(): Promise<Record<string, unknown>> {
  const models = builtinModels();
  const available = new Set((await models.getAvailable()).map((model) => model.provider));
  const entry = (model: Model<Api>) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    cost: {input: model.cost.input, output: model.cost.output},
  });
  return {
    providers: models.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      keySet: available.has(provider.id),
    })),
    models: models.getModels().map(entry),
  };
}

/** Whether this module is the program node was asked to run (as a URL its path is escaped). */
export function isMain(url: string): boolean {
  return Boolean(process.argv[1]) && realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]);
}

if (isMain(import.meta.url)) await main();
