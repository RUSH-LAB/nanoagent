'use strict';
// Route module organized from server/index.js. Each handler runs with the shared
// `ctx` (helpers, data-file paths, in-memory stores). Returns nothing; the
// dispatcher in server/index.js detects a sent response via res.writableEnded.
//
// The assistant. Core, not a plugin: the CLI at the foot of every page talks to
// it, and a site whose assistant could be uninstalled would be a site whose
// front door sometimes answers 404. Which model replies, and whether over HTTP
// or through the Claude CLI on this machine, is server/ai.js's business.
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
  + 'sentence or two unless more is genuinely needed. Plain text, no markdown '
  + 'headings, no preamble.';

module.exports = async function ai_routes(req, res, url, pathname, ctx) {
  const {json, readBody, rateLimit, sanitizeText, ai} = ctx;

  // ── AI writing assistant (v2 – /api/ai/complete) ──
  if (req.method === 'POST' && pathname === '/api/ai/complete') {
    if (!rateLimit(`ai-complete:${req.socket.remoteAddress}`, 10)) return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    try {
      const body = await readBody(req);
      const {prompt, context, type} = body;
      if (!prompt || typeof prompt !== 'string') return json(res, 400, {error: 'Missing or invalid prompt'});
      if (prompt.length > 50000) return json(res, 400, {error: 'Prompt must be 50000 characters or fewer'});
      if (context !== undefined && typeof context !== 'string') return json(res, 400, {error: 'context must be a string'});
      if (context && context.length > 50000) return json(res, 400, {error: 'Context must be 50000 characters or fewer'});
      if (type !== undefined && typeof type !== 'string') return json(res, 400, {error: 'type must be a string'});
      if (type && type.length > 50) return json(res, 400, {error: 'Type must be 50 characters or fewer'});
      const validTypes = ['continue', 'improve', 'explain', 'summarize'];
      if (type && !validTypes.includes(type)) {
        return json(res, 400, {error: `Invalid type. Must be one of: ${validTypes.join(', ')}`});
      }
      const systemPrompts = {
        continue: 'You are a writing assistant. Continue the text naturally, matching the style and tone. Output only the continuation, no preamble.',
        improve: 'You are an editing assistant. Improve the text for clarity, flow, and correctness while preserving the original meaning and tone. Output only the improved text, no preamble.',
        explain: 'You are a teaching assistant. Explain the given text in simple, clear terms. Be concise but thorough.',
        summarize: 'You are a summarization assistant. Provide a concise summary of the given text in 2-3 sentences.',
      };

      let userContent = sanitizeText(prompt);
      if (context) {
        userContent = `Context:\n${sanitizeText(context)}\n\nText:\n${sanitizeText(prompt)}`;
      }

      // Which model answers, and whether by HTTP or by the CLI on this machine,
      // is server/ai.js's business. This one composes the message and reports
      // whatever comes back.
      const result = await ai.complete({
        prompt: userContent,
        system: (type && systemPrompts[type]) || DEFAULT_SYSTEM_PROMPT,
      });
      if (result.error) return json(res, result.status || 502, {error: result.error});
      return json(res, 200, {text: result.text});
    } catch {
      return json(res, 500, {error: 'AI request failed. Please try again later.'});
    }
  }

  // ── Which provider is answering, and why not, when none is ──
  if (req.method === 'GET' && pathname === '/api/ai/status') {
    return json(res, 200, ai.describe());
  }
};

module.exports.DEFAULT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;
