import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// references.js is CommonJS; load the REAL module via createRequire, the same way
// the sibling references guard suites do, and reuse their ctx-mocking shape. This
// drives POST /api/ai/complete (the v2 AI writing assistant handler) directly
// over a mocked ctx with recorders, so there is no network, no filesystem, and
// no clock. The handler lives in server/routes/references.js; the dispatcher in
// server.js is not loaded here.
//
// Scope: this file pins the RATE-LIMIT gate. The handler opens with
//
//     if (!rateLimit('ai-complete:' + req.socket.remoteAddress, 10))
//       return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
//     try { const body = await readBody(req); ... }
//
// so the limiter check is the FIRST statement of the route and runs BEFORE
// readBody, the ANTHROPIC_API_KEY read, and the fetch to api.anthropic.com. When
// the limiter rejects, the route returns the fixed 429 without entering the try,
// so the path touches no body, no env, no network, and no clock.
//
// The sibling suites mock rateLimit to return true (the gate passes) and so leave
// this false branch uncovered: next-aicomplete-validation-guards.test.mjs pins
// the 400 guard ladder and next-aicomplete-post-catch.test.mjs pins the generic
// 500 catch arm. This file pins the limiter-rejected 429 only. It edits no
// source; it characterizes the current behavior.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');

// Invoke the AI-complete handler with a mocked ctx whose limiter REJECTS the
// request. `captured` holds the single json(res, status, body) the handler emits.
// `rateLimitCalls` captures the limiter key and ceiling the route asks for.
// `readBody` is a tripwire: it increments a counter AND throws, so any entry into
// the try would be loud; `readBodyCount` must stay 0 as the never-reached proof.
// `fetchCalls` records any global fetch attempt; it must stay empty because the
// gate returns ahead of the network call. The limiter returns false, so the
// request never advances past the gate.
async function invoke({ remoteAddress = '127.0.0.1' } = {}) {
  const pathname = '/api/ai/complete';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };

  let captured = null;
  let readBodyCount = 0;
  const rateLimitCalls = [];
  const fetchCalls = [];

  const ctx = {
    json(_res, status, payload) { captured = { status, body: payload }; res.writableEnded = true; return captured; },
    readBody: async () => { readBodyCount += 1; throw new Error('readBody must not run once the limiter rejects'); },
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return false; },
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

// The limiter-rejected gate always returns this exact, input-independent golden.
const GOLDEN = { status: 429, body: { error: 'Too many requests. Try again in a minute.' } };

describe('POST /api/ai/complete rate-limit gate characterization (references.js)', () => {
  it('returns the fixed 429 when the limiter rejects, before reading the body', async () => {
    const { captured, readBodyCount, rateLimitCalls, fetchCalls } = await invoke();
    assert.deepStrictEqual(captured, GOLDEN);
    // The gate is consulted exactly once, with this route's own key and ceiling.
    assert.deepStrictEqual(rateLimitCalls, [{ key: 'ai-complete:127.0.0.1', limit: 10 }]);
    // readBody sits inside the try, one line past the gate; the 429 return means
    // it is never reached, so the tripwire never fires and the count stays 0.
    assert.strictEqual(readBodyCount, 0);
    // The gate precedes the network call, so fetch is never reached either.
    assert.strictEqual(fetchCalls.length, 0);
  });

  it('builds the limiter key from the request remote address', async () => {
    // A different client address flows into the limiter key verbatim, proving the
    // key is derived from req.socket.remoteAddress while the 429 golden stays the
    // same regardless of the address.
    const { captured, rateLimitCalls, readBodyCount } = await invoke({ remoteAddress: '10.0.0.7' });
    assert.deepStrictEqual(captured, GOLDEN);
    assert.deepStrictEqual(rateLimitCalls, [{ key: 'ai-complete:10.0.0.7', limit: 10 }]);
    assert.strictEqual(readBodyCount, 0);
  });
});
