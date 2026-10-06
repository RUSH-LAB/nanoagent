export type {Message, RunRequest} from "./request.generated";
import type {RunRequest} from "./request.generated";

export type {
  DeltaEvent,
  DoneEvent,
  ErrorEvent,
  RunEvent,
  StartEvent,
  StepEvent,
  ToolEvent,
} from "./events.generated";
import type {DoneEvent, RunEvent} from "./events.generated";

export interface Health {
  status: "ok" | string;
  service: "nanoagent" | string;
  apiVersion: "v1" | string;
  activeRuns: number;
  maxConcurrency: number;
  harness: string;
  capabilities: {
    streaming: boolean;
    reasoning: boolean;
    tools: boolean;
    usage: boolean;
    cancellation: boolean;
    history: boolean;
  };
}

export interface ProfileCapabilities {
  streaming: boolean;
  reasoning: boolean;
  tools: boolean;
  usage: boolean;
  cancellation: boolean;
  history: boolean;
}

export interface HarnessProfile {
  id: string;
  label: string;
  harness: string;
  model: string;
  available: boolean;
  unavailableReason: string | null;
  capabilities: ProfileCapabilities;
}

export interface ProfileCatalog {
  defaultProfile: string;
  profiles: HarnessProfile[];
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export interface StreamOptions {
  signal?: AbortSignal;
}

export class NanoAgentError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: {status?: number; code?: string} = {}) {
    super(message);
    this.name = "NanoAgentError";
    this.status = options.status;
    this.code = options.code;
  }
}

function frames(buffer: string): {complete: string[]; rest: string} {
  const complete: string[] = [];
  let rest = buffer;
  let boundary = rest.indexOf("\n\n");
  while (boundary !== -1) {
    complete.push(rest.slice(0, boundary));
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf("\n\n");
  }
  return {complete, rest};
}

function parseFrame(frame: string): RunEvent | null {
  const data: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(":")) continue;
    if (line === "data") data.push("");
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  try {
    return JSON.parse(data.join("\n")) as RunEvent;
  } catch {
    throw new NanoAgentError("NanoAgent returned an invalid event", {code: "invalid_event"});
  }
}

async function responseError(response: Response): Promise<NanoAgentError> {
  let message = `NanoAgent request failed (${response.status})`;
  try {
    const body = await response.json() as {error?: unknown};
    if (typeof body.error === "string") message = body.error;
  } catch {
    // The status remains actionable when a proxy returned HTML or an empty body.
  }
  return new NanoAgentError(message, {status: response.status});
}

export class NanoAgentClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    if (!options.baseUrl) throw new TypeError("baseUrl is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") throw new TypeError("fetch is not available");
  }

  private headers(json = false): HeadersInit {
    return {
      ...(json ? {"Content-Type": "application/json"} : {}),
      ...(this.token ? {Authorization: `Bearer ${this.token}`} : {}),
    };
  }

  async health(options: StreamOptions = {}): Promise<Health> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`, {signal: options.signal});
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<Health>;
  }

  async profiles(options: StreamOptions = {}): Promise<ProfileCatalog> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/profiles`, {
      headers: this.headers(),
      signal: options.signal,
    });
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<ProfileCatalog>;
  }

  async *stream(request: RunRequest, options: StreamOptions = {}): AsyncGenerator<RunEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/runs`, {
      method: "POST",
      headers: {...this.headers(true), Accept: "text/event-stream"},
      body: JSON.stringify(request),
      signal: options.signal,
    });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new NanoAgentError("NanoAgent returned no response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const {value, done} = await reader.read();
        buffer += decoder.decode(value, {stream: !done}).replace(/\r\n/g, "\n");
        const parsed = frames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.complete) {
          const event = parseFrame(frame);
          if (event) yield event;
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async run(request: RunRequest, options: StreamOptions = {}): Promise<DoneEvent> {
    for await (const event of this.stream(request, options)) {
      if (event.type === "error") {
        throw new NanoAgentError(event.error, {code: event.code});
      }
      if (event.type === "done") return event;
    }
    throw new NanoAgentError("NanoAgent stream ended before a result", {code: "incomplete_stream"});
  }

  async cancel(runId: string, options: StreamOptions = {}): Promise<boolean> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
      method: "DELETE",
      headers: this.headers(),
      signal: options.signal,
    });
    if (response.status === 404) return false;
    if (!response.ok) throw await responseError(response);
    return true;
  }
}
