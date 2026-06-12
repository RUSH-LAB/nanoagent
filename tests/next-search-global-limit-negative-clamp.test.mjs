import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

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
    PROJECT_ROOT: '/tmp/next-search-global-limit-negative-clamp-test',
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

// 120 matching comments so the default page (30) and the over-cap clamp (100)
// are both observable, and so a negative slice would keep an observably
// non-empty wrong tail rather than collapsing to nothing by accident.
const comments = makeComments(120);
const total = 120;

// A negative `limit` parses cleanly (it is not NaN), so `numericParam` passed it
// straight through before this fix and the handler ran `results.slice(0, limit)`.
// `slice(0, negative)` counts from the END, dropping the last |limit| matches and
// returning a wrong page that is also larger than the non-positive limit asked
// for. The call-site lower clamp floors the limit to 0, so a negative request
// now yields an empty page while `total` still reports the full match count.
// Each case below is chosen so the PRE-FIX handler returned a NON-empty page,
// making every assertion a real regression guard rather than a tautology.
describe('GET /api/search/global negative-limit clamp', () => {
  it('clamps limit=-1 to 0 instead of dropping the last match off the end', async () => {
    const r = await searchGlobal(`?q=${QUERY}&limit=-1`, comments);
    // Pre-fix: slice(0, -1) returned the first 119 matches; post-fix it is empty.
    assert.equal(r.status, 200);
    assert.equal(r.payload.results.length, 0);
    assert.equal(r.payload.total, total);
  });

  it('clamps a more negative limit that would have dropped several off the end', async () => {
    const r = await searchGlobal(`?q=${QUERY}&limit=-5`, comments);
    // Pre-fix: slice(0, -5) returned the first 115 matches; post-fix it is empty.
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.results, []);
    assert.equal(r.payload.total, total);
  });
});

// The lower clamp is a no-op for every non-negative limit `numericParam` can
// produce, so these cases must return exactly what they returned before the fix.
describe('GET /api/search/global non-negative limits are unchanged', () => {
  it('honors a valid positive limit', async () => {
    const r = await searchGlobal(`?q=${QUERY}&limit=5`, comments);
    assert.equal(r.status, 200);
    assert.equal(r.payload.results.length, 5);
    assert.equal(r.payload.total, total);
  });

  it('returns the default-sized page for an absent limit', async () => {
    const r = await searchGlobal(`?q=${QUERY}`, comments);
    assert.equal(r.status, 200);
    assert.equal(r.payload.results.length, 30);
    assert.equal(r.payload.total, total);
  });

  it('clamps an over-cap limit to the max (100), not to 0', async () => {
    const r = await searchGlobal(`?q=${QUERY}&limit=200`, comments);
    assert.equal(r.status, 200);
    assert.equal(r.payload.results.length, 100);
    assert.equal(r.payload.total, total);
  });

  it('falls back to the default page for a non-numeric limit', async () => {
    const def = await searchGlobal(`?q=${QUERY}`, comments);
    const bad = await searchGlobal(`?q=${QUERY}&limit=abc`, comments);
    assert.equal(bad.status, 200);
    assert.equal(bad.payload.results.length, 30);
    assert.ok(bad.payload.results.length > 0, 'matches are not silently dropped');
    assert.deepEqual(bad.payload, def.payload, 'matches the absent-limit result');
  });
});
