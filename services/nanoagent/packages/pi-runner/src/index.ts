#!/usr/bin/env node

import {Agent, type AgentEvent, type ThinkingLevel} from "@earendil-works/pi-agent-core";
import type {AssistantMessage, Usage} from "@earendil-works/pi-ai";
import {builtinModels} from "@earendil-works/pi-ai/providers/all";

interface RunnerRequest {
  input: string;
  messages?: unknown[];
  instructions?: string | null;
  metadata?: Record<string, unknown> | null;
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
  if (typeof provider !== "string" || !provider) throw new Error("PI option 'provider' is required");
  if (typeof model !== "string" || !model) throw new Error("PI option 'model' is required");
  if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== "string" || !apiKeyEnv)) {
    throw new Error("PI option 'api_key_env' must be a non-empty string");
  }
  if (typeof thinkingLevel !== "string" || !THINKING_LEVELS.has(thinkingLevel as ThinkingLevel)) {
    throw new Error("PI option 'thinking_level' is invalid");
  }
  if (typeof systemPrompt !== "string") throw new Error("PI option 'system_prompt' must be a string");
  return {
    provider,
    model,
    apiKeyEnv: apiKeyEnv as string | undefined,
    thinkingLevel: thinkingLevel as ThinkingLevel,
    systemPrompt,
  };
}

export function usageFields(usage: Usage): {usage: Record<string, number>; cost: number} {
  return {
    usage: {
      prompt_tokens: usage.input,
      completion_tokens: usage.output,
      total_tokens: usage.totalTokens,
    },
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
    const models = builtinModels();
    const model = models.getModel(options.provider, options.model);
    if (!model) throw new Error(`PI model not found: ${options.provider}/${options.model}`);
    const instructions = envelope.request.instructions?.trim();
    const systemPrompt = instructions
      ? `${options.systemPrompt.trim()}\n\nApplication instructions:\n${instructions}`
      : options.systemPrompt;
    agent = new Agent({
      initialState: {systemPrompt, model, thinkingLevel: options.thinkingLevel, tools: []},
      streamFn: models.streamSimple.bind(models),
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

if (import.meta.url === `file://${process.argv[1]}`) await main();
