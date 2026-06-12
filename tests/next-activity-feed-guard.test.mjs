import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');
const { numericParam } = routes;

// Invoke a content-analysis-a route handler with a minimal mocked ctx and
// capture the response that the handler hands to `json(res, status, payload)`.
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
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('numericParam helper', () => {
  it('is exported alongside the route handler', () => {
    assert.equal(typeof routes, 'function', 'default export is the route handler');
    assert.equal(typeof numericParam, 'function', 'numericParam is exported');
  });

  // ── activity-feed call site: numericParam(raw, 30, 100) ──
  it('returns the default for absent values (null / empty string)', () => {
    assert.equal(numericParam(null, 30, 100), 30);
    assert.equal(numericParam('', 30, 100), 30);
    assert.equal(numericParam(null, 3, 5), 3);
  });

  it('passes valid numeric values through unchanged', () => {
    assert.equal(numericParam('5', 30, 100), 5);
    assert.equal(numericParam('0', 30, 100), 0);
    assert.equal(numericParam('3', 3, 5), 3);
  });

  it('clamps valid numeric values above the cap', () => {
    assert.equal(numericParam('200', 30, 100), 100);
    assert.equal(numericParam('10', 3, 5), 5);
  });

  it('returns the default for non-numeric values and never yields NaN', () => {
    assert.equal(numericParam('abc', 30, 100), 30);
    assert.equal(numericParam('abc', 3, 5), 3);
    assert.ok(!Number.isNaN(numericParam('abc', 30, 100)), 'limit guard never NaN');
    assert.ok(!Number.isNaN(numericParam('abc', 3, 5)), 'depth guard never NaN');
  });
});

describe('GET /api/activity-feed limit guard', () => {
  // 110 comment events so the default (30), the clamp (100), and the broken NaN
  // path (slice(0, NaN) === empty) are all distinguishable from one another.
  const comments = {
    page1: Array.from({ length: 110 }, (_, i) => ({
      author: 'a',
      text: 'hello',
      createdAt: `2024-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    })),
  };
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/activity-feed-test',
    COMMENTS_FILE: 'comments',
    DISCUSSIONS_FILE: 'discussions',
    ANNOTATIONS_FILE: 'annotations',
    loadJSON(file) {
      if (file === 'comments') return comments;
      if (file === 'discussions') return { messages: {} };
      if (file === 'annotations') return {};
      return { reviews: [] }; // computed data/reviews.json path
    },
  };
  const callFeed = search => invoke({ pathname: '/api/activity-feed', search, ctx });

  it('absent limit returns the default-sized page (30)', async () => {
    const r = await callFeed('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.events.length, 30);
    assert.equal(r.payload.total, 110);
  });

  it('valid limit is honored', async () => {
    const r = await callFeed('?limit=5');
    assert.equal(r.status, 200);
    assert.equal(r.payload.events.length, 5);
  });

  it('valid limit above the cap clamps to 100', async () => {
    const r = await callFeed('?limit=200');
    assert.equal(r.status, 200);
    assert.equal(r.payload.events.length, 100);
  });

  it('non-numeric limit yields the default-bounded feed, not an empty one', async () => {
    const r = await callFeed('?limit=abc');
    assert.equal(r.status, 200);
    assert.equal(r.payload.events.length, 30, 'guarded to default, not slice(0, NaN) === []');
    assert.notEqual(r.payload.events.length, 0, 'feed is not collapsed to empty');
  });
});

describe('GET /api/content-reading-path depth guard', () => {
  // A linear wiki-link chain a -> b -> c -> d -> e -> f -> g (7 pages). With the
  // depth cutoff working, ?depth=3 stops after 4 pages (depths 0..3); without
  // the guard a non-numeric depth becomes NaN, `depth > NaN` is always false,
  // and the BFS walks the entire reachable chain (7 pages).
  let tmpRoot;
  const CHAIN = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-path-'));
    const contentDir = path.join(tmpRoot, 'content');
    fs.mkdirSync(contentDir, { recursive: true });
    CHAIN.forEach((name, i) => {
      const next = CHAIN[i + 1];
      const body = next ? `[[${next}]]\n` : 'end of chain\n';
      fs.writeFileSync(path.join(contentDir, `${name}.md`), body, 'utf-8');
    });
  });

  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const callPath = search =>
    invoke({
      pathname: '/api/content-reading-path',
      search,
      ctx: {
        fs,
        path,
        PROJECT_ROOT: tmpRoot,
        ALLOWED_EXTS: ['.md', '.mdx'],
        isValidFilePath: () => true,
        // /api/content-reading-path now wraps its walk in cached(); a pass-through
        // cached (run fn every call, never memoize) keeps this depth-guard suite
        // exercising the real BFS and leaves every assertion below unchanged.
        cached: (_k, _t, fn) => fn(),
      },
    });

  it('valid depth=3 stops the BFS at the intended depth (4 pages)', async () => {
    const r = await callPath('?start=content/a.md&depth=3');
    assert.equal(r.status, 200);
    assert.equal(r.payload.totalPages, 4);
    assert.equal(r.payload.maxDepthReached, 3);
  });

  it('a shallower valid depth narrows the path', async () => {
    const r = await callPath('?start=content/a.md&depth=1');
    assert.equal(r.status, 200);
    assert.equal(r.payload.totalPages, 2);
    assert.equal(r.payload.maxDepthReached, 1);
  });

  it('depth above the cap clamps to 5 (6 pages, not the whole chain)', async () => {
    const r = await callPath('?start=content/a.md&depth=99');
    assert.equal(r.status, 200);
    assert.equal(r.payload.totalPages, 6);
    assert.equal(r.payload.maxDepthReached, 5);
  });

  it('non-numeric depth produces the same bounded path as depth=3, not an unbounded traversal', async () => {
    const three = await callPath('?start=content/a.md&depth=3');
    const bad = await callPath('?start=content/a.md&depth=abc');
    assert.equal(bad.status, 200);
    assert.equal(bad.payload.totalPages, 4, 'bounded, not the full 7-page chain');
    assert.deepEqual(bad.payload, three.payload, 'matches the depth=3 result exactly');
  });
});
