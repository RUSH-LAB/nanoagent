import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling guard suites do (next-misctools-goals-create-guards.test.mjs and
// next-misctools-create-write-guards.test.mjs) so these cases exercise the
// shipped POST /api/reading-progress handler in server/routes/misc-tools.js
// rather than a reimplementation. The handler runs over a fully mocked ctx: no
// real filesystem, network, clock, or randomness is touched, except where a stub
// deliberately stands in for one.
//
// This is an add-only characterization test. Every branch pinned below is a guard
// that rejects before the store is read or written, so the handler reaches no
// loadJSON, saveJSON, sanitizeText, clock, or random call. These cases pin the
// CURRENT, correct guard behavior so a future refactor cannot silently change a
// status code, an error message, or the order in which the guards run. No source
// file is edited.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';
// The reading-progress store path is built inside the handler as
// path.join(PROJECT_ROOT, 'var', 'data', 'reading-progress.json'); it is not a ctx
// field. The mocked loadJSON answers only for this exact path, so a stray read on
// a guard branch surfaces as a thrown error instead of silently passing.
const PROGRESS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'reading-progress.json');

// Drive POST /api/reading-progress over a mocked ctx. rateLimit records each call
// (key and limit) and returns the per-call toggle; readBody returns the supplied
// body and counts its calls; loadJSON returns a fresh deep copy of `store` keyed
// on PROGRESS_FILE and counts its calls; saveJSON records every persist;
// sanitizeText is the identity (guard branches never reach it); json captures the
// (status, body) handed back. The counters let each guard branch prove the store
// was never read or written and that the 429 rejects before the body is read.
async function runReadingProgress({
  body = {},
  store = {},
  rateLimitOk = true,
  throwOnReadBody = false,
  userId = 'reader-1',
} = {}) {
  const saved = [];
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let loadJSONCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return rateLimitOk; },
    readBody: async () => {
      readBodyCount++;
      if (throwOnReadBody) throw new Error('readBody failed');
      return body;
    },
    sanitizeText: (s) => s,
    loadJSON: (fp) => {
      loadJSONCount++;
      if (fp === PROGRESS_FILE) return JSON.parse(JSON.stringify(store));
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    path,
    PROJECT_ROOT,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/reading-progress';
  const url = new URL(`http://localhost${pathname}`);
  // The store key is the session subject, attached by server/index.js after it
  // verifies the Clerk token. It is no longer a body field, so none of the
  // guards below concern it.
  const auth = { userId, orgId: null, orgRole: null, sessionId: null };
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, auth };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { captured, saved, readBodyCount, loadJSONCount, rateLimitCalls };
}

describe('POST /api/reading-progress guards in routes/misc-tools.js', () => {
  it('a rate-limited request returns 429, never reads the body, loads, or saves, and uses the reading-progress key with limit 60', async () => {
    const r = await runReadingProgress({ rateLimitOk: false, body: { pagePath: '/reading/page-1' } });
    assert.equal(r.captured.status, 429);
    assert.deepEqual(r.captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(r.readBodyCount, 0, 'the rate-limit guard returns before readBody');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
    // Pin the per-handler rate-limit identity. The reading-progress key with limit
    // 60 distinguishes this handler from the other POST handlers in this module
    // that share the 429 string but throttle under their own keys and limits.
    assert.equal(r.rateLimitCalls.length, 1);
    assert.deepEqual(r.rateLimitCalls[0], { key: 'reading-progress:127.0.0.1', limit: 60 });
  });

  // The userId type, length, and prototype-key guards this suite used to pin
  // are gone: identity is no longer a body field. A body carrying one is simply
  // ignored, which the last case here proves.
  it('an empty body has no pagePath, returning 400 Missing or invalid pagePath, reading the body once, never loading or saving', async () => {
    const r = await runReadingProgress({ body: {} });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing or invalid pagePath' });
    assert.equal(r.readBodyCount, 1, 'the body is read before pagePath is validated');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a non-string pagePath (99) trips the typeof guard, returning 400 Missing or invalid pagePath, never loading or saving', async () => {
    const r = await runReadingProgress({ body: { pagePath: 99 } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing or invalid pagePath' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a 501-character pagePath clears the typeof guard but trips the length guard, returning 400 pagePath must be 500 characters or fewer', async () => {
    const r = await runReadingProgress({ body: { pagePath: 'p'.repeat(501) } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'pagePath must be 500 characters or fewer' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a constructor pagePath is a reserved key, returning 400 Invalid key, never loading or saving', async () => {
    // pagePath is still client-supplied and still keys the inner map, so its
    // prototype-key guard survives; 'constructor' clears the type and length
    // guards and is rejected by that check.
    const r = await runReadingProgress({ body: { pagePath: 'constructor' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid key' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a prototype pagePath is a reserved key, returning 400 Invalid key, never loading or saving', async () => {
    const r = await runReadingProgress({ body: { pagePath: 'prototype' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid key' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a __proto__ userId in the body is ignored, and the write lands on the session subject', async () => {
    // Under the old handler this body was a 400 Invalid key, because the store
    // key came from the body. It is now inert data: the guard never sees it and
    // the entry is filed under the authenticated caller.
    const store = {};
    const r = await runReadingProgress({ body: { userId: '__proto__', pagePath: '/reading/page-1', progress: 40 }, store });
    assert.deepEqual([r.captured.status, r.captured.body], [200, { success: true }]);
    assert.deepEqual(Object.keys(r.saved[0].data), ['reader-1']);
    assert.equal(r.saved[0].data['reader-1']['/reading/page-1'].progress, 40);
    assert.equal({}.polluted, undefined);
  });

  it('an outer throw (readBody fails) returns 400 Invalid request, reads the body once, never loading or saving', async () => {
    // readBody runs inside the try with no inner parse guard, so its rejection
    // lands on the outer catch as a 400 Invalid request, not a validation 400.
    const r = await runReadingProgress({ throwOnReadBody: true, body: { pagePath: '/reading/page-1' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid request' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });
});
