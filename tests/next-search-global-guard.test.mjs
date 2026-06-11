import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');
const { numericParam } = fileToolsRoutes;

const QUERY = 'term';

// Build `n` comments under a single page, each containing the search query so
// every one is a match. Lets us drive a deterministic result count through the
// /api/search/global comment branch.
function makeComments(n) {
  return { page1: Array.from({ length: n }, (_, i) => ({ text: `${QUERY} comment ${i}`, author: 'a' })) };
}

// Invoke the /api/search/global handler with a minimal mocked ctx and capture
// the response handed to `json(res, status, payload)`. The content-directory
// and references branches are stubbed to contribute nothing (readdir empty,
// readFile throwing) so the only matches come from the supplied comments.
async function searchGlobal(search, comments) {
  const url = new URL(`http://localhost/api/search/global${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-search-global-guard-test',
    ALLOWED_EXTS: ['.md', '.mdx'],
    fs: {
      readdirSync: () => [],
      readFileSync: () => { throw new Error('no file'); },
    },
    COMMENTS_FILE: 'comments',
    DISCUSSIONS_FILE: 'discussions',
    loadJSON: (file) => (file === 'comments' ? comments : {}),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await fileToolsRoutes(req, res, url, '/api/search/global', ctx);
  return captured;
}

describe('numericParam helper', () => {
  it('is exported alongside the route handler', () => {
    assert.equal(typeof fileToolsRoutes, 'function', 'default export is the route handler');
    assert.equal(typeof numericParam, 'function', 'numericParam is exported');
  });

  it('returns the default for absent values (null / empty string)', () => {
    assert.equal(numericParam(null, 30, 100), 30);
    assert.equal(numericParam('', 30, 100), 30);
  });

  it('passes valid numeric values through unchanged', () => {
    assert.equal(numericParam('50', 30, 100), 50);
    assert.equal(numericParam('1', 30, 100), 1);
  });

  it('clamps an over-cap value to the max', () => {
    assert.equal(numericParam('200', 30, 100), 100);
  });

  it('returns the default for a non-numeric value instead of NaN', () => {
    assert.equal(numericParam('abc', 30, 100), 30);
    assert.ok(!Number.isNaN(numericParam('abc', 30, 100)), 'never yields NaN');
  });

  it('keeps parseInt semantics for leading-numeric values', () => {
    assert.equal(numericParam('12abc', 30, 100), 12);
  });
});

describe('GET /api/search/global limit guard', () => {
  // 120 matching comments so the default (30) and the clamp (100) are both
  // observable, and so the broken NaN path (an empty page) is distinguishable.
  const comments = makeComments(120);
  const total = 120;

  it('rejects a missing query before touching the limit', async () => {
    const r = await searchGlobal('?limit=abc', comments);
    assert.equal(r.status, 400);
    assert.equal(r.payload.error, 'Missing query');
  });

  it('absent limit returns the default-sized page (30)', async () => {
    const r = await searchGlobal(`?q=${QUERY}`, comments);
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, total);
    assert.equal(r.payload.results.length, 30);
  });

  it('valid limit is honored', async () => {
    const r = await searchGlobal(`?q=${QUERY}&limit=5`, comments);
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, total);
    assert.equal(r.payload.results.length, 5);
  });

  it('valid limit above the cap clamps to 100', async () => {
    const r = await searchGlobal(`?q=${QUERY}&limit=200`, comments);
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, total);
    assert.equal(r.payload.results.length, 100);
  });

  it('non-numeric limit returns the default page instead of an empty one', async () => {
    const def = await searchGlobal(`?q=${QUERY}`, comments);
    const bad = await searchGlobal(`?q=${QUERY}&limit=abc`, comments);
    assert.equal(bad.status, 200);
    assert.equal(bad.payload.results.length, 30, 'guarded to default, not an empty page');
    assert.ok(bad.payload.results.length > 0, 'matches are not silently dropped');
    assert.deepEqual(bad.payload, def.payload, 'matches the absent-limit result');
  });
});
