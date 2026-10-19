'use strict';

const fallbackProfiles = require('../ai-profiles.json');

/**
 * RUSH's private connection to NanoAgent.
 *
 * The browser never talks to NanoAgent and never receives its bearer token.
 * Routes pass trusted workspace-agent instructions and user conversation data
 * through this module; model choice, credentials, tools, and execution budgets
 * remain entirely in NanoAgent's server-owned YAML configuration.
 */

const DEFAULT_URL = 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 190_000;
// NanoAgent's own bound on building a plugin's environment (nanoagent.plugin.install), and then some.
const INSTALL_TIMEOUT_MS = 620_000;
// A run streams its reasoning, every task's progress and each fragment as its own event.
const DEFAULT_MAX_STREAM_BYTES = 16 * 1024 * 1024;
const DEFAULT_PROFILE_CACHE_MS = 30_000;
const DEFAULT_PROFILE_TIMEOUT_MS = 5_000;
const CANCELLED = 'The AI request was cancelled.';
const TIMED_OUT = 'The AI request timed out. Please try again.';
const UNAVAILABLE = 'Could not reach NanoAgent.';
const RUNNER_OFFLINE = 'RUSH Lab on your computer is not connected. Install it from Settings → Connection, or start it again, to run your AI.';
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
    ...(request.model ? {model: request.model} : {}),
    ...(request.settings ? {settings: request.settings} : {}),
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
      || typeof profile.model !== 'string' || !profile.model
      || !Array.isArray(profile.uses) || profile.uses.some(use => typeof use !== 'string')) {
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
      provider: typeof profile.provider === 'string' ? profile.provider : null,
      providerName: typeof profile.providerName === 'string' ? profile.providerName : null,
      model: profile.model,
      // What it is for (chat, inline, apps), and what is known of it.
      uses: profile.uses,
      price: profile.price && typeof profile.price === 'object'
        ? {input: metricNumber(profile.price.input), output: metricNumber(profile.price.output)}
        : null,
      contextWindow: metricNumber(profile.contextWindow),
      reasoning: typeof profile.reasoning === 'boolean' ? profile.reasoning : null,
      available: profile.available !== false,
      unavailableReason: typeof profile.unavailableReason === 'string' ? profile.unavailableReason : null,
      capabilities,
    };
  });
  const ids = new Set(profiles.map(profile => profile.id));
  if (profiles.length === 0 || ids.size !== profiles.length || !ids.has(value.defaultProfile)) {
    throw new Error('NanoAgent returned an invalid profile catalog.');
  }
  const limits = value.limits && typeof value.limits === 'object' ? {
    max_steps: metricNumber(value.limits.max_steps),
    cost_limit: metricNumber(value.limits.cost_limit),
    token_limit: metricNumber(value.limits.token_limit),
    max_tokens: metricNumber(value.limits.max_tokens),
    capped: value.limits.capped !== false,
  } : null;
  return {defaultProfile: value.defaultProfile, profiles, limits};
}

function unavailableFallback(reason) {
  return {
    defaultProfile: fallbackProfiles.defaultProfile,
    profiles: fallbackProfiles.profiles.map(profile => ({
      ...profile,
      price: null,
      contextWindow: null,
      reasoning: null,
      available: false,
      unavailableReason: reason,
      capabilities: {},
    })),
    limits: null,
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

function metricNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function publicUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = {};
  for (const key of [
    'prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens',
    'cache_write_tokens', 'cache_write_1h_tokens', 'reasoning_tokens',
  ]) {
    if (Number.isInteger(value[key]) && value[key] >= 0) usage[key] = value[key];
  }
  return usage;
}

/** Keep performance/accounting data while dropping model/tool error text from the public API. */
function publicStepMetrics(value) {
  if (!value || typeof value !== 'object') return null;
  const modelCall = call => ({
    kind: typeof call?.kind === 'string' ? call.kind : 'agent',
    duration_s: metricNumber(call?.duration_s),
    ttft_s: metricNumber(call?.ttft_s),
    generation_s: metricNumber(call?.generation_s),
    output_tokens_per_second: metricNumber(call?.output_tokens_per_second),
    usage: publicUsage(call?.usage),
    cost: metricNumber(call?.cost),
    failed: Boolean(call?.error),
  });
  const toolCall = call => ({
    name: typeof call?.name === 'string' ? call.name : 'unknown',
    duration_s: metricNumber(call?.duration_s),
    is_error: call?.is_error === true,
  });
  return {
    step: Number.isInteger(value.step) ? value.step : null,
    duration_s: metricNumber(value.duration_s),
    model_s: metricNumber(value.model_s),
    tools_s: metricNumber(value.tools_s),
    overhead_s: metricNumber(value.overhead_s),
    usage: publicUsage(value.usage),
    cost: metricNumber(value.cost),
    model_calls: Array.isArray(value.model_calls) ? value.model_calls.map(modelCall) : [],
    tool_calls: Array.isArray(value.tool_calls) ? value.tool_calls.map(toolCall) : [],
  };
}

function publicMetrics(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    duration_s: metricNumber(value.duration_s),
    model_s: metricNumber(value.model_s),
    tools_s: metricNumber(value.tools_s),
    overhead_s: metricNumber(value.overhead_s),
    ttft_s: metricNumber(value.ttft_s),
    generation_s: metricNumber(value.generation_s),
    usage: publicUsage(value.usage),
    cost: metricNumber(value.cost),
    steps: Array.isArray(value.steps) ? value.steps.map(publicStepMetrics).filter(Boolean) : [],
  };
}

/**
 * A run event as the browser may see it. A tool call's arguments and output stay
 * private, except on an app run (`install`): that app's own page shows them to the
 * person who ran it, on the files of their own workspace.
 */
function publicEvent(event, {app = false} = {}) {
  const runId = typeof event?.runId === 'string' ? event.runId : null;
  if (event?.type === 'start') return {type: 'run.started', runId};
  if (event?.type === 'step') {
    const metrics = publicStepMetrics(event.metrics);
    return {
      type: 'step.completed', runId, step: event.step,
      usage: publicUsage(event.usage), cost: metricNumber(event.cost),
      ...(metrics ? {metrics} : {}),
    };
  }
  if (event?.type === 'tool_start') {
    return {type: 'tool.started', runId, call: {id: event.id ?? null, name: event.name ?? 'unknown'}};
  }
  // What a tool reports while it runs is the app's own: a plugin task's progress.
  if (event?.type === 'tool_progress' && app) {
    return {
      type: 'tool.progress', runId,
      call: {id: event.id ?? null, name: event.name ?? 'unknown'},
      event: event.event, data: event.data ?? null,
    };
  }
  if (event?.type === 'tool') {
    return {
      type: event.is_error ? 'tool.failed' : 'tool.completed',
      runId,
      call: {
        id: event.id ?? null,
        name: event.name ?? 'unknown',
        ...(app ? {arguments: event.arguments ?? null, output: event.output ?? null} : {}),
      },
    };
  }
  // A plugin run's provenance graph: each change as it is made, then the whole graph.
  if (event?.type === 'graph' && app) {
    return event.patch ? {type: 'graph.patch', runId, patch: event.patch} : {type: 'graph.completed', runId, graph: event.graph};
  }
  // What the run's model saw and did, as an ATIF trajectory, once it ends.
  if (event?.type === 'trajectory' && app) return {type: 'trajectory.completed', runId, trajectory: event.trajectory};
  if (event?.type === 'done') {
    const metrics = publicMetrics(event.metrics);
    return {
      type: 'run.completed', runId, stopReason: event.stop_reason,
      steps: event.steps, usage: publicUsage(event.usage), cost: metricNumber(event.cost),
      ...(metrics ? {metrics} : {}),
    };
  }
  if (event?.type === 'error') return {type: 'run.failed', runId, code: event.code};
  return null;
}

/** What the browser is told of a finished run. */
function completionPayload(result) {
  return {
    text: result.text,
    ...(result.usage ? {usage: result.usage} : {}),
    ...(result.cost != null ? {cost: result.cost} : {}),
    ...(result.metrics ? {metrics: result.metrics} : {}),
    ...(result.model ? {model: result.model} : {}),
    ...(result.harness ? {harness: result.harness} : {}),
    ...(result.profile ? {profile: result.profile} : {}),
    ...(result.stopReason ? {stopReason: result.stopReason} : {}),
  };
}

/**
 * `endpoint` replaces NANOAGENT_URL: `{url}` for a NanoAgent reached some other
 * way (a member's own computer, through `fetchImpl`), `{error}` for one that is
 * not there. `local` marks a gateway to the member's own NanoAgent.
 */
function createNanoAgentGateway({env = process.env, fetchImpl = (...args) => fetch(...args), endpoint: fixed = null, local = false} = {}) {
  const endpointOf = () => fixed ?? endpointFrom(env);
  const timeoutMs = positiveNumber(env.NANOAGENT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const installTimeoutMs = INSTALL_TIMEOUT_MS;
  const maxStreamBytes = positiveNumber(env.NANOAGENT_MAX_STREAM_BYTES, DEFAULT_MAX_STREAM_BYTES);
  const profileCacheMs = positiveNumber(env.NANOAGENT_PROFILE_CACHE_MS, DEFAULT_PROFILE_CACHE_MS);
  const profileTimeoutMs = positiveNumber(
    env.NANOAGENT_PROFILE_TIMEOUT_MS,
    DEFAULT_PROFILE_TIMEOUT_MS,
  );
  let profileCache = null;
  let profilePromise = null;

  async function profiles({refresh = false} = {}) {
    const endpoint = endpointOf();
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
    const endpoint = endpointOf();
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
      // An app prompt runs on the agent of the plugin installed as `install`, inside
      // the caller's workspace; anything else on a configured profile.
      const path = request.install
        ? `/v1/workspaces/${encodeURIComponent(request.workspace)}/installs/${encodeURIComponent(request.install)}/runs`
        : '/v1/runs';
      const response = await fetchImpl(`${endpoint.url}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(env.NANOAGENT_API_TOKEN ? {Authorization: `Bearer ${env.NANOAGENT_API_TOKEN}`} : {}),
        },
        body: JSON.stringify(nanoRequest(request)),
        signal: controller.signal,
        // A plugin run held by the member's computer across its connections, on the member's
        // files there (server/runner.js).
        ...(request.run ? {run: request.run} : {}),
        ...(request.files ? {files: request.files} : {}),
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
        // An app's page shows its run thinking, like its tool calls (publicEvent).
        if (event.type === 'delta' && event.kind === 'reasoning' && request.install && typeof event.text === 'string') {
          request.onEvent?.({type: 'reasoning.delta', runId: event.runId ?? null, text: event.text});
          return;
        }
        if (event.type === 'done' || event.type === 'error') terminal = event;
        const normalized = publicEvent(event, {app: Boolean(request.install)});
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
        usage: publicUsage(terminal.usage),
        cost: metricNumber(terminal.cost),
        ...(terminal.metrics ? {metrics: publicMetrics(terminal.metrics)} : {}),
        stopReason: terminal.stop_reason ?? null,
        runId: terminal.runId ?? null,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        if (request.signal?.aborted) return {error: CANCELLED, status: 499};
        if (timedOut) return {error: TIMED_OUT, status: 504};
      }
      if (error?.code === 'invalid_event') return {error: error.message, status: 502};
      // The member's computer went away (server/runner.js), which says how.
      if (error?.code === 'runner') return {error: error.message, status: 503};
      return {error: UNAVAILABLE, status: 502};
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      reader?.releaseLock?.();
    }
  }

  /**
   * One call to NanoAgent's plugin API: `{value, headers}` (its
   * JSON, or its bytes when asked for), otherwise `{error, status}` to relay.
   */
  async function nanoFetch(path, {method = 'GET', body, contentType, bytes = false, waitMs = profileTimeoutMs} = {}) {
    const endpoint = endpointOf();
    if (endpoint.error) return {error: endpoint.error, status: 503};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs);
    try {
      const response = await fetchImpl(`${endpoint.url}${path}`, {
        method,
        headers: {
          ...(contentType ? {'Content-Type': contentType} : {}),
          ...(env.NANOAGENT_API_TOKEN ? {Authorization: `Bearer ${env.NANOAGENT_API_TOKEN}`} : {}),
        },
        ...(body === undefined ? {} : {body}),
        signal: controller.signal,
      });
      if (!response.ok) {
        // A rejected path, a missing file, a name already taken, a file too large or
        // a package that breaks the plugin rules is the caller's to know about;
        // anything else is ours.
        const status = [400, 404, 409, 413, 422].includes(response.status) ? response.status : 502;
        return {error: await responseError(response), status};
      }
      return {
        value: bytes ? Buffer.from(await response.arrayBuffer()) : await response.json(),
        headers: response.headers,
      };
    } catch {
      return controller.signal.aborted ? {error: TIMED_OUT, status: 504} : {error: UNAVAILABLE, status: 502};
    } finally {
      clearTimeout(timer);
    }
  }

  const encodedPath = path => String(path).split('/').map(encodeURIComponent).join('/');

  return Object.freeze({
    complete: request => stream({...request, onDelta: undefined}),
    stream,
    profiles,
    // Every model a run may name, on a member's own computer (NanoAgent's run_models).
    models: () => nanoFetch('/v1/models', {waitMs: timeoutMs}),
    // What the computer's OpenRouter key has spent, and may: {usage, limit} in dollars, as OpenRouter says.
    openrouterUsage: () => nanoFetch('/v1/keys/openrouter/usage', {waitMs: timeoutMs}),
    // Plugins run from installs, each the package with that sha256; NanoAgent
    // installs one when it is sent, and has none after it restarts.
    install: sha256 => nanoFetch(`/v1/installs/${encodeURIComponent(sha256)}`),
    installPackage: (sha256, data) => nanoFetch(`/v1/installs/${encodeURIComponent(sha256)}`, {
      method: 'PUT', body: data, contentType: 'application/gzip', waitMs: installTimeoutMs,
    }),
    // A package's page alone, for one NanoAgent refuses to install: nothing of it runs.
    viewPackage: (sha256, data) => nanoFetch(`/v1/views/${encodeURIComponent(sha256)}`, {
      method: 'PUT', body: data, contentType: 'application/gzip', waitMs: timeoutMs,
    }),
    installUiFile: (sha256, version, path) => nanoFetch(
      `/v1/installs/${encodeURIComponent(sha256)}/ui/${encodeURIComponent(version)}/${encodedPath(path)}`, {bytes: true},
    ),
    // The marketplace: NanoAgent's own plugin packages, and the package it packs
    // and checks from the plugin at `path` in a repository archive.
    packages: () => nanoFetch('/v1/packages'),
    packageFile: id => nanoFetch(`/v1/packages/${encodeURIComponent(id)}`, {bytes: true, waitMs: timeoutMs}),
    // Check a package without running it: its catalog entry, or 422 with why NanoAgent refuses it.
    // NanoAgent keeps each answer while it runs, by the package's sha256 (inspection, 404 until then).
    inspect: data => nanoFetch('/v1/packages/inspect', {method: 'POST', body: data, contentType: 'application/gzip', waitMs: timeoutMs}),
    inspection: sha256 => nanoFetch(`/v1/packages/inspect/${encodeURIComponent(sha256)}`),
    packageSource: (archive, path) => nanoFetch(`/v1/packages/source?path=${encodeURIComponent(path)}`, {
      method: 'POST', body: archive, contentType: 'application/gzip', waitMs: timeoutMs,
    }),
    describe() {
      const endpoint = endpointOf();
      if (endpoint.error) return {available: false, reason: endpoint.error};
      return {available: true, provider: 'nanoagent', profile: DEFAULT_PROFILE, model: DEFAULT_MODEL};
    },
    local,
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
  RUNNER_OFFLINE,
  completionPayload,
  createSseParser,
  endpointFrom,
  nanoRequest,
  normalizeProfileCatalog,
  publicMetrics,
  publicEvent,
  createNanoAgentGateway,
  complete: gateway.complete,
  stream: gateway.stream,
  profiles: gateway.profiles,
  models: gateway.models,
  openrouterUsage: gateway.openrouterUsage,
  install: gateway.install,
  installPackage: gateway.installPackage,
  installUiFile: gateway.installUiFile,
  viewPackage: gateway.viewPackage,
  packages: gateway.packages,
  packageFile: gateway.packageFile,
  packageSource: gateway.packageSource,
  inspection: gateway.inspection,
  inspect: gateway.inspect,
  describe: gateway.describe,
  local: gateway.local,
};
