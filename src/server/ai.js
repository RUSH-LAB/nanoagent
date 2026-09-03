'use strict';

const fallbackProfiles = require('../ai-profiles.json');

/**
 * Mochi's private connection to NanoAgent.
 *
 * The browser never talks to NanoAgent and never receives its bearer token.
 * Routes pass trusted workspace-agent instructions and user conversation data
 * through this module; model choice, credentials, tools, and execution budgets
 * remain entirely in NanoAgent's server-owned YAML configuration.
 */

const DEFAULT_URL = 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 190_000;
const DEFAULT_MAX_STREAM_BYTES = 2 * 1024 * 1024;
const DEFAULT_PROFILE_CACHE_MS = 30_000;
const DEFAULT_PROFILE_TIMEOUT_MS = 5_000;
const CANCELLED = 'The AI request was cancelled.';
const TIMED_OUT = 'The AI request timed out. Please try again.';
const UNAVAILABLE = 'Could not reach NanoAgent.';
const DEFAULT_PROFILE = fallbackProfiles.defaultProfile;
const DEFAULT_MODEL = fallbackProfiles.profiles.find(profile => profile.id === DEFAULT_PROFILE).model;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function endpointFrom(env) {
  const configured = env.NANOAGENT_URL || DEFAULT_URL;
  if (configured === 'off') return {error: 'The AI assistant is switched off (NANOAGENT_URL=off).'};
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return {url: url.toString().replace(/\/$/, '')};
  } catch {
    return {error: 'NANOAGENT_URL must be a valid HTTP or HTTPS URL.'};
  }
}

function createLineParser(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
    },
    end() {
      if (!buffer) return;
      const line = buffer;
      buffer = '';
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    },
  };
}

/** Parse fragmented SSE frames and fail closed on malformed NanoAgent events. */
function createSseParser(onEvent) {
  let data = [];
  const dispatch = () => {
    if (!data.length) return;
    const raw = data.join('\n');
    data = [];
    if (!raw || raw === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      const error = new Error('NanoAgent returned an invalid event.');
      error.code = 'invalid_event';
      throw error;
    }
    onEvent(event);
  };
  const lines = createLineParser(line => {
    if (!line) return dispatch();
    if (line.startsWith(':')) return;
    if (line === 'data') data.push('');
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  });
  return {
    push: chunk => lines.push(chunk),
    end() {
      lines.end();
      dispatch();
    },
  };
}

function nanoRequest(request) {
  return {
    input: String(request.input ?? request.prompt ?? ''),
    messages: Array.isArray(request.messages) ? request.messages.map(message => ({
      role: message.role,
      content: String(message.content ?? ''),
      ...(message.role === 'tool' && message.tool_call_id ? {tool_call_id: message.tool_call_id} : {}),
    })) : [],
    ...(request.instructions || request.system ? {instructions: request.instructions || request.system} : {}),
    ...(request.metadata ? {metadata: request.metadata} : {}),
    ...(request.profile ? {profile: request.profile} : {}),
  };
}

function normalizeProfileCatalog(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.profiles)) {
    throw new Error('NanoAgent returned an invalid profile catalog.');
  }
  const profiles = value.profiles.map(profile => {
    if (!profile || typeof profile !== 'object'
      || typeof profile.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(profile.id)
      || typeof profile.label !== 'string' || !profile.label
      || typeof profile.harness !== 'string' || !profile.harness
      || typeof profile.model !== 'string' || !profile.model) {
      throw new Error('NanoAgent returned an invalid profile catalog.');
    }
    const capabilities = profile.capabilities && typeof profile.capabilities === 'object'
      ? Object.fromEntries(['streaming', 'reasoning', 'tools', 'usage', 'cancellation', 'history']
        .map(key => [key, profile.capabilities[key] === true]))
      : {};
    return {
      id: profile.id,
      label: profile.label,
      harness: profile.harness,
      model: profile.model,
      available: profile.available !== false,
      unavailableReason: typeof profile.unavailableReason === 'string' ? profile.unavailableReason : null,
      capabilities,
    };
  });
  const ids = new Set(profiles.map(profile => profile.id));
  if (profiles.length === 0 || ids.size !== profiles.length || !ids.has(value.defaultProfile)) {
    throw new Error('NanoAgent returned an invalid profile catalog.');
  }
  return {defaultProfile: value.defaultProfile, profiles};
}

function unavailableFallback(reason) {
  return {
    defaultProfile: fallbackProfiles.defaultProfile,
    profiles: fallbackProfiles.profiles.map(profile => ({
      ...profile,
      available: false,
      unavailableReason: reason,
      capabilities: {},
    })),
  };
}

function statusForCode(code) {
  if (code === 'cancelled') return 499;
  if (code === 'timeout') return 504;
  if (code === 'capacity') return 503;
  if (code === 'runner_unavailable') return 503;
  return 502;
}

async function responseError(response) {
  try {
    const body = await response.json();
    if (typeof body?.error === 'string' && body.error) return body.error;
  } catch {
    // A proxy may return HTML or an empty body; the status is still useful.
  }
  return `NanoAgent request failed (${response.status}).`;
}

function publicEvent(event) {
  const runId = typeof event?.runId === 'string' ? event.runId : null;
  if (event?.type === 'start') return {type: 'run.started', runId};
  if (event?.type === 'step') {
    return {type: 'step.completed', runId, step: event.step, usage: event.usage ?? null, cost: event.cost ?? null};
  }
  if (event?.type === 'tool') {
    return {
      type: event.is_error ? 'tool.failed' : 'tool.completed',
      runId,
      call: {id: event.id ?? null, name: event.name ?? 'unknown'},
    };
  }
  if (event?.type === 'done') {
    return {
      type: 'run.completed', runId, stopReason: event.stop_reason,
      steps: event.steps, usage: event.usage ?? null, cost: event.cost ?? null,
    };
  }
  if (event?.type === 'error') return {type: 'run.failed', runId, code: event.code};
  return null;
}

function createNanoAgentGateway({env = process.env, fetchImpl = (...args) => fetch(...args)} = {}) {
  const timeoutMs = positiveNumber(env.NANOAGENT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxStreamBytes = positiveNumber(env.NANOAGENT_MAX_STREAM_BYTES, DEFAULT_MAX_STREAM_BYTES);
  const profileCacheMs = positiveNumber(env.NANOAGENT_PROFILE_CACHE_MS, DEFAULT_PROFILE_CACHE_MS);
  const profileTimeoutMs = positiveNumber(
    env.NANOAGENT_PROFILE_TIMEOUT_MS,
    DEFAULT_PROFILE_TIMEOUT_MS,
  );
  let profileCache = null;
  let profilePromise = null;

  async function profiles({refresh = false} = {}) {
    const endpoint = endpointFrom(env);
    if (endpoint.error) return unavailableFallback(endpoint.error);
    const now = Date.now();
    if (!refresh && profileCache && profileCache.expiresAt > now) return profileCache.value;
    if (!refresh && profilePromise) return profilePromise;
    profilePromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), profileTimeoutMs);
      try {
        const response = await fetchImpl(`${endpoint.url}/v1/profiles`, {
          headers: env.NANOAGENT_API_TOKEN
            ? {Authorization: `Bearer ${env.NANOAGENT_API_TOKEN}`}
            : {},
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await responseError(response));
        const value = normalizeProfileCatalog(await response.json());
        profileCache = {value, expiresAt: Date.now() + profileCacheMs};
        return value;
      } catch (error) {
        const value = profileCache?.value
          ?? unavailableFallback(error instanceof Error ? error.message : UNAVAILABLE);
        profileCache = {value, expiresAt: Date.now() + Math.min(profileCacheMs, 5_000)};
        return value;
      } finally {
        clearTimeout(timer);
        profilePromise = null;
      }
    })();
    return profilePromise;
  }

  async function stream(request = {}) {
    const endpoint = endpointFrom(env);
    if (endpoint.error) return {error: endpoint.error, status: 503};
    if (request.signal?.aborted) return {error: CANCELLED, status: 499};

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, {once: true});
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let reader;
    try {
      const response = await fetchImpl(`${endpoint.url}/v1/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(env.NANOAGENT_API_TOKEN ? {Authorization: `Bearer ${env.NANOAGENT_API_TOKEN}`} : {}),
        },
        body: JSON.stringify(nanoRequest(request)),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {error: await responseError(response), status: response.status === 429 ? 503 : 502};
      }
      reader = response.body?.getReader?.();
      if (!reader) return {error: 'NanoAgent returned no response stream.', status: 502};

      let bytes = 0;
      let text = '';
      let terminal = null;
      const parser = createSseParser(event => {
        if (!event || typeof event.type !== 'string') {
          const error = new Error('NanoAgent returned an invalid event.');
          error.code = 'invalid_event';
          throw error;
        }
        if (terminal) return;
        if (event.type === 'delta' && event.kind === 'content' && typeof event.text === 'string') {
          text += event.text;
          request.onDelta?.(event.text);
          request.onEvent?.({type: 'output_text.delta', runId: event.runId ?? null, text: event.text});
          return;
        }
        if (event.type === 'done' || event.type === 'error') terminal = event;
        const normalized = publicEvent(event);
        if (normalized) request.onEvent?.(normalized);
      });

      const decoder = new TextDecoder();
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxStreamBytes) {
          controller.abort();
          return {error: 'The NanoAgent event stream was too large.', status: 502};
        }
        parser.push(decoder.decode(value, {stream: true}));
      }
      parser.push(decoder.decode());
      parser.end();

      if (!terminal) return {error: 'NanoAgent closed the stream before completing the run.', status: 502};
      if (terminal.type === 'error') {
        return {error: terminal.error || 'NanoAgent could not complete the run.', status: statusForCode(terminal.code)};
      }
      if (terminal.error) return {error: terminal.error, status: 502};
      return {
        text: typeof terminal.answer === 'string' && terminal.answer ? terminal.answer : (text || 'No response generated'),
        profile: terminal.profile ?? request.profile ?? null,
        harness: terminal.harness ?? null,
        model: terminal.model ?? null,
        usage: terminal.usage ?? null,
        cost: terminal.cost ?? null,
        stopReason: terminal.stop_reason ?? null,
        runId: terminal.runId ?? null,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        if (request.signal?.aborted) return {error: CANCELLED, status: 499};
        if (timedOut) return {error: TIMED_OUT, status: 504};
      }
      if (error?.code === 'invalid_event') return {error: error.message, status: 502};
      return {error: UNAVAILABLE, status: 502};
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      reader?.releaseLock?.();
    }
  }

  return Object.freeze({
    complete: request => stream({...request, onDelta: undefined}),
    stream,
    profiles,
    describe() {
      const endpoint = endpointFrom(env);
      if (endpoint.error) return {available: false, reason: endpoint.error};
      return {available: true, provider: 'nanoagent', profile: DEFAULT_PROFILE, model: DEFAULT_MODEL};
    },
  });
}

const gateway = createNanoAgentGateway();

module.exports = {
  DEFAULT_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_STREAM_BYTES,
  DEFAULT_PROFILE_CACHE_MS,
  DEFAULT_PROFILE_TIMEOUT_MS,
  DEFAULT_PROFILE,
  DEFAULT_MODEL,
  CANCELLED,
  TIMED_OUT,
  createSseParser,
  endpointFrom,
  nanoRequest,
  normalizeProfileCatalog,
  publicEvent,
  createNanoAgentGateway,
  complete: gateway.complete,
  stream: gateway.stream,
  profiles: gateway.profiles,
  describe: gateway.describe,
};
