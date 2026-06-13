import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling references guard suites do, and reuse their ctx-mocking shape. This
// drives POST /api/ai/complete (the v2 AI writing assistant handler) directly
// over a mocked ctx with recorders, so there is no network, no filesystem, and
// no clock. The handler lives in server/routes/references.js; the dispatcher in
// server.js is not loaded here.
//
// Every case below exercises one rung of the input-validation guard ladder in
// the POST /api/ai/complete handler and rejects with a 400 BEFORE the
// process.env.ANTHROPIC_API_KEY read and the
// fetch('https://api.anthropic.com/...') call. So each case is fully
// deterministic and never touches the network or the environment. To prove the
// no-network property, globalThis.fetch is swapped for a recorder that counts
// calls (and throws if reached); every test asserts it was called zero times.
//
// This file edits no source. It pins the CURRENT behavior of the guards as a
// characterization test. The success path and the missing-key 500 branch are
// intentionally NOT pinned here, since they read the environment or the network.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');

// Invoke the AI-complete handler with a mocked ctx. `captured` holds the single
// json(res, status, payload) the handler emits. `readBodyCount` proves the body
// was read exactly once. `rateLimitCalls` captures the limiter key and ceiling
// the route asks for. `fetchCalls` records any global fetch attempt; it must
// stay empty because every guard rejects before the network call. The limiter
// mock returns true (not throttled) so the request reaches the guard ladder.
async function invoke({ body, remoteAddress = '127.0.0.1' }) {
  const pathname = '/api/ai/complete';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };

  let captured = null;
  let readBodyCount = 0;
  const rateLimitCalls = [];
  const fetchCalls = [];

  const ctx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    readBody: async () => { readBodyCount += 1; return body; },
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return true; },
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { fetchCalls.push(args); throw new Error('unexpected network call to fetch'); };
  try {
    await routes(req, res, url, pathname, ctx);
  } finally {
    globalThis.fetch = realFetch;
  }
  return { captured, readBodyCount, rateLimitCalls, fetchCalls };
}

describe('POST /api/ai/complete input-validation guard ladder characterization', () => {
  it('returns 400 Missing or invalid prompt when prompt is omitted', async () => {
    const { captured, readBodyCount, rateLimitCalls, fetchCalls } = await invoke({ body: {} });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid prompt' });
    // The limiter is consulted with this route's own key and ceiling, then the
    // body is read once inside the try before the first guard rejects.
    assert.deepEqual(rateLimitCalls, [{ key: 'ai-complete:127.0.0.1', limit: 10 }]);
    assert.equal(readBodyCount, 1);
    assert.equal(fetchCalls.length, 0);
  });

  it('returns 400 Missing or invalid prompt when prompt is not a string', async () => {
    // A numeric prompt is truthy, so the typeof half of the first guard rejects it.
    const { captured, fetchCalls } = await invoke({ body: { prompt: 123 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid prompt' });
    assert.equal(fetchCalls.length, 0);
  });

  it('returns 400 Prompt must be 50000 characters or fewer when prompt is too long', async () => {
    // 50000 is the boundary; a 50001-character string trips the prompt length guard.
    const { captured, fetchCalls } = await invoke({ body: { prompt: 'a'.repeat(50001) } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Prompt must be 50000 characters or fewer' });
    assert.equal(fetchCalls.length, 0);
  });

  it('returns 400 context must be a string when context is present and not a string', async () => {
    // A valid prompt clears the first two guards; a numeric context trips the
    // context type guard.
    const { captured, fetchCalls } = await invoke({ body: { prompt: 'hello', context: 123 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'context must be a string' });
    assert.equal(fetchCalls.length, 0);
  });

  it('returns 400 Context must be 50000 characters or fewer when context is too long', async () => {
    // A valid string context clears the type guard; a 50001-character context
    // trips the context length guard.
    const { captured, fetchCalls } = await invoke({ body: { prompt: 'hello', context: 'c'.repeat(50001) } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Context must be 50000 characters or fewer' });
    assert.equal(fetchCalls.length, 0);
  });

  it('returns 400 type must be a string when type is present and not a string', async () => {
    // context is omitted (undefined clears both context guards); a numeric type
    // trips the type type-guard.
    const { captured, fetchCalls } = await invoke({ body: { prompt: 'hello', type: 123 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'type must be a string' });
    assert.equal(fetchCalls.length, 0);
  });

  it('returns 400 Type must be 50 characters or fewer when type is too long', async () => {
    // 50 is the boundary; a 51-character type string trips the length guard
    // before the allow-list check.
    const { captured, fetchCalls } = await invoke({ body: { prompt: 'hello', type: 't'.repeat(51) } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Type must be 50 characters or fewer' });
    assert.equal(fetchCalls.length, 0);
  });

  it('returns 400 Invalid type when type is a short string outside the allow list', async () => {
    // A short, string-typed value that is not one of continue, improve, explain,
    // or summarize trips the allow-list guard, the last rung before the env read.
    const { captured, fetchCalls } = await invoke({ body: { prompt: 'hello', type: 'translate' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, {
      error: 'Invalid type. Must be one of: continue, improve, explain, summarize',
    });
    assert.equal(fetchCalls.length, 0);
  });
});
