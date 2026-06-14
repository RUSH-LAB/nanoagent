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
// Scope: this file pins the GENERIC catch arm of the handler. The try opens with
//
//     const body = await readBody(req);       // (1) rejects   -> throws into the catch
//     const {prompt, context, type} = body;   // (2) body null -> destructure throws
//
// and the catch is
//
//     } catch (err) {
//       if (err.name === 'AbortError') return json(res, 504, {...});
//       return json(res, 500, {error: 'AI request failed. Please try again later.'});
//     }
//
// Neither trigger produces an AbortError, so both take the else arm and return
// the fixed 500. readBody is the first failable step inside the try, so the throw
// lands before the ANTHROPIC_API_KEY read and before the
// fetch('https://api.anthropic.com/...') call. The result is therefore the same
// generic 500 whether or not the key is set, and the path touches no env, no
// network, and no clock. globalThis.fetch is swapped for a recorder that throws
// if reached; every case asserts it ran zero times as the never-reached proof.
//
// The companion suite next-aicomplete-validation-guards.test.mjs pins the 400
// guard ladder. The 504 AbortError arm, the 502 upstream arm, and the
// missing-key 500 are intentionally NOT pinned here, since each needs a different
// trigger or reads the environment. This file edits no source; it characterizes
// the current behavior only.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');

// Invoke the AI-complete handler with a mocked ctx. `body` is whatever readBody
// resolves to; `readBodyThrows` instead makes it reject (trigger 1). `captured`
// holds the single json(res, status, payload) the handler emits. `readBodyCount`
// proves the body read was attempted. `rateLimitCalls` captures the limiter key
// and ceiling the route asks for. `fetchCalls` records any global fetch attempt;
// it must stay empty because the throw precedes the network call. The limiter
// mock returns true (not throttled) so the request reaches the try.
async function invoke({ body, readBodyThrows = false, remoteAddress = '127.0.0.1' }) {
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
    readBody: async () => { readBodyCount += 1; if (readBodyThrows) throw new Error('boom'); return body; },
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

// The generic catch arm always returns this exact, input-independent golden.
const GOLDEN = { status: 500, body: { error: 'AI request failed. Please try again later.' } };

describe('POST /api/ai/complete generic catch characterization (references.js)', () => {
  it('returns the fixed 500 when readBody resolves null and the destructure throws', async () => {
    // readBody resolves null, so `const {prompt, context, type} = null` throws a
    // TypeError into the catch. err.name is 'TypeError', not 'AbortError', so the
    // else arm returns the generic 500 rather than the 504 timeout message.
    const { captured, readBodyCount, rateLimitCalls, fetchCalls } = await invoke({ body: null });
    assert.deepEqual(captured, GOLDEN);
    assert.notEqual(captured.status, 504, 'a TypeError is not an AbortError, so the 504 arm is skipped');
    // The limiter is consulted once with this route's own key and ceiling, ahead
    // of the try; the body is then read once before the destructure throws.
    assert.deepEqual(rateLimitCalls, [{ key: 'ai-complete:127.0.0.1', limit: 10 }]);
    assert.equal(readBodyCount, 1);
    // The throw precedes the network call, so fetch is never reached.
    assert.equal(fetchCalls.length, 0);
  });

  it('returns the SAME 500 when readBody itself rejects', async () => {
    // readBody rejects with a plain Error, so the await on the first try step
    // throws into the catch before the destructure. err.name is 'Error', not
    // 'AbortError', so the same generic 500 is returned and fetch is never reached.
    const { captured, readBodyCount, fetchCalls } = await invoke({ readBodyThrows: true });
    assert.deepEqual(captured, GOLDEN);
    assert.notEqual(captured.status, 504, 'a plain Error is not an AbortError, so the 504 arm is skipped');
    assert.equal(readBodyCount, 1, 'readBody is attempted once, then rejects inside the try');
    assert.equal(fetchCalls.length, 0);
  });
});
