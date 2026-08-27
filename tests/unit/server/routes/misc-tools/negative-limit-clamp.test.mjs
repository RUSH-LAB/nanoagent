import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// misc-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../server/routes/misc-tools.js');

// Invoke a misc-tools route handler with a minimal mocked ctx and capture the
// response the handler hands to `json(res, status, payload)`.
async function invoke({ method = 'GET', pathname, search = '', ctx = {} }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    ...ctx,
  };
  await miscToolsRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

// A negative `?limit` used to flow straight into `slice(0, limit)`, which counts
// from the END of the array: it dropped the last |limit| rows and returned a
// near-full page while `total` still reported every row. The fix lower-clamps
// the limit to 0, so a negative limit now yields an empty page and `total` stays
// the full count. Each feed below holds 250 rows, so the pre-fix tail drop
// (`?limit=-5` returned 245 rows) was plainly non-empty and the post-fix empty
// page (0 rows) is unmistakable.

describe('GET /api/changelog negative limit clamp', () => {
  const COMMENTS_FILE = '/tmp/misc-tools-neg-changelog-comments.json';
  const DISCUSSIONS_FILE = '/tmp/misc-tools-neg-changelog-discussions.json';
  const comments = {
    'content/page.md': Array.from({ length: 250 }, (_, i) => ({
      author: 'tester',
      text: `comment ${i}`,
      createdAt: `2026-01-01T00:00:00.${String(i).padStart(3, '0')}Z`,
    })),
  };
  const discData = { messages: {} };
  const ctx = {
    loadJSON: file => (file === COMMENTS_FILE ? comments : discData),
    COMMENTS_FILE,
    DISCUSSIONS_FILE,
  };
  const call = search => invoke({ pathname: '/api/changelog', search, ctx });

  it('negative limit yields an empty page, total unchanged', async () => {
    const r = await call('?limit=-5');
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 250, 'total still reports every row');
    assert.equal(r.payload.events.length, 0, 'clamped to 0, not a count-from-the-end tail drop (245)');
  });

  it('valid positive limit is honored', async () => {
    const r = await call('?limit=10');
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 250);
    assert.equal(r.payload.events.length, 10);
  });

  it('absent limit returns the default-sized page (50)', async () => {
    const r = await call('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 250);
    assert.equal(r.payload.events.length, 50);
  });

  it('over-cap limit clamps to 200', async () => {
    const r = await call('?limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 250);
    assert.equal(r.payload.events.length, 200);
  });
});

describe('GET /api/annotations/shared negative limit clamp', () => {
  const ANNOTATIONS_FILE = '/tmp/misc-tools-neg-annotations-shared.json';
  const annotations = {
    'content/page.md': Array.from({ length: 250 }, (_, i) => ({
      id: `a${i}`,
      text: `annotation ${i}`,
      createdAt: `2026-01-01T00:00:00.${String(i).padStart(3, '0')}Z`,
    })),
  };
  const ctx = { loadJSON: () => annotations, ANNOTATIONS_FILE };
  const call = search => invoke({ pathname: '/api/annotations/shared', search, ctx });

  it('negative limit yields an empty page, total unchanged', async () => {
    const r = await call('?limit=-5');
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 250, 'total still reports every row');
    assert.equal(r.payload.annotations.length, 0, 'clamped to 0, not a count-from-the-end tail drop (245)');
  });

  it('valid positive limit is honored', async () => {
    const r = await call('?limit=10');
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 250);
    assert.equal(r.payload.annotations.length, 10);
  });

  it('absent limit returns the default-sized page (50)', async () => {
    const r = await call('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 250);
    assert.equal(r.payload.annotations.length, 50);
  });

  it('over-cap limit clamps to 200', async () => {
    const r = await call('?limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 250);
    assert.equal(r.payload.annotations.length, 200);
  });
});
