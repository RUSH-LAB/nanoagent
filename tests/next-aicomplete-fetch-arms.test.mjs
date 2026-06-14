import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// references.js is CommonJS; load the REAL module via createRequire, the same way
// the sibling AI-complete suites do, and reuse their ctx-mocking shape. This
// drives POST /api/ai/complete (the v2 AI writing assistant handler) directly
// over a mocked ctx with recorders, so there is no real network and no real
// filesystem. The handler lives in server/routes/references.js; the dispatcher in
// server.js is not loaded here.
//
// Scope: this file pins the three error arms that the companion suites leave
// uncovered. next-aicomplete-post-catch.test.mjs explicitly states the
// missing-key 500, the upstream 502, and the AbortError 504 are NOT pinned there,
// because each needs a different trigger or reads the environment. This file
// closes that gap:
//
//   500 (references.js:341-344): apiKey = process.env.ANTHROPIC_API_KEY; when it
//        is unset the handler returns the fixed "ANTHROPIC_API_KEY is not set"
//        500 BEFORE any fetch, so the network is never touched.
//   502 (references.js:386-388): after fetch resolves, aiData = await
//        aiResponse.json(); when aiResponse.ok is false the handler returns the
//        fixed "AI service returned an error" 502.
//   504 (references.js:393-394): the outer catch maps an err.name of 'AbortError'
//        to the fixed "AI request timed out" 504.
//
// The 500 arm returns before line 353, so it never calls sanitizeText. The 502
// and 504 arms both run sanitizeText(prompt) at line 353 before reaching the
// network, so the ctx supplies sanitizeText as an identity recorder. The handler
// calls the GLOBAL fetch (not a ctx field), so each case swaps globalThis.fetch
// and restores it afterward. process.env.ANTHROPIC_API_KEY is saved once and
// restored after every case so no other suite is disturbed. This file edits no
// source; it characterizes the current behavior only.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');

// Sentinel telling invoke to delete the env key for a case, distinct from any
// real string value the key could carry.
const NO_KEY = Symbol('no ANTHROPIC_API_KEY');

// Invoke the AI-complete handler with a mocked ctx. `apiKey` sets (or, with
// NO_KEY, deletes) process.env.ANTHROPIC_API_KEY for the duration of the call.
// `fetchImpl` becomes globalThis.fetch for the call; invoke wraps it so every
// attempt is recorded in `fetchCalls` before delegating. `captured` holds the
// single json(res, status, payload) the handler emits. The limiter returns true
// so the request reaches the try, and readBody resolves a valid prompt so the
// 400 guard ladder passes and control reaches the arm under test. Both the global
// fetch and the env key are restored in the finally so concurrent suites stay
// untouched.
async function invoke({ apiKey, fetchImpl, prompt = 'hello', remoteAddress = '127.0.0.1' }) {
  const pathname = '/api/ai/complete';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };

  let captured = null;
  const rateLimitCalls = [];
  const fetchCalls = [];

  const ctx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    readBody: async () => ({ prompt }),
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return true; },
    // sanitizeText is destructured from ctx at references.js:94 and runs at line
    // 353 on the 502 and 504 paths; an identity passthrough keeps userContent
    // equal to the prompt without altering the arm under test (the mock fetch
    // ignores the request body entirely).
    sanitizeText: (s) => s,
  };

  const realFetch = globalThis.fetch;
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY');
  const realKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey === NO_KEY) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = apiKey;

  globalThis.fetch = (...args) => { fetchCalls.push(args); return fetchImpl(...args); };
  try {
    await routes(req, res, url, pathname, ctx);
  } finally {
    globalThis.fetch = realFetch;
    if (hadKey) process.env.ANTHROPIC_API_KEY = realKey;
    else delete process.env.ANTHROPIC_API_KEY;
  }
  return { captured, rateLimitCalls, fetchCalls };
}

// Each arm returns an exact, input-independent golden. Strings copied verbatim
// from server/routes/references.js (lines 343, 388, 394).
const GOLDEN_500 = { status: 500, payload: { error: 'ANTHROPIC_API_KEY is not set. Please set it in your environment: export ANTHROPIC_API_KEY=sk-ant-...' } };
const GOLDEN_502 = { status: 502, payload: { error: 'AI service returned an error. Please try again.' } };
const GOLDEN_504 = { status: 504, payload: { error: 'AI request timed out. Please try again.' } };

describe('POST /api/ai/complete error arms characterization (references.js)', () => {
  it('returns the fixed 500 when ANTHROPIC_API_KEY is unset, before any fetch', async () => {
    // With the key deleted, the apiKey guard at references.js:342 fires and
    // returns the missing-key 500 at line 343. That return precedes sanitizeText
    // (line 353) and the fetch (line 372), so a throwing tripwire proves the
    // network is never reached on this arm.
    const tripwire = () => { throw new Error('fetch must not run when the API key is missing'); };
    const { captured, rateLimitCalls, fetchCalls } = await invoke({ apiKey: NO_KEY, fetchImpl: tripwire });
    assert.deepStrictEqual(captured, GOLDEN_500);
    // The limiter passed once with this route's own key and ceiling, ahead of the try.
    assert.deepStrictEqual(rateLimitCalls, [{ key: 'ai-complete:127.0.0.1', limit: 10 }]);
    assert.strictEqual(fetchCalls.length, 0, 'the missing-key 500 returns before the network call');
  });

  it('returns the fixed 502 when the upstream response is not ok', async () => {
    // The key is present, so control reaches the fetch. The upstream resolves
    // with ok:false and a JSON body, so aiResponse.json() succeeds and the
    // !aiResponse.ok check at references.js:387 returns the 502.
    const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
    const { captured, fetchCalls } = await invoke({ apiKey: 'sk-ant-test', fetchImpl });
    assert.deepStrictEqual(captured, GOLDEN_502);
    assert.strictEqual(fetchCalls.length, 1, 'the 502 arm runs exactly one upstream fetch');
  });

  it('returns the fixed 504 when the upstream fetch aborts', async () => {
    // The key is present, so control reaches the fetch, which rejects with an
    // AbortError. The outer catch at references.js:393 matches err.name and
    // returns the timeout 504 rather than the generic 500.
    const fetchImpl = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    const { captured, fetchCalls } = await invoke({ apiKey: 'sk-ant-test', fetchImpl });
    assert.deepStrictEqual(captured, GOLDEN_504);
    assert.strictEqual(fetchCalls.length, 1, 'the 504 arm attempts exactly one upstream fetch before aborting');
  });
});
