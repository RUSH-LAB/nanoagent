import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// misc-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../src/server/routes/misc-tools.js');
const { numericParam } = miscToolsRoutes;

// Invoke a misc-tools route handler with a minimal mocked ctx and capture the
// response that the handler hands to `json(res, status, payload)`.
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

describe('numericParam helper', () => {
  it('is exported alongside the route handler', () => {
    assert.equal(typeof miscToolsRoutes, 'function', 'default export is the route handler');
    assert.equal(typeof numericParam, 'function', 'numericParam is exported');
  });

  // ── changelog / annotations call site: numericParam(raw, 50, 200) ──
  it('returns the default for absent values (null / empty string)', () => {
    assert.equal(numericParam(null, 50, 200), 50);
    assert.equal(numericParam('', 50, 200), 50);
  });

  it('passes valid numeric values through unchanged', () => {
    assert.equal(numericParam('10', 50, 200), 10);
    assert.equal(numericParam('0', 50, 200), 0);
  });

  it('clamps valid numeric values above the cap to 200', () => {
    assert.equal(numericParam('500', 50, 200), 200);
    assert.equal(numericParam('200', 50, 200), 200);
  });

  it('returns the default for non-numeric values and never yields NaN', () => {
    assert.equal(numericParam('abc', 50, 200), 50);
    assert.ok(!Number.isNaN(numericParam('abc', 50, 200)), 'limit guard never NaN');
  });
});

describe('GET /api/changelog limit guard', () => {
  // 250 comments under one page so the default page
  // (50), the clamp (200), and the broken NaN path (slice(0, NaN) === empty) are
  // all distinguishable. loadJSON is keyed off the file path the handler reads.
  const COMMENTS_FILE = '/tmp/misc-tools-changelog-comments.json';
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
  };
  const call = search => invoke({ pathname: '/api/changelog', search, ctx });

  it('absent limit returns the default-sized page (50)', async () => {
    const r = await call('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 250);
    assert.equal(r.payload.events.length, 50, 'default limit is 50');
  });

  it('valid limit is honored', async () => {
    const r = await call('?limit=10');
    assert.equal(r.status, 200);
    assert.equal(r.payload.events.length, 10);
  });

  it('over-cap limit clamps to 200', async () => {
    const r = await call('?limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.payload.events.length, 200);
  });

  it('non-numeric limit yields the default-bounded page, not an empty one', async () => {
    const r = await call('?limit=abc');
    assert.equal(r.status, 200);
    assert.equal(r.payload.events.length, 50, 'guarded to default 50, not slice(0, NaN) === []');
    assert.notEqual(r.payload.events.length, 0, 'page is not collapsed to empty');
  });
});

describe('GET /api/annotations/shared limit guard', () => {
  // 250 annotations under one page so the default (50), the clamp (200), and the
  // broken NaN path are all observable.
  const ANNOTATIONS_FILE = '/tmp/misc-tools-annotations-shared.json';
  const annotations = {
    'content/page.md': Array.from({ length: 250 }, (_, i) => ({
      id: `a${i}`,
      text: `annotation ${i}`,
      createdAt: `2026-01-01T00:00:00.${String(i).padStart(3, '0')}Z`,
    })),
  };
  const ctx = { loadJSON: () => annotations, ANNOTATIONS_FILE };
  const call = search => invoke({ pathname: '/api/annotations/shared', search, ctx });

  it('absent limit returns the default-sized page (50)', async () => {
    const r = await call('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 250);
    assert.equal(r.payload.annotations.length, 50, 'default limit is 50');
  });

  it('valid limit is honored', async () => {
    const r = await call('?limit=10');
    assert.equal(r.status, 200);
    assert.equal(r.payload.annotations.length, 10);
  });

  it('over-cap limit clamps to 200', async () => {
    const r = await call('?limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.payload.annotations.length, 200);
  });

  it('non-numeric limit yields the default-bounded page, not an empty one', async () => {
    const r = await call('?limit=abc');
    assert.equal(r.status, 200);
    assert.equal(r.payload.annotations.length, 50, 'guarded to default 50, not slice(0, NaN) === []');
    assert.notEqual(r.payload.annotations.length, 0, 'page is not collapsed to empty');
  });
});
