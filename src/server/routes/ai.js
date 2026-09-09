'use strict';
const fallbackProfiles = require('../../ai-profiles.json');
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
//
// The assistant. Core, not a plugin: the CLI at the foot of every page talks to
// it, and a site whose assistant could be uninstalled would be a site whose
// front door sometimes answers 404. Which model replies, and whether over HTTP
// through the private NanoAgent service, is server/ai.js's business.
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

const VALID_TYPES = ['continue', 'improve', 'explain', 'summarize'];
const SYSTEM_PROMPTS = {
  continue: 'You are a writing assistant. Continue the text naturally, matching the style and tone. Output only the continuation, no preamble.',
  improve: 'You are an editing assistant. Improve the text for clarity, flow, and correctness while preserving the original meaning and tone. Output only the improved text, no preamble.',
  explain: 'You are a teaching assistant. Explain the given text in simple, clear terms. Be concise but thorough.',
  summarize: 'You are a summarization assistant. Provide a concise summary of the given text in 2-3 sentences.',
};

// How long a stream may go without a byte on the wire. server/index.js gives
// every request `req.setTimeout(30000)` and registers no listener for it, so
// node destroys the socket after thirty idle seconds; an answer that takes
// longer than that to write would be cut off mid sentence. A comment line costs
// nothing, is ignored by every SSE client, and resets the timer.
const HEARTBEAT_MS = 10_000;

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
 * Returns `{error}` for a rejection, otherwise `{request}` ready for ai.
 */
function composeRequest(body, sanitizeText, agent = null, catalog = null) {
  const {prompt, context, messages, type, agentId, profileId: requestedProfileId} = body;
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
  if (requestedProfileId !== undefined
    && (typeof requestedProfileId !== 'string' || !requestedProfileId || requestedProfileId.length > 100)) {
    return {error: 'profileId must be a non-empty string of 100 characters or fewer'};
  }
  const profiles = catalog?.profiles ?? [];
  let profileId = requestedProfileId || agent?.profileId;
  if (!profileId && agent?.model) {
    profileId = profiles.find(profile => profile.model === agent.model)?.id;
    if (!profileId) return {error: 'The selected agent has an unsupported legacy model'};
  }
  profileId ||= catalog?.defaultProfile;
  if (!profiles.some(profile => profile.id === profileId)) {
    return {error: 'The selected agent has an unsupported profile'};
  }
  if (context) history.push({role: 'user', content: `Context:\n${sanitizeText(context)}`});

  const agentPrompt = agent?.instructions?.trim()
    ? `${DEFAULT_SYSTEM_PROMPT}\n\nYou are the workspace agent ${sanitizeText(agent.name || 'Assistant')}. Follow these workspace-provided instructions:\n${sanitizeText(agent.instructions)}`
    : null;

  return {
    request: {
      input: sanitizeText(prompt),
      messages: history,
      instructions: (type && SYSTEM_PROMPTS[type]) || agentPrompt || DEFAULT_SYSTEM_PROMPT,
      profile: profileId,
    },
  };
}

/** Resolve an agent inside the verified workspace; never trust its browser copy. */
async function composeStoredRequest(req, ctx) {
  const body = await ctx.readBody(req);
  const catalog = typeof ctx.ai.profiles === 'function'
    ? await ctx.ai.profiles()
    : fallbackProfiles;
  let agent = null;
  if (body?.agentId !== undefined) {
    if (typeof body.agentId !== 'string' || !body.agentId || body.agentId.length > 100) {
      return {error: 'agentId must be a non-empty string of 100 characters or fewer'};
    }
    agent = await ctx.collection('agents').get(ctx.scopeFor(req), body.agentId);
    if (!agent) return {error: 'Agent not found', status: 404};
  }
  const composed = composeRequest(body, ctx.sanitizeText, agent, catalog);
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

module.exports = async function ai_routes(req, res, url, pathname, ctx) {
  const {json, rateLimit, ai, CORS_ORIGIN} = ctx;

  // ── AI writing assistant (v2 – /api/ai/complete) ──
  if (req.method === 'POST' && pathname === '/api/ai/complete') {
    if (!rateLimit(`ai-complete:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const {error, request, status} = await composeStoredRequest(req, ctx);
      if (error) return json(res, status || 400, {error});

      // Which model answers, and whether by HTTP or by the CLI on this machine,
      // is server/ai.js's business. This one composes the message and reports
      // whatever comes back.
      const result = await ai.complete(request);
      if (result.error) return json(res, result.status || 502, {error: result.error});
      return json(res, 200, {
        text: result.text,
        ...(result.usage ? {usage: result.usage} : {}),
        ...(result.cost != null ? {cost: result.cost} : {}),
        ...(result.metrics ? {metrics: result.metrics} : {}),
        ...(result.model ? {model: result.model} : {}),
        ...(result.harness ? {harness: result.harness} : {}),
        ...(result.profile ? {profile: result.profile} : {}),
        ...(result.stopReason ? {stopReason: result.stopReason} : {}),
      });
    } catch {
      return json(res, 500, {error: 'AI request failed. Please try again later.'});
    }
  }

  // ── The same answer, written as it is composed (/api/ai/stream) ──
  // The CLI at the foot of the page shows the reply arriving; five silent
  // seconds while a local model starts up read as a hang.
  if (req.method === 'POST' && pathname === '/api/ai/stream') {
    // Keyed on the person, not the socket: this endpoint is behind the identity
    // gate, and one office behind one address should not share a budget.
    if (!rateLimit(`ai-stream:${req.auth?.userId}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});

    let composed;
    try {
      composed = await composeStoredRequest(req, ctx);
    } catch {
      return json(res, 500, {error: 'AI request failed. Please try again later.'});
    }
    if (composed.error) return json(res, composed.status || 400, {error: composed.error});

    res.writeHead(200, {
      ...corsHeaders(req, CORS_ORIGIN),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Nginx buffers a proxied response by default, which would hold the whole
      // answer back and deliver it at once, defeating the point of the endpoint.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

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
      const result = await ai.stream({
        ...composed.request,
        signal: controller.signal,
        onDelta: (text) => sendEvent(res, 'delta', {text}),
        // The current client ignores these structured lifecycle events. They
        // establish the wire contract for future tool progress without
        // changing text streaming or inventing a second transport later.
        onEvent: event => {
          if (event.type !== 'output_text.delta') sendEvent(res, 'agent', event);
        },
      });
      if (result.error) sendEvent(res, 'error', {error: result.error, status: result.status || 502});
      else sendEvent(res, 'done', {
        text: result.text,
        ...(result.usage ? {usage: result.usage} : {}),
        ...(result.cost != null ? {cost: result.cost} : {}),
        ...(result.metrics ? {metrics: result.metrics} : {}),
        ...(result.model ? {model: result.model} : {}),
        ...(result.harness ? {harness: result.harness} : {}),
        ...(result.profile ? {profile: result.profile} : {}),
        ...(result.stopReason ? {stopReason: result.stopReason} : {}),
      });
    } catch {
      sendEvent(res, 'error', {error: 'AI request failed. Please try again later.', status: 500});
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
    return json(res, 200, ai.describe());
  }

  if (req.method === 'GET' && pathname === '/api/ai/profiles') {
    return json(res, 200, await ai.profiles());
  }
};

module.exports.DEFAULT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;
module.exports.composeRequest = composeRequest;
module.exports.composeStoredRequest = composeStoredRequest;
