/**
 * server/routes/ai.js: the assistant endpoint the CLI talks to.
 *
 * Which model answers, and whether over HTTP or through the Claude CLI on this
 * machine, is server/ai.js's business and is tested in tests/unit/server/ai.test.mjs.
 * What belongs here is the message this route composes out of a prompt, an
 * optional context and an optional job type, and what it does with the reply.
 *
 * This lived in the references route suite until the bibliography became a
 * plugin and took its own endpoints with it.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';

const routes = loadRoute('ai');

describe('POST /api/ai/complete', () => {
  const OK = {prompt: 'Write something', type: 'continue'};

  it('returns 429 before reading the body, keyed on the caller address', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'ai-complete:127.0.0.1', maxPerMinute: 10}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'an omitted prompt', body: {}, error: 'Missing or invalid prompt'},
    {name: 'a non-string prompt', body: {prompt: 7}, error: 'Missing or invalid prompt'},
    {name: 'a prompt over 50000 characters', body: {prompt: 'p'.repeat(50001)}, error: 'Prompt must be 50000 characters or fewer'},
    {name: 'a non-string context', body: {prompt: 'p', context: 7}, error: 'context must be a string'},
    {name: 'a context over 50000 characters', body: {prompt: 'p', context: 'c'.repeat(50001)}, error: 'Context must be 50000 characters or fewer'},
    {name: 'a non-string type', body: {prompt: 'p', type: 7}, error: 'type must be a string'},
    {name: 'a type over 50 characters', body: {prompt: 'p', type: 't'.repeat(51)}, error: 'Type must be 50 characters or fewer'},
    {name: 'a type outside the allow list', body: {prompt: 'p', type: 'translate'}, error: 'Invalid type. Must be one of: continue, improve, explain, summarize'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without troubling the assistant`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.ai, []);
    });
  }

  // Which model answers, and whether over HTTP or through the CLI on this
  // machine, is server/ai.js's business and is tested there. What belongs here
  // is the message this route composes and what it does with the reply.
  it('asks the assistant for the composed message and returns what comes back', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: {...OK, context: 'earlier text'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {text: 'a completion'}]);
    assert.equal(ctx.calls.ai.length, 1);
    // A supplied context is folded into the user message.
    assert.equal(ctx.calls.ai[0].prompt, 'Context:\nearlier text\n\nText:\nWrite something');
    assert.ok(ctx.calls.ai[0].system.startsWith('You are a writing assistant.'));
  });

  it('sends the system prompt for the named job', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: {prompt: 'p', type: 'summarize'}, ctx});
    assert.ok(ctx.calls.ai[0].system.startsWith('You are a summarization assistant.'));
  });

  // The CLI at the foot of the site sends plain questions with no type, and an
  // assistant with no instruction at all answers like a chat product instead of
  // like part of this site.
  it('falls back to the site assistant when no type is given', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: {prompt: 'p'}, ctx});
    assert.match(ctx.calls.ai[0].system, /assistant built into a personal research site/);
  });

  it('passes a refusal through with the status the assistant chose', async () => {
    const ctx = makeCtx({ai: {complete: async () => ({error: 'No AI provider is available.', status: 503})}});
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: OK, ctx});
    assert.deepEqual([r.status, r.payload], [503, {error: 'No AI provider is available.'}]);
  });

  it('answers 502 for a refusal that named no status', async () => {
    const ctx = makeCtx({ai: {complete: async () => ({error: 'something went wrong'})}});
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: OK, ctx});
    assert.equal(r.status, 502);
  });

  it('reports the provider at /api/ai/status', async () => {
    const r = await invoke(routes, {path: '/api/ai/status'});
    assert.deepEqual([r.status, r.payload], [200, {available: true, provider: 'api', model: 'test-model'}]);
  });

  for (const [label, readBody] of [
    ['readBody rejects', async () => { throw new Error('bad json'); }],
    ['readBody resolves null', async () => null],
  ]) {
    it(`returns the generic 500 when ${label}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', ctx: makeCtx({readBody})});
      assert.deepEqual([r.status, r.payload], [500, {error: 'AI request failed. Please try again later.'}]);
    });
  }
});

// ── Metadata search ───────────────────────────────────────────────────────
