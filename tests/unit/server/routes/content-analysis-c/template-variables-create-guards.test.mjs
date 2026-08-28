import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the REAL module the way the sibling
// route tests do (createRequire, no reimplementation).
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-c.js');

// Characterization tests for the currently-uncovered guard branches of
// POST /api/template-variables (content-analysis-c.js, handler around L1187 to
// L1208). Guard order in the handler:
//
//   1. !rateLimit('template-vars:...')    => 429 'Too many requests...'
//   2. !name || typeof name !== 'string'  => 400 'Missing or invalid name'                   (pinned elsewhere)
//   3. typeof value !== 'string'          => 400 'Missing or invalid value (must be a string)'
//   4. name.length > 100                  => 400 'Name must be 100 characters or fewer'
//   5. value.length > 5000                => 400 'Value must be 5000 characters or fewer'
//   6. TEMPLATE_VAR_PROTO_KEYS.has(name)  => 400 'Invalid variable name'                      (pinned elsewhere)
//   7. !TEMPLATE_VAR_NAME_RE.test(name)   => 400 'Variable name must be alphanumeric ...'     (pinned elsewhere)
//
// Only branches 1, 3, 4 and 5 are pinned here. The name-presence, proto-key and
// name-format branches are already covered by next-templatevars-name-re-hoist.test.mjs
// and next-templatevars-hoist-protoset.test.mjs, so they are intentionally not
// re-pinned. Every guard returns BEFORE loadJSON(VARS_FILE) (around L1200), so a
// rejected request must touch neither loadJSON nor saveJSON; the mock ctx counts
// those calls to prove that no-disk-write contract.

const PROJECT_ROOT = '/fake/root';

// Invoke the real handler with a mocked ctx. `body` is whatever readBody yields;
// `rateLimitOk` toggles the limiter (false exercises the 429 branch). The returned
// `calls` counters let each test assert which side effects ran, and `saved` records
// what saveJSON would persist on the accept path (no real disk write).
async function postVar(body, { rateLimitOk = true } = {}) {
  const calls = { readBody: 0, loadJSON: 0, saveJSON: 0 };
  let captured = null;
  let saved = null;
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const url = new URL('http://localhost/api/template-variables');
  const ctx = {
    path,
    PROJECT_ROOT,
    // The limiter is stubbed to a boolean toggle; the real key and limit (30)
    // are irrelevant to these guard-branch tests.
    rateLimit: () => rateLimitOk,
    readBody: async () => { calls.readBody += 1; return body; },
    loadJSON: () => { calls.loadJSON += 1; return {}; },
    saveJSON: (_fp, data) => { calls.saveJSON += 1; saved = data; },
    sanitizeText: (s) => s,
    json: (_res, status, payload) => { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/template-variables', ctx);
  return { captured, saved, calls };
}

describe('POST /api/template-variables value/length/429 guards (content-analysis-c.js)', () => {
  it('returns 429 before reading the body when the limiter rejects (no body read, no disk I/O)', async () => {
    const { captured, calls } = await postVar({ name: 'ok', value: 'v' }, { rateLimitOk: false });
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.error, 'Too many requests. Try again in a minute.');
    // The 429 returns at the top of the handler, ahead of `await readBody(req)`.
    assert.equal(calls.readBody, 0, 'a rate-limited request must not read the body');
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0, 'a rate-limited request must not write to disk');
  });

  it('rejects a missing value with 400 (key absent, so typeof is "undefined")', async () => {
    // name is a valid string, so the guard reached is the value-type check rather
    // than the 'Missing or invalid name' check (pinned in a sibling test).
    const { captured, calls } = await postVar({ name: 'ok' });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid value (must be a string)');
    assert.equal(calls.readBody, 1, 'the body is read before the value guard fires');
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0, 'a rejected request must not write to disk');
  });

  it('rejects a non-string value with 400 for every non-string type', async () => {
    for (const value of [123, null, true, {}, []]) {
      const { captured, calls } = await postVar({ name: 'ok', value });
      assert.equal(captured.status, 400, `expected 400 for value ${JSON.stringify(value)}`);
      assert.equal(captured.payload.error, 'Missing or invalid value (must be a string)');
      assert.equal(calls.readBody, 1, 'the body is read before the value guard fires');
      assert.equal(calls.loadJSON, 0);
      assert.equal(calls.saveJSON, 0);
    }
  });

  it('rejects a value longer than 5000 characters with 400', async () => {
    // name is short, so the name-length guard (checked first) does not fire.
    const { captured, calls } = await postVar({ name: 'ok', value: 'a'.repeat(5001) });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Value must be 5000 characters or fewer');
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });

  it('rejects a name longer than 100 characters with 400', async () => {
    // value is a valid (empty) string, so the value-type guard passes and the
    // name-length guard is the one that fires.
    const { captured, calls } = await postVar({ name: 'a'.repeat(101), value: '' });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Name must be 100 characters or fewer');
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });

  // Boundary cases pin the strict `>` comparisons: a value of exactly 5000 chars
  // and a name of exactly 100 chars are ACCEPTED and reach the persist path.
  it('accepts a value of exactly 5000 characters (the value-length bound is strict)', async () => {
    const value = 'a'.repeat(5000);
    const { captured, saved, calls } = await postVar({ name: 'ok', value });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true, name: 'ok', value });
    assert.equal(calls.saveJSON, 1, 'the accepted variable is written exactly once');
    assert.deepEqual(saved, { variables: { ok: value } });
  });

  it('accepts a name of exactly 100 characters (the name-length bound is strict)', async () => {
    const name = 'a'.repeat(100);
    const { captured, saved, calls } = await postVar({ name, value: 'v' });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true, name, value: 'v' });
    assert.equal(calls.saveJSON, 1);
    assert.deepEqual(saved, { variables: { [name]: 'v' } });
  });
});
