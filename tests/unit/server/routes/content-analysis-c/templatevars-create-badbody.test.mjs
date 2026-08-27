import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the REAL module the way the sibling
// route tests do (createRequire, no reimplementation).
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

// Characterization test for the currently-uncovered OUTER CATCH of
// POST /api/template-variables (content-analysis-c.js, handler around L1187 to
// L1208). The guard-branch tests in next-template-variables-create-guards.test.mjs
// always resolve readBody to a valid object, so they return through the inner
// guards and never drive the catch. Both ways into that catch are pinned here:
//
//   try {
//     const body = await readBody(req);   // (1) rejects   => throws into the catch
//     const {name, value} = body;         // (2) body null => destructure throws
//     ...                                 //     (this beats the inner '!name' guard)
//   } catch { return json(res, 400, {error: 'Invalid request'}); }
//
// readBody is the first failable step inside the try, so the catch is reached
// before any store I/O. loadJSON and saveJSON are wired as tripwires that throw
// on contact AND count their calls: the count === 0 is the never-reached proof.
// A swallowed throw would still surface the same golden 400, so the call count
// (not the body) is what proves the store was never touched. The handler clears
// the limiter before the try, so rateLimit is stubbed to true to reach the catch.
// Deterministic: this path reads no clock, randomness, network, or real filesystem.

const PROJECT_ROOT = '/fake/root';

// Invoke the real POST handler with a mocked ctx. `body` is whatever readBody
// yields; `readBodyThrows` makes readBody reject (trigger 1). loadJSON and
// saveJSON throw if ever called, so reaching them fails the test loudly, and the
// `calls` counters additionally assert each ran zero times. `limiterCall`
// captures the exact rate-limit key and ceiling to document the gate shape.
async function createVar(body, { rateLimitOk = true, readBodyThrows = false } = {}) {
  const calls = { rateLimit: 0, readBody: 0, loadJSON: 0, saveJSON: 0 };
  let captured = null;
  let limiterCall = null;
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const url = new URL('http://localhost/api/template-variables');
  const ctx = {
    path,
    PROJECT_ROOT,
    rateLimit: (key, limit) => { calls.rateLimit += 1; limiterCall = { key, limit }; return rateLimitOk; },
    readBody: async () => { calls.readBody += 1; if (readBodyThrows) throw new Error('readBody failed'); return body; },
    loadJSON: () => { calls.loadJSON += 1; throw new Error('loadJSON must not run on the badbody path'); },
    saveJSON: () => { calls.saveJSON += 1; throw new Error('saveJSON must not run on the badbody path'); },
    sanitizeText: (s) => s,
    json: (_res, status, payload) => { captured = { status, body: payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/template-variables', ctx);
  return { captured, calls, limiterCall };
}

// The outer catch always returns this exact, input-independent golden.
const GOLDEN = { status: 400, body: { error: 'Invalid request' } };

describe('POST /api/template-variables outer catch (content-analysis-c.js)', () => {
  it('returns the fixed 400 Invalid request when readBody rejects, before any store I/O', async () => {
    // The body is a fully valid create payload on purpose: once readBody rejects,
    // even a well-formed request cannot escape the catch, so the body is moot here.
    const { captured, calls, limiterCall } = await createVar({ name: 'ok', value: 'v' }, { readBodyThrows: true });
    assert.deepEqual(captured, GOLDEN);
    // readBody runs once and throws inside the try; the store is never touched.
    assert.equal(calls.readBody, 1, 'the throw happens inside readBody, within the try');
    assert.equal(calls.loadJSON, 0, 'the catch returns before loadJSON (never-reached proof)');
    assert.equal(calls.saveJSON, 0, 'a failed request must not write to disk');
    // Document the gate shape: cleared once with the POST-specific key and ceiling 30.
    assert.equal(calls.rateLimit, 1, 'the limiter is consulted once, ahead of the try');
    assert.equal(limiterCall.key, 'template-vars:127.0.0.1');
    assert.equal(limiterCall.limit, 30);
  });

  it('returns the SAME 400 when readBody resolves null, beating the inner name guard', async () => {
    // readBody resolves null, so `const {name, value} = null` throws a TypeError
    // into the outer catch. The fixed 'Invalid request' is returned before the
    // inner '!name' guard runs, so its 'Missing or invalid name' is never seen.
    const { captured, calls } = await createVar(null);
    assert.deepEqual(captured, GOLDEN);
    assert.notEqual(captured.body.error, 'Missing or invalid name', 'the destructure throw precedes the name guard');
    assert.equal(calls.readBody, 1, 'the body is read once, then the destructure throws');
    assert.equal(calls.loadJSON, 0, 'the catch returns before loadJSON (never-reached proof)');
    assert.equal(calls.saveJSON, 0, 'a failed request must not write to disk');
  });
});
