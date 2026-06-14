import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling enrich-post-guards suite does, and reuse its ctx-mocking shape. This
// drives POST /api/references/enrich (the apply-enriched-data handler in
// server/routes/references.js) directly over a mocked ctx, so no network and no
// real filesystem are touched.
//
// Characterization for the currently-uncovered OUTER CATCH of the handler:
//
//   try {
//     const yaml = require('js-yaml');           // module-cached, cannot throw
//     const body = await readBody(req);          // (1) rejects   => throws into catch
//     const {key: citationKey, fields} = body;   // (2) body null => destructure throws
//     ...                                         //     (this beats the inner key guard)
//   } catch (err) { return json(res, 400, {error: 'Invalid request: ' + err.message}); }
//
// This is the err.message-PREFIX variant: a 400 whose body is the fixed prefix
// 'Invalid request: ' plus the thrown error's message. It is DISTINCT from the
// fixed 'Invalid request' badbody golden other handlers use, and from the
// recommendations/add sibling in research-tools.js (same prefix string, DIFFERENT
// endpoint) pinned by tests/next-recadd-validation-guards.test.mjs; this suite
// drives /api/references/enrich so it cannot be confused with that sibling. The
// guard-ladder suite next-references-enrich-post-guards.test.mjs always resolves
// readBody to a valid object and returns through the inner guards, so it never
// reaches this catch.
//
// readBody is the first failable step inside the try (the preceding
// require('js-yaml') is module-cached and cannot throw), so the catch is reached
// before any filesystem I/O. fs is ctx-injected here, so readFileSync and
// writeFileSync are wired as tripwires that throw on contact AND count their
// calls: count === 0 is the never-reached proof. The success path returns
// 200 {success, entry}, so the absence of any 200 is a second never-reached
// proof. The handler clears the limiter before the try, so rateLimit is stubbed
// to true to reach the catch. Deterministic: this path reads no clock,
// randomness, network, or real filesystem.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');

const PROJECT_ROOT = '/proj';

// Invoke the POST enrich handler with a mocked ctx. `body` is whatever readBody
// yields; `readBodyError`, when set, makes readBody reject with that Error
// (trigger 1). readFileSync and writeFileSync throw if ever called, so reaching
// them fails the test loudly, and the `calls` counters additionally assert each
// ran zero times. `limiterCall` captures the exact rate-limit key and ceiling to
// document the gate and pin the endpoint identity.
async function invoke({ body, readBodyError, rateLimited = false, remoteAddress = '127.0.0.1' }) {
  const pathname = '/api/references/enrich';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };

  const calls = { rateLimit: 0, readBody: 0, readFileSync: 0, writeFileSync: 0 };
  let captured = null;
  let limiterCall = null;

  const ctx = {
    json(_res, status, payload) { captured = { status, body: payload }; res.writableEnded = true; return captured; },
    readBody: async () => { calls.readBody += 1; if (readBodyError) throw readBodyError; return body; },
    rateLimit: (key, limit) => { calls.rateLimit += 1; limiterCall = { key, limit }; return !rateLimited; },
    sanitizeText: (s) => s,
    fs: {
      readFileSync: () => { calls.readFileSync += 1; throw new Error('readFileSync must not run on the outer-catch path'); },
      writeFileSync: () => { calls.writeFileSync += 1; throw new Error('writeFileSync must not run on the outer-catch path'); },
    },
    path,
    PROJECT_ROOT,
  };

  await routes(req, res, url, pathname, ctx);
  return { captured, calls, limiterCall };
}

describe('POST /api/references/enrich outer catch (references.js)', () => {
  it('returns 400 "Invalid request: " + err.message when readBody rejects, before any filesystem I/O', async () => {
    // The body is a fully valid enrich payload on purpose: once readBody rejects,
    // even a well-formed request cannot escape the catch, so the body is moot.
    // The controlled message 'boom' proves the throw originated in readBody (the
    // first failable step), not in a later yaml.load or fs failure, which would
    // carry a different message.
    const { captured, calls, limiterCall } = await invoke({
      body: { key: 'doe2021', fields: { title: 'T' } },
      readBodyError: new Error('boom'),
    });

    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request: boom' } });
    // readBody runs once and throws inside the try; the filesystem is never touched.
    assert.equal(calls.readBody, 1, 'the throw happens inside readBody, within the try');
    assert.equal(calls.readFileSync, 0, 'the catch returns before fs.readFileSync (never-reached proof)');
    assert.equal(calls.writeFileSync, 0, 'a failed request must not write the bibliography');
    assert.notEqual(captured.status, 200, 'the 200 success path is never reached');
    // Document the gate and pin the endpoint identity: cleared once with the
    // enrich-specific key and ceiling 10 (distinct from the add-rec sibling).
    assert.equal(calls.rateLimit, 1, 'the limiter is consulted once, ahead of the try');
    assert.equal(limiterCall.key, 'enrich-ref:127.0.0.1');
    assert.equal(limiterCall.limit, 10);
  });

  it('returns a 400 with the "Invalid request: " prefix when readBody resolves null (destructure throws)', async () => {
    // readBody resolves null, so `const {key: citationKey, fields} = null` throws a
    // TypeError into the outer catch. The 400 carries the same fixed prefix plus
    // the destructure error message, and the inner '!citationKey' guard
    // ('Missing or invalid key') is never reached.
    const { captured, calls } = await invoke({ body: null });

    assert.equal(captured.status, 400);
    assert.ok(
      captured.body.error.startsWith('Invalid request: '),
      `expected an "Invalid request: " prefix, got ${JSON.stringify(captured.body.error)}`,
    );
    assert.notEqual(captured.body.error, 'Missing or invalid key', 'the destructure throw precedes the key guard');
    assert.equal(calls.readBody, 1, 'the body is read once, then the destructure throws');
    assert.equal(calls.readFileSync, 0, 'the catch returns before fs.readFileSync (never-reached proof)');
    assert.equal(calls.writeFileSync, 0, 'a failed request must not write the bibliography');
  });
});
