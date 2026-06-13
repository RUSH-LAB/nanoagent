import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the REAL module the way the sibling
// route tests do (createRequire, no reimplementation).
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-c.js');

// Characterization tests for the currently-uncovered guard branches of
// DELETE /api/template-variables (content-analysis-c.js, handler around L1210 to
// L1225). The POST create handler at the same path is pinned by
// tests/next-template-variables-create-guards.test.mjs; the DELETE handler had no test.
// Guard order in the handler:
//
//   1. !rateLimit('template-vars-del:<addr>', 30)    => 429 'Too many requests...'  (before readBody)
//   2. !name                                         => 400 'Missing name'          (before loadJSON)
//   3. !data.variables || !(name in data.variables)  => 404 'Variable not found'    (after one loadJSON)
//   4. (outer catch: readBody throws)                => 400 'Invalid request'
//
// Every rejected branch returns BEFORE saveJSON, so a rejected request must never
// persist; the mock ctx counts loadJSON and saveJSON to prove that no-disk-write
// contract. The GET sibling stamps new Date(), but this DELETE path reads no clock,
// so every case here is deterministic with no clock, randomness, network, or real
// filesystem.

const PROJECT_ROOT = '/fake/root';

// Invoke the real handler with a mocked ctx. `body` is whatever readBody yields;
// `rateLimitOk` toggles the limiter (false exercises the 429 branch); `stored` is
// what loadJSON returns (the on-disk variables map); `readBodyThrows` exercises the
// outer catch. The `calls` counters let each test assert which side effects ran,
// `saved` records what saveJSON would persist (no real disk write), and
// `limiterCall` captures the exact rate-limit key and ceiling.
async function deleteVar(body, { rateLimitOk = true, stored = {}, readBodyThrows = false } = {}) {
  const calls = { rateLimit: 0, readBody: 0, loadJSON: 0, saveJSON: 0 };
  let captured = null;
  let saved = null;
  let limiterCall = null;
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const url = new URL('http://localhost/api/template-variables');
  const ctx = {
    path,
    PROJECT_ROOT,
    rateLimit: (key, limit) => { calls.rateLimit += 1; limiterCall = { key, limit }; return rateLimitOk; },
    readBody: async () => { calls.readBody += 1; if (readBodyThrows) throw new Error('readBody failed'); return body; },
    loadJSON: () => { calls.loadJSON += 1; return stored; },
    saveJSON: (_fp, data) => { calls.saveJSON += 1; saved = data; },
    json: (_res, status, payload) => { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/template-variables', ctx);
  return { captured, saved, calls, limiterCall };
}

describe('DELETE /api/template-variables guards (content-analysis-c.js)', () => {
  it('returns 429 before reading the body when the limiter rejects (key template-vars-del, ceiling 30, no disk I/O)', async () => {
    const { captured, calls, limiterCall } = await deleteVar({ name: 'ok' }, { rateLimitOk: false });
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.error, 'Too many requests. Try again in a minute.');
    // The limiter is consulted with a DELETE-specific key and a ceiling of 30,
    // distinct from the POST handler's `template-vars:` key.
    assert.equal(limiterCall.key, 'template-vars-del:127.0.0.1');
    assert.equal(limiterCall.limit, 30);
    // The 429 returns at the top of the handler, ahead of `await readBody(req)`.
    assert.equal(calls.readBody, 0, 'a rate-limited request must not read the body');
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0, 'a rate-limited request must not write to disk');
  });

  it('rejects a missing name with 400 before loadJSON (no disk I/O)', async () => {
    // Every body whose `name` is falsy hits the `!name` guard. readBody runs first
    // (the guard sits inside the try), but loadJSON and saveJSON never do.
    for (const body of [{}, { name: '' }, { name: null }]) {
      const label = JSON.stringify(body);
      const { captured, calls } = await deleteVar(body);
      assert.equal(captured.status, 400, `expected 400 for body ${label}`);
      assert.equal(captured.payload.error, 'Missing name', `expected 'Missing name' for body ${label}`);
      assert.equal(calls.readBody, 1, `the body is read before the name guard fires for ${label}`);
      assert.equal(calls.loadJSON, 0, `the name guard returns before loadJSON for ${label}`);
      assert.equal(calls.saveJSON, 0, `a rejected request must not write to disk for ${label}`);
    }
  });

  it('returns 404 when the name is absent from a populated variables map (one loadJSON, no save)', async () => {
    const { captured, calls } = await deleteVar({ name: 'missing' }, { stored: { variables: { keep: 'v' } } });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Variable not found');
    assert.equal(calls.loadJSON, 1, 'the map is loaded exactly once');
    assert.equal(calls.saveJSON, 0, 'a not-found delete must not write to disk');
  });

  it('returns 404 when data.variables is undefined (one loadJSON, no save)', async () => {
    const { captured, calls } = await deleteVar({ name: 'whatever' }, { stored: {} });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Variable not found');
    assert.equal(calls.loadJSON, 1, 'the map is loaded exactly once');
    assert.equal(calls.saveJSON, 0, 'a not-found delete must not write to disk');
  });

  it('returns 400 Invalid request when readBody throws (outer catch, no disk I/O)', async () => {
    const { captured, calls } = await deleteVar({ name: 'ok' }, { readBodyThrows: true });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Invalid request');
    assert.equal(calls.readBody, 1, 'the throw happens inside readBody, within the try');
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0, 'a failed request must not write to disk');
  });

  // Contrast case: a present name is deleted and persisted exactly once, returning
  // {success: true}. This pins that the reject branches above are the only ones that
  // skip the write. Deterministic: the DELETE path reads no clock.
  it('deletes a present variable, saves once, and returns 200 {success: true}', async () => {
    const { captured, saved, calls } = await deleteVar({ name: 'gone' }, { stored: { variables: { gone: 'x', keep: 'y' } } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(calls.loadJSON, 1);
    assert.equal(calls.saveJSON, 1, 'the accepted delete is written exactly once');
    assert.deepEqual(saved, { variables: { keep: 'y' } });
  });
});
