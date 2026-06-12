import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the sibling content-similar
// suites do and reuse their ctx-mocking shape.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

// Invoke a content-analysis-b route handler with a mocked ctx and capture the
// response the handler hands to `json(res, status, payload)`.
async function invoke({ pathname, search = '', ctx = {} }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('GET /api/content-similar per-path cache', () => {
  // A flat content tree with two queryable sources and three scored candidates.
  // The source keyword set has size 5 (apples, bananas, cherry, grapes, melons),
  // so candidates that overlap 5 / 4 / 3 of those words score 1.0 / 0.8 / 0.6:
  // distinct values that pin a deterministic sort with no ties. pageD shares the
  // disjoint sourceB vocabulary, so it is the lone match for sourceB and overlaps
  // the first source by zero. Because the tree is flat, every candidate walk calls
  // readdirSync(content) exactly once, which makes a cache hit observable as a
  // readdirSync count that does not grow.
  const PROJECT_ROOT = '/proj';
  const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');
  const ALLOWED_EXTS = ['.md', '.mdx'];

  const FIXTURE = {
    'content/source.md': '---\ntitle: Source\n---\napples bananas cherry grapes melons\n',
    'content/sourceB.md': '---\ntitle: SourceB\n---\norange papaya quince raisin tomato\n',
    'content/pageA.md': '---\ntitle: Page A\n---\napples bananas cherry grapes melons\n',
    'content/pageB.md': '---\ntitle: Page B\n---\napples bananas cherry grapes walnut\n',
    'content/pageC.md': '---\ntitle: Page C\n---\napples bananas cherry walnut hazels\n',
    'content/pageD.md': '---\ntitle: Page D\n---\norange papaya quince raisin tomato\n',
  };

  // The sorted candidate list for content/source.md: pageA (5/5), pageB (4/5),
  // pageC (3/5). pageD overlaps zero source keywords and is excluded.
  const SOURCE_SIMILAR = [
    { path: 'content/pageA.md', title: 'Page A', similarity: 1 },
    { path: 'content/pageB.md', title: 'Page B', similarity: 0.8 },
    { path: 'content/pageC.md', title: 'Page C', similarity: 0.6 },
  ];

  // Build a fresh ctx per test: an fs stub that counts content/ walks plus a
  // memoizing cached(key, ttl, fn) that mirrors the real helper (first call runs
  // fn and stores it; later calls for the same key return the stored value).
  function setup() {
    let readdirCalls = 0;
    const fileContents = new Map(
      Object.entries(FIXTURE).map(([rel, content]) => [path.join(PROJECT_ROOT, rel), content]),
    );
    const dirEntries = Object.keys(FIXTURE)
      .map(rel => rel.slice('content/'.length))
      .map(name => ({ name, isDirectory: () => false }));

    const fs = {
      readFileSync(p) {
        if (fileContents.has(p)) return fileContents.get(p);
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      },
      readdirSync(dir) {
        if (dir === CONTENT_DIR) { readdirCalls++; return dirEntries; }
        return [];
      },
    };

    const store = new Map();
    const cached = (key, _ttl, fn) => {
      if (store.has(key)) return store.get(key);
      const value = fn();
      store.set(key, value);
      return value;
    };

    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };
    return { ctx, readdirCalls: () => readdirCalls, store };
  }

  const callSimilar = (ctx, rel, search = '') =>
    invoke({ pathname: '/api/content-similar', search: `?path=${rel}${search}`, ctx });

  it('returns the expected similar list and total on the first call', async () => {
    const { ctx } = setup();
    const r = await callSimilar(ctx, 'content/source.md');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.similar, SOURCE_SIMILAR);
    assert.equal(r.payload.total, 3);
  });

  it('serves a repeat request for the same path from cache (no second readdirSync)', async () => {
    const { ctx, readdirCalls, store } = setup();
    const r1 = await callSimilar(ctx, 'content/source.md');
    const afterFirst = readdirCalls();
    const r2 = await callSimilar(ctx, 'content/source.md');
    const afterSecond = readdirCalls();

    assert.equal(afterFirst, 1, 'the first call walks content/ once');
    assert.equal(afterSecond, afterFirst, 'the cached candidate list is reused; content/ is not re-walked');
    assert.deepEqual(r2.payload, r1.payload, 'the cached response is byte-identical to the first');
    assert.equal(store.size, 1, 'one cache entry for the single path');
  });

  it('treats a different path as a distinct cache entry that re-scans', async () => {
    const { ctx, readdirCalls, store } = setup();
    await callSimilar(ctx, 'content/source.md');
    const afterSource = readdirCalls();
    const rB = await callSimilar(ctx, 'content/sourceB.md');
    const afterSourceB = readdirCalls();

    assert.equal(afterSource, 1);
    assert.equal(afterSourceB, 2, 'a new path key misses the cache and walks content/ again');
    assert.equal(rB.status, 200);
    // sourceB shares its vocabulary only with pageD, so that is its sole match.
    assert.deepEqual(rB.payload.similar, [{ path: 'content/pageD.md', title: 'Page D', similarity: 1 }]);
    assert.equal(rB.payload.total, 1);
    assert.equal(store.size, 2, 'each path gets its own cache entry');
  });

  it('slices the cached candidate list per limit without re-walking', async () => {
    const { ctx, readdirCalls } = setup();
    const rFull = await callSimilar(ctx, 'content/source.md');
    const afterFull = readdirCalls();
    const rTwo = await callSimilar(ctx, 'content/source.md', '&limit=2');
    const afterTwo = readdirCalls();

    assert.equal(afterFull, 1);
    assert.equal(afterTwo, afterFull, 'a smaller limit slices the cached list rather than re-walking');
    assert.equal(rTwo.payload.similar.length, 2);
    assert.deepEqual(rTwo.payload.similar, rFull.payload.similar.slice(0, 2));
    assert.equal(rTwo.payload.total, 3, 'total still reports the full candidate count');
  });

  it('returns 404 for a missing source file and never caches it', async () => {
    // The source readFileSync lives inside the cached() closure, so a missing
    // source throws before the store is written: the 404 must never be cached.
    const { ctx, store } = setup();
    const r = await callSimilar(ctx, 'content/missing.md');
    assert.equal(r.status, 404);
    assert.deepEqual(r.payload, { error: 'File not found' });
    assert.equal(store.size, 0, 'the 404 path is never cached');
  });
});
