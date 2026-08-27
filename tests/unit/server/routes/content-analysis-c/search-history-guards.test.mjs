import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the REAL module the way the other server
// route tests do (mirroring next-templatevars-hoist-protoset.test.mjs). The POST
// /api/search/history handler (roughly lines 97 to 122) lives in this module, so
// these tests exercise the genuine guard branches rather than a reimplementation.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

const PROJECT_ROOT = '/fake/root';

// Drive the real POST /api/search/history handler through a mocked ctx and capture
// the json(res, status, payload) response plus counters that prove no search-history
// read or write happened. Every guard returns before loadJSON at line 108, so on a
// rejected path the handler never touches the filesystem. Defaults: rateLimit allows
// the request and readBody resolves to `body` (unless readBodyThrows is set). loadJSON
// throws so any case that wrongly falls through to the success path surfaces as a
// failure instead of passing silently; it still bumps loadCount, and saveJSON bumps
// saveCount, so assertNoIO can prove neither ran on a rejected path.
async function invoke({
  body,
  readBodyThrows = false,
  rateLimit = () => true,
} = {}) {
  const pathname = '/api/search/history';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCount = 0;
  let saveCount = 0;
  const ctx = {
    path,
    PROJECT_ROOT,
    rateLimit,
    readBody: async () => {
      if (readBodyThrows) throw new Error('readBody failed');
      return body;
    },
    loadJSON: () => { loadCount++; throw new Error('no real read in guard tests'); },
    saveJSON: () => { saveCount++; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return { captured, loadCount, saveCount };
}

// Shared assertion: a rejected request reads nothing and writes nothing.
function assertNoIO({ loadCount, saveCount }) {
  assert.equal(loadCount, 0, 'a rejected request never loads search-history.json');
  assert.equal(saveCount, 0, 'a rejected request never saves search-history.json');
}

describe('POST /api/search/history guard branches (no read or write on any rejected path)', () => {
  // Scope: this file pins only the rejection branches. The 200 success path is
  // deliberately out of scope, since loadJSON is stubbed to throw so any accidental
  // fall-through surfaces as a failure rather than passing silently.
  it('returns 429 when rate-limited, before readBody is reached', async () => {
    // The rate-limit guard returns before the try block, so readBody is never
    // awaited. readBodyThrows proves it: a 429 (not the catch-path 'Invalid
    // request') means readBody was not reached on this path.
    const result = await invoke({
      body: { query: 'hello' },
      rateLimit: () => false,
      readBodyThrows: true,
    });
    assert.equal(result.captured.status, 429);
    assert.deepEqual(result.captured.payload, { error: 'Too many requests. Try again in a minute.' });
    assertNoIO(result);
  });

  it("returns 400 'Missing or invalid query' when query is absent", async () => {
    const result = await invoke({ body: {} });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Missing or invalid query' });
    assertNoIO(result);
  });

  it("returns 400 'Missing or invalid query' when query is an empty string", async () => {
    // An empty string is falsy, so the `!query` half of the guard rejects it.
    const result = await invoke({ body: { query: '' } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Missing or invalid query' });
    assertNoIO(result);
  });

  it("returns 400 'Missing or invalid query' when query is not a string", async () => {
    // A number is truthy, so the `typeof query !== 'string'` half rejects it.
    const result = await invoke({ body: { query: 42 } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Missing or invalid query' });
    assertNoIO(result);
  });

  it('returns 400 when query is longer than 500 characters', async () => {
    const result = await invoke({ body: { query: 'a'.repeat(501) } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Query must be 500 characters or fewer' });
    assertNoIO(result);
  });

  it('returns 400 when userId is present but not a string', async () => {
    const result = await invoke({ body: { query: 'hi', userId: 99 } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'userId must be a string' });
    assertNoIO(result);
  });

  it('returns 400 when userId is longer than 200 characters', async () => {
    const result = await invoke({ body: { query: 'hi', userId: 'u'.repeat(201) } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'userId must be 200 characters or fewer' });
    assertNoIO(result);
  });

  it('returns 400 when resultCount is not a number', async () => {
    const result = await invoke({ body: { query: 'hi', resultCount: 'five' } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'resultCount must be a non-negative number' });
    assertNoIO(result);
  });

  it('returns 400 when resultCount is not finite (Infinity or NaN)', async () => {
    for (const bad of [Infinity, NaN]) {
      const result = await invoke({ body: { query: 'hi', resultCount: bad } });
      assert.equal(result.captured.status, 400);
      assert.deepEqual(result.captured.payload, { error: 'resultCount must be a non-negative number' });
      assertNoIO(result);
    }
  });

  it('returns 400 when resultCount is negative', async () => {
    const result = await invoke({ body: { query: 'hi', resultCount: -1 } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'resultCount must be a non-negative number' });
    assertNoIO(result);
  });

  it("returns 400 'Invalid request' when readBody throws (catch path)", async () => {
    // Distinct from the validation 400s: this is the try/catch fallback. readBody
    // is reached before any field guard, so still no read or write.
    const result = await invoke({ readBodyThrows: true });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Invalid request' });
    assertNoIO(result);
  });
});
