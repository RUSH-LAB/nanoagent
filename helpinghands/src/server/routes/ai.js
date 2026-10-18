'use strict';
const fallbackProfiles = require('../../ai-profiles.json');
const {budgetRefusal} = require('../ai-metering');
const {completionPayload, RUNNER_OFFLINE} = require('../ai');
const aiSettings = require('../ai-settings');
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
//
// The assistant. Core, not a plugin: the CLI at the foot of every page talks to
// it, and a site whose assistant could be uninstalled would be a site whose
// front door sometimes answers 404. Which model replies, and whether over HTTP
// through the private NanoAgent service, is server/ai.js's business; every run
// goes to the NanoAgent on the member's own computer, server/runner.js's.
//
// It lived in the references route module, next to the bibliography, for no
// reason anybody would defend; the split that gave the bibliography its own
// plugin left this behind, which is where it belongs.

// What the assistant is when the caller asks for a conversation rather than one
// of the four editing jobs below. The CLI in the site's footer sends plain
// questions with no `type`, and an assistant with no instruction at all answers
// like a chat product rather than like part of this site.
const DEFAULT_SYSTEM_PROMPT =
  'You are the assistant built into a personal research site, answering from a '
  + 'small command line at the bottom of the page. Be brief and concrete: a '
  + 'sentence or two unless more is genuinely needed. Light markdown is welcome '
  + 'where it earns its place: a short heading, a list, a fenced code block. No '
  + 'preamble.';

const VALID_TYPES = ['continue', 'improve', 'explain', 'summarize', 'inline'];
const SYSTEM_PROMPTS = {
  continue: 'You are a writing assistant. Continue the text naturally, matching the style and tone. Output only the continuation, no preamble.',
  improve: 'You are an editing assistant. Improve the text for clarity, flow, and correctness while preserving the original meaning and tone. Output only the improved text, no preamble.',
  explain: 'You are a teaching assistant. Explain the given text in simple, clear terms. Be concise but thorough.',
  summarize: 'You are a summarization assistant. Provide a concise summary of the given text in 2-3 sentences.',
  inline: 'You are an inline Markdown completion engine. Return only the exact text to insert at <CURSOR>: no explanation, quotation marks, or code fences. Do not repeat text before or after the cursor. Match the document style and continue only as far as is immediately useful, usually one sentence, list item, or code line.',
};

// How long a stream may go without a byte on the wire. server/index.js gives
// every request `req.setTimeout(30000)` and registers no listener for it, so
// node destroys the socket after thirty idle seconds; an answer that takes
// longer than that to write would be cut off mid sentence. A comment line costs
// nothing, is ignored by every SSE client, and resets the timer.
const HEARTBEAT_MS = 10_000;

// Apps keep their files in the workspace file system, so they run only where it is enabled.
const APPS_NEED_FS = 'Apps need the workspace file system, which needs PostgreSQL (DATABASE_URL)';

/**
 * The CORS header set, echoing the caller's origin the way server/index.js
 * does. `json()` attaches these for every other reply in the codebase and is
 * the only thing that does, so a handler writing its own head has to say it
 * again or the browser discards the whole stream.
 */
function corsHeaders(req, corsOrigin) {
  const origin = req?.headers?.origin;
  return {
    'Access-Control-Allow-Origin': corsOrigin === '*' ? (origin || '*') : corsOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

/**
 * Turn a request body into the message the assistant is asked, or into the
 * refusal to send back.
 *
 * Both endpoints run this: the streaming one must accept exactly what the
 * buffered one accepts, and a second copy of these limits would drift the first
 * time one of them changed. Throws on a body that is not an object, which is
 * the generic-500 arm both handlers already catch.
 *
 * `run` is what the member's AI settings send for this use (ai-settings.js
 * forRun): the model, NanoAgent settings, and their own instructions.
 *
 * Returns `{error}` for a rejection, otherwise `{request}` ready for ai.
 */
function composeRequest(body, sanitizeText, agent = null, catalog = null, run = {}) {
  const {prompt, context, messages, type, agentId, profileId, model: chatModel, appId, sessionId, draft} = body;
  if (!prompt || typeof prompt !== 'string') return {error: 'Missing or invalid prompt'};
  if (prompt.length > 50000) return {error: 'Prompt must be 50000 characters or fewer'};
  if (context !== undefined && typeof context !== 'string') return {error: 'context must be a string'};
  if (context && context.length > 50000) return {error: 'Context must be 50000 characters or fewer'};
  if (messages !== undefined && !Array.isArray(messages)) return {error: 'messages must be an array'};
  if (messages?.length > 24) return {error: 'messages must contain 24 entries or fewer'};
  const history = [];
  for (let index = 0; index < (messages ?? []).length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object') return {error: `messages[${index}] must be an object`};
    if (!['user', 'assistant'].includes(message.role)) return {error: `messages[${index}].role must be user or assistant`};
    if (typeof message.content !== 'string') return {error: `messages[${index}].content must be a string`};
    if (message.content.length > 10000) return {error: `messages[${index}].content must be 10000 characters or fewer`};
    history.push({role: message.role, content: sanitizeText(message.content)});
  }
  if (type !== undefined && typeof type !== 'string') return {error: 'type must be a string'};
  if (type && type.length > 50) return {error: 'Type must be 50 characters or fewer'};
  if (type && !VALID_TYPES.includes(type)) {
    return {error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`};
  }
  if (agentId !== undefined && (typeof agentId !== 'string' || !agentId || agentId.length > 100)) {
    return {error: 'agentId must be a non-empty string of 100 characters or fewer'};
  }
  // A draft is an app's: the one of that id the member's computer has (routes/apps.js).
  if (draft !== undefined && (draft !== true || appId === undefined)) return {error: 'draft must be true, with an appId'};
  // A prompt for a NanoAgent app runs on that app's own agent, whose tools and
  // instructions NanoAgent owns, so nothing here may choose them instead.
  if (appId !== undefined) {
    if (typeof appId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(appId) || appId.length > 100) {
      return {error: 'appId must be a NanoAgent plugin id'};
    }
    if (type !== undefined || agentId !== undefined || profileId !== undefined || chatModel !== undefined) {
      return {error: 'appId cannot be combined with type, agentId, profileId or model'};
    }
    // Every prompt to an app belongs to one of the caller's sessions with it.
    if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(sessionId)) {
      return {error: 'sessionId must name a session with the app'};
    }
    if (context) history.push({role: 'user', content: `Context:\n${sanitizeText(context)}`});
    return {request: {input: sanitizeText(prompt), messages: history, app: appId, ...(draft ? {draft} : {}), ...run}, session: sessionId};
  }
  if (profileId !== undefined && (typeof profileId !== 'string' || !profileId || profileId.length > 100)) {
    return {error: 'profileId must be a non-empty string of 100 characters or fewer'};
  }
  if (chatModel !== undefined && (!chatModel || typeof chatModel !== 'object'
    || typeof chatModel.provider !== 'string' || !chatModel.provider || chatModel.provider.length > 100
    || typeof chatModel.model !== 'string' || !chatModel.model || chatModel.model.length > 200)) {
    return {error: 'model must be {"provider": "<id>", "model": "<id>"}'};
  }
  // The model this chat chose (/model), else the member's for this use, else
  // NanoAgent's default. A workspace agent chooses none: it brings instructions.
  const choice = chatModel ? {model: {provider: chatModel.provider, model: chatModel.model}}
    : profileId ? {profile: profileId}
      : {profile: run.profile, model: run.model};
  if (choice.profile && !(catalog?.profiles ?? []).some(profile => profile.id === choice.profile)) {
    return {error: 'The selected model is no longer offered. Choose another with /model or in Settings → Usage.'};
  }
  if (context) history.push({role: 'user', content: `Context:\n${sanitizeText(context)}`});

  const agentPrompt = agent?.instructions?.trim()
    ? `${DEFAULT_SYSTEM_PROMPT}\n\nYou are the workspace agent ${sanitizeText(agent.name || 'Assistant')}. Follow these workspace-provided instructions:\n${sanitizeText(agent.instructions)}`
    : null;
  const base = (type && SYSTEM_PROMPTS[type]) || agentPrompt || DEFAULT_SYSTEM_PROMPT;

  return {
    request: {
      input: sanitizeText(prompt),
      messages: history,
      instructions: run.instructions ? `${base}\n\nThe member's own instructions:\n${run.instructions}` : base,
      ...(choice.profile ? {profile: choice.profile} : {}),
      ...(choice.model ? {model: choice.model} : {}),
      ...(run.settings ? {settings: run.settings} : {}),
    },
  };
}

/**
 * Resolve an agent inside the verified workspace; never trust its browser copy.
 * The run is for `use` (chat or inline), on the NanoAgent `ai`, with the member's `settings`.
 */
async function composeStoredRequest(req, ctx, overrides, use, ai, settings) {
  const supplied = await ctx.readBody(req);
  const catalog = typeof ai.profiles === 'function'
    ? await ai.profiles()
    : fallbackProfiles;
  const body = supplied && typeof supplied === 'object' ? {...supplied, ...overrides} : supplied;
  // An app's prompt runs on the member's Apps model.
  const runUse = body?.appId !== undefined ? 'apps' : use;
  let agent = null;
  if (body?.agentId !== undefined) {
    if (typeof body.agentId !== 'string' || !body.agentId || body.agentId.length > 100) {
      return {error: 'agentId must be a non-empty string of 100 characters or fewer'};
    }
    agent = await ctx.collection('agents').get(ctx.scopeFor(req), body.agentId);
    if (!agent) return {error: 'Agent not found', status: 404};
  }
  const composed = composeRequest(
    body, ctx.sanitizeText, agent, catalog, aiSettings.forRun(settings, runUse),
  );
  if (composed.error) return composed;
  // The browser may choose only a profile id from NanoAgent's discovered
  // allowlist. Commands, credentials, tools, and execution policy stay private.
  return composed;
}

/**
 * Whether there is still a connection to write to. A caller who hung up mid
 * answer leaves a destroyed response behind, and writing to one of those raises
 * an error event on a request nobody is handling any more.
 */
function writable(res) {
  return !res.writableEnded && !res.destroyed;
}

/**
 * One server-sent event. The payload is JSON on a single `data:` line, so a
 * newline inside the answer is an escape sequence rather than the end of the
 * frame, which is the failure mode of sending prose raw.
 */
function sendEvent(res, event, data) {
  if (!writable(res)) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}


/** Start answering `res` as a server-sent event stream. */
function openEventStream(req, res, corsOrigin) {
  res.writeHead(200, {
    ...corsHeaders(req, corsOrigin),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Nginx buffers a proxied response by default, which would hold the whole
    // answer back and deliver it at once, defeating the point of the endpoint.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

/**
 * Write an app's run (app-runs.js) to `res` as `subscribe(onEvent, onEnd)`
 * passes its events, until it ends or the reader goes; a reader going leaves
 * the run going.
 */
async function followRun(res, subscribe) {
  const heartbeat = setInterval(() => {
    if (writable(res)) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  let leave;
  const left = new Promise(resolve => { leave = resolve; });
  res.on('close', leave);
  const stop = subscribe((event, data) => sendEvent(res, event, data), leave);
  try {
    await left;
  } finally {
    stop();
    res.off('close', leave);
    clearInterval(heartbeat);
    res.end();
  }
}

/**
 * Run the chat `composed` on the NanoAgent `ai`, passing its events to `send`
 * until it answers or fails, and charge it.
 */
async function answerRun(req, ctx, ai, kind, composed, send, signal) {
  // Whether the run got far enough to cost anything, for a run that ends
  // without NanoAgent's price (postgres/tenancy.js charges its cap instead).
  let ran = false;
  let result = null;
  try {
    result = await ai.stream({
      ...composed.request,
      signal,
      onDelta: (text) => {
        ran = true;
        send('delta', {text});
      },
      // The current client ignores these structured lifecycle events. They
      // establish the wire contract for future tool progress without
      // changing text streaming or inventing a second transport later.
      onEvent: event => {
        if (event.type === 'step.completed' || event.type === 'reasoning.delta') ran = true;
        if (event.type !== 'output_text.delta') send('agent', event);
      },
    });
    if (result.error) send('error', {error: result.error, status: result.status || 502});
    else send('done', completionPayload(result));
  } catch {
    send('error', {error: 'AI request failed. Please try again later.', status: 500});
  } finally {
    try {
      await ctx.aiMeter.record(req.context, kind, result, {ran, local: ai.local});
    } catch (error) {
      console.error('[ai] Could not record assistant usage:', error.message);
    }
  }
}

/**
 * One buffered completion, checked against the budget first and charged after.
 * Shared by the inline and the writing-assistant endpoints.
 */
async function meteredCompletion(req, res, ctx, kind, overrides, use) {
  const {json, aiMeter} = ctx;
  try {
    const ai = await ctx.aiFor(req.auth?.userId);
    await aiMeter.assertAllowed(req.context, ai);
    const settings = await ctx.aiSettings(req.auth?.userId);
    const {error, request, status} = await composeStoredRequest(req, ctx, overrides, use, ai, settings);
    if (error) return json(res, status || 400, {error});
    // Which model answers is server/ai.js's business. This one composes the
    // message and reports whatever comes back.
    const result = await ai.complete(request);
    await aiMeter.record(req.context, kind, result, {ran: Boolean(result.text), local: ai.local});
    if (result.error) return json(res, result.status || 502, {error: result.error});
    return json(res, 200, completionPayload(result));
  } catch (error) {
    const refusal = budgetRefusal(error);
    if (refusal) return json(res, refusal.status, refusal.body);
    return json(res, 500, {error: 'AI request failed. Please try again later.'});
  }
}

module.exports = async function ai_routes(req, res, url, pathname, ctx) {
  const {json, rateLimit, aiMeter, CORS_ORIGIN} = ctx;

  // A separate budget keeps editor pauses from consuming the CLI chat limit.
  // The type is forced server-side so this endpoint can never become a second
  // unrestricted assistant surface.
  if (req.method === 'POST' && pathname === '/api/ai/inline-complete') {
    if (!await rateLimit(`ai-inline:${req.caller}`, 30)) return json(res, 429, {error: 'Too many inline completions. Try again in a minute.'});
    return meteredCompletion(req, res, ctx, 'inline', {type: 'inline'}, 'inline');
  }

  // ── AI writing assistant (v2 – /api/ai/complete) ──
  if (req.method === 'POST' && pathname === '/api/ai/complete') {
    if (!await rateLimit(`ai-complete:${req.caller}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    return meteredCompletion(req, res, ctx, 'complete', {}, 'chat');
  }

  // ── The same answer, written as it is composed ──
  // The CLI at the foot of the page shows the reply arriving; five silent
  // seconds while a local model starts up read as a hang.
  const inlineStream = pathname === '/api/ai/inline-stream';
  if (req.method === 'POST' && (pathname === '/api/ai/stream' || inlineStream)) {
    // Keyed on the person, not the socket: this endpoint is behind the identity
    // gate, and one office behind one address should not share a budget.
    const rateKey = inlineStream ? 'ai-inline-stream' : 'ai-stream';
    const rateMax = inlineStream ? 30 : 10;
    if (!await rateLimit(`${rateKey}:${req.caller}`, rateMax)) return json(res, 429, {
      error: inlineStream ? 'Too many inline completions. Try again in a minute.' : 'Too many requests. Try again in a minute.',
    });

    let composed;
    let ai;
    try {
      ai = await ctx.aiFor(req.auth?.userId);
      await aiMeter.assertAllowed(req.context, ai);
      composed = await composeStoredRequest(
        req,
        ctx,
        inlineStream ? {type: 'inline'} : {},
        inlineStream ? 'inline' : 'chat',
        ai,
        await ctx.aiSettings(req.auth?.userId),
      );
    } catch (error) {
      const refusal = budgetRefusal(error);
      if (refusal) return json(res, refusal.status, refusal.body);
      return json(res, 500, {error: 'AI request failed. Please try again later.'});
    }
    if (composed.error) return json(res, composed.status || 400, {error: composed.error});
    const kind = inlineStream ? 'inline' : composed.request.app ? 'app' : 'chat';
    // An app's agent acts through the app's tools, on the member's own files.
    if (composed.request.app) {
      ctx.requireWorkspacePermission(req.context, 'apps:use');
      if (!ctx.appRuns || !ctx.sessions || !ctx.workspaceApps) return json(res, 409, {error: APPS_NEED_FS, code: 'fs-disabled'});
      try {
        await ctx.sessions.assertOwned(req.context, composed.request.app, Boolean(composed.request.draft), composed.session);
      } catch (error) {
        if (error.name === 'SessionError') return json(res, error.status, {error: error.message});
        throw error;
      }
      // The app runs as the member installed it: NanoAgent's install of its package, or of their draft.
      let opened;
      if (composed.request.draft) {
        const drafts = ctx.runners.drafts(req.auth?.userId);
        if (!drafts) return json(res, 503, {error: RUNNER_OFFLINE});
        opened = await ctx.workspaceApps.openDraft(req.context, composed.request.app, ai, drafts);
      } else {
        opened = await ctx.workspaceApps.open(req.context, composed.request.app, ai);
      }
      if (opened.error) return json(res, opened.status, {error: opened.error});
      composed.request.install = opened.value.sha256;
    }

    // An app's run is the session's and goes on without this connection, which
    // only follows it (app-runs.js), so a session answers one message at a time.
    if (composed.request.app) {
      let run;
      try {
        run = await ctx.appRuns.start(req.context, {
          pluginId: composed.request.app, draft: Boolean(composed.request.draft), sessionId: composed.session, prompt: composed.request.input, request: composed.request,
        });
      } catch (error) {
        if (error.name === 'SessionError') return json(res, error.status, {error: error.message});
        throw error;
      }
      openEventStream(req, res, CORS_ORIGIN);
      return followRun(res, (onEvent, onEnd) => run.follow(onEvent, onEnd));
    }
    openEventStream(req, res, CORS_ORIGIN);

    // A reader who closes the tab should not leave a NanoAgent run active.
    //
    // The connection is watched through res and not req, which is measured
    // rather than assumed: req emits its own 'close' as soon as the body has
    // been read, one tick before this handler resumes, so a listener there is
    // attached too late to ever hear anything. res emits 'close' when the
    // connection actually goes, which is the question being asked.
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on('close', onClose);
    const heartbeat = setInterval(() => {
      if (writable(res)) res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    try {
      await answerRun(req, ctx, ai, kind, composed, (event, data) => sendEvent(res, event, data), controller.signal);
    } finally {
      clearInterval(heartbeat);
      // Dropped before the response is ended, because ending it emits the same
      // 'close' and an abort then would be aimed at nothing.
      res.off('close', onClose);
      // Awaited to here, and ended here, because the dispatcher decides a
      // handler answered by res.writableEnded, which res.write() does not set.
      // Returning mid stream falls through to the 404 branch and throws
      // ERR_HTTP_HEADERS_SENT onto a response the caller is still reading.
      res.end();
    }
    return;
  }

  // ── Which private agent runtime is answering ──
  if (req.method === 'GET' && pathname === '/api/ai/status') {
    return json(res, 200, (await ctx.aiFor(req.auth?.userId)).describe());
  }

  if (req.method === 'GET' && pathname === '/api/ai/profiles') {
    return json(res, 200, await (await ctx.aiFor(req.auth?.userId)).profiles());
  }

  // ── The member's AI settings (Settings → Usage, ai-settings.js) ──
  if (req.method === 'GET' && pathname === '/api/ai/settings') {
    return json(res, 200, {settings: await ctx.aiSettings(req.auth?.userId), model: aiSettings.MODEL});
  }
  if (req.method === 'PUT' && pathname === '/api/ai/settings') {
    if (!await rateLimit(`ai-settings:${req.caller}`, 30)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    let body;
    try {
      body = await ctx.readBody(req);
    } catch {
      return json(res, 400, {error: 'Request body must be JSON, within the size limit'});
    }
    const normalized = aiSettings.normalize(body?.settings, ctx.sanitizeText);
    if (normalized.error) return json(res, 400, {error: normalized.error});
    await ctx.preferences.merge(req.auth.userId, {ai: normalized.value});
    return json(res, 200, {settings: normalized.value});
  }

  // ── The models a member may choose: every one their own computer's keys reach ──
  if (req.method === 'GET' && pathname === '/api/ai/models') {
    const computer = ctx.runners.status(req.auth?.userId);
    const gateway = ctx.runners.computer(req.auth?.userId);
    if (!gateway) return json(res, 200, {connected: false, device: null, providers: [], models: [], defaults: {}, limits: null});
    const [listing, catalog] = await Promise.all([gateway.models(), gateway.profiles()]);
    if (listing.error) return json(res, listing.status, {error: listing.error});
    return json(res, 200, {connected: true, device: computer.device, ...localModels(listing.value, catalog)});
  }

  // ── Whether the member's own computer is connected to run their AI ──
  if (req.method === 'GET' && pathname === '/api/runner/status') {
    return json(res, 200, ctx.runners.status(req.auth?.userId));
  }

  // ── What the OpenRouter key on the member's computer has spent, as OpenRouter says ──
  // `you`: what the member has spent, on every key Mochi gave them when the key is Mochi's (its
  // workspace), else on this key; `total`: what everyone has spent against the cap, the
  // workspace's lifetime budget, or the key's own spend against its own limit, if it has one.
  if (req.method === 'GET' && pathname === '/api/runner/credit') {
    const gateway = ctx.runners.computer(req.auth?.userId);
    if (!gateway) return json(res, 200, {credit: null});
    const usage = await gateway.openrouterUsage();
    // 404: the computer holds no OpenRouter key.
    if (usage.status === 404) return json(res, 200, {credit: null});
    if (usage.error) return json(res, usage.status, {error: usage.error});
    const key = usage.value;
    let you = key.usage;
    try {
      if (ctx.openrouterKeys && key.workspace_id === await ctx.openrouterKeys.workspaceId()) {
        you = await ctx.openrouterKeys.spent(req.auth.userId);
      }
    } catch (error) {
      return json(res, 502, {error: error.message});
    }
    const budget = key.workspace_budget;
    return json(res, 200, {credit: {
      you,
      total: budget ? {used: budget.spend, cap: budget.limit} : {used: key.usage, cap: key.limit},
    }});
  }

  // ── The API keys on the member's computer: passed on to it, never kept or shown here ──
  if (req.method === 'PUT' && pathname === '/api/runner/keys') {
    if (!await rateLimit(`runner-keys:${req.caller}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    let body;
    try {
      body = await ctx.readBody(req);
    } catch {
      return json(res, 400, {error: 'Request body must be JSON, within the size limit'});
    }
    const saved = await ctx.runners.saveKeys(req.auth.userId, body?.changes);
    if (saved.error) return json(res, saved.status, {error: saved.error});
    return json(res, 200, saved.value);
  }
};

/** The member's computer's catalog as models to choose, each available once RUSH Lab holds its provider's key. */
function localModels(listing, catalog) {
  const providers = new Map(listing.providers.map(provider => [provider.id, provider]));
  const models = listing.models.map(model => {
    const provider = providers.get(model.provider);
    return {
      key: `${model.provider}/${model.id}`,
      choice: {provider: model.provider, model: model.id},
      label: model.name,
      provider: model.provider,
      providerName: provider?.name ?? model.provider,
      model: model.id,
      uses: model.apps ? ['chat', 'inline', 'apps'] : ['chat', 'inline'],
      available: Boolean(provider?.keySet),
      unavailableReason: provider?.keySet ? null : `Needs your ${provider?.name ?? model.provider} key: add it under API keys`,
      price: model.cost,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
    };
  });
  // NanoAgent's own choices, where a use has none of the member's.
  const keyOf = profile => (profile?.provider ? `${profile.provider}/${profile.model}` : null);
  const byDefault = catalog.profiles.find(profile => profile.id === catalog.defaultProfile);
  return {
    providers: listing.providers,
    models,
    defaults: {
      chat: keyOf(byDefault),
      inline: keyOf(byDefault),
      apps: keyOf(catalog.profiles.find(profile => profile.uses.includes('apps'))),
    },
    limits: listing.limits,
  };
}

module.exports.DEFAULT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;
module.exports.composeRequest = composeRequest;
module.exports.composeStoredRequest = composeStoredRequest;
module.exports.APPS_NEED_FS = APPS_NEED_FS;
module.exports.openEventStream = openEventStream;
module.exports.followRun = followRun;
