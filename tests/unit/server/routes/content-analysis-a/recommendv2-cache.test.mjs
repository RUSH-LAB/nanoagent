import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the sibling per-key cache
// suites do (next-trajectory-cache, next-wordfreq-cache) and reuse their
// ctx-mocking shape. GET /api/content-recommend-v2 now wraps its per-path scan in
// cached('recommendv2:' + sourcePath, 60000, fn); these tests drive that wrap
// directly with a counting fs and a memoizing cached, no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`, counting how
// often the recursive scan touches disk. The handler reads the source file and
// every candidate with readFileSync and walks directories with
// readdirSync({withFileTypes}); the counters let a test prove a cache hit performs
// no fresh reads while a distinct path re-walks. A nested file (content/sub) forces
// the recursion so the cached scan provably covers the whole tree.
function makeCountingFs(fileMap) {
  const dirs = new Map(); // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
  const ensureDir = absDir => { if (!dirs.has(absDir)) dirs.set(absDir, new Map()); };

  for (const [rel, content] of Object.entries(fileMap)) {
    const segs = rel.split('/');
    let cur = PROJECT_ROOT;
    for (let i = 0; i < segs.length; i++) {
      const isDir = i < segs.length - 1;
      ensureDir(cur);
      if (!dirs.get(cur).has(segs[i])) dirs.get(cur).set(segs[i], isDir);
      cur = path.join(cur, segs[i]);
    }
    fileContents.set(cur, content);
  }

  const counts = { readdirSync: 0, readFileSync: 0 };
  const fs = {
    readdirSync(dir) {
      counts.readdirSync++;
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      counts.readFileSync++;
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
  return { fs, counts };
}

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server/index.js
// helper: run fn and store on a miss, return the stored value untouched on a hit;
// fn() throwing stores nothing, so an error response stays uncached. Every call is
// recorded in `calls` so a test can pin the exact key and TTL the handler passes.
function makeCached() {
  const store = new Map();
  const calls = [];
  const cached = (key, ttl, fn) => {
    calls.push({ key, ttl });
    if (store.has(key)) return store.get(key);
    const val = fn();
    store.set(key, val);
    return val;
  };
  return { cached, store, calls };
}

// Invoke the content-recommend-v2 handler with a mocked ctx and capture the
// response handed to `json(res, status, payload)`.
async function invoke({ search = '', ctx = {} }) {
  const pathname = '/api/content-recommend-v2';
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

// Source bodies keep every prose word to 4 characters or fewer, so the length>4
// keyword rule drops them all and keyword overlap contributes 0 for every
// candidate. Citations are then the only positive signal, keeping scores clean
// integers independent of readdir order. cand-c lives under content/sub so the
// scan must recurse to read it; it cites only xx9999 (no overlap), so it never
// ranks but still proves the recursive walk is inside the cached closure.
const FIXTURE = {
  'content/source.md': '---\ntitle: Source\n---\nsee [@li2020] and [@wu2019] now\n',
  'content/source2.md': '---\ntitle: Source2\n---\njust [@zz2021] here only\n',
  'content/cand-a.md': '---\ntitle: Cand A\n---\nref [@li2020] here\n',
  'content/cand-b.md': '---\ntitle: Cand B\n---\nsee [@li2020] plus [@wu2019] too\n',
  'content/sub/cand-c.md': '---\ntitle: Cand C\n---\nhere [@xx9999] only\n',
};

// The proven pre-cache output for path=content/source.md. This is byte-identical
// to what next-recommendv2-hoist-citere.test.mjs asserts the handler returns for
// the same source/cand-a/cand-b fixture, so it pins byte-identity against the
// pre-cache computation. Field order matches the handler's returned literal
// ({recommendations, sourcePath, basedOn}) and each candidate
// ({path, title, score, sharedTags, sharedCitations}), so a JSON.stringify
// comparison pins serialization, not just structural equality. cand-b cites both
// keys (score 6), cand-a cites one (score 3), so the sort is unambiguous.
const EXPECTED_SOURCE = {
  recommendations: [
    { path: 'content/cand-b.md', title: 'Cand B', score: 6, sharedTags: [], sharedCitations: 2 },
    { path: 'content/cand-a.md', title: 'Cand A', score: 3, sharedTags: [], sharedCitations: 1 },
  ],
  sourcePath: 'content/source.md',
  basedOn: { tags: 0, keywords: 0, citations: 2 },
};

// path=content/source2.md cites only zz2021, which no other page shares, so the
// recommendation list is empty and basedOn.citations is 1. A distinct payload from
// EXPECTED_SOURCE proves the second path is keyed and computed independently.
const EXPECTED_SOURCE2 = {
  recommendations: [],
  sourcePath: 'content/source2.md',
  basedOn: { tags: 0, keywords: 0, citations: 1 },
};

describe('GET /api/content-recommend-v2 (scan cached via cached("recommendv2:" + sourcePath))', () => {
  it('returns the expected payload, byte-identical, on the first call and walks the fs', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };

    const res = await invoke({ search: '?path=content/source.md', ctx });
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_SOURCE);
    // Byte-identity: same fields, same order, same serialization as before caching.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_SOURCE));
    assert.ok(counts.readdirSync > 0, 'the first call walks content/');
    assert.ok(counts.readFileSync > 0, 'the first call reads files');
  });

  it('serves a repeat request for the same path from cache with no repeat content walk', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };

    const first = await invoke({ search: '?path=content/source.md', ctx });
    const dirAfterFirst = counts.readdirSync;
    const fileAfterFirst = counts.readFileSync;
    assert.equal(first.status, 200);
    assert.ok(dirAfterFirst > 0 && fileAfterFirst > 0, 'the first call hits the filesystem');

    const second = await invoke({ search: '?path=content/source.md', ctx });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readdirSync, dirAfterFirst, 'cached repeat must not readdirSync again');
    assert.equal(counts.readFileSync, fileAfterFirst, 'cached repeat must not readFileSync again');
    assert.equal(store.size, 1, 'one cache entry for the single path');
    assert.ok(store.has('recommendv2:content/source.md'), 'cache key is "recommendv2:" + sourcePath');
  });

  it('keys each distinct source path separately and re-walks for a new path', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };

    const source = await invoke({ search: '?path=content/source.md', ctx });
    assert.equal(source.status, 200);
    const dirAfterFirst = counts.readdirSync;

    const source2 = await invoke({ search: '?path=content/source2.md', ctx });
    assert.equal(source2.status, 200);
    assert.deepEqual(source2.payload, EXPECTED_SOURCE2);
    assert.notDeepEqual(source2.payload, source.payload);
    assert.ok(counts.readdirSync > dirAfterFirst, 'a new path misses the cache and re-walks content/');
    assert.equal(store.size, 2, 'each path gets its own cache entry');
    assert.ok(store.has('recommendv2:content/source.md') && store.has('recommendv2:content/source2.md'));
  });

  it('pins the cache key prefix and the 60000 ms TTL the handler passes', async () => {
    const { fs } = makeCountingFs(FIXTURE);
    const { cached, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };

    await invoke({ search: '?path=content/source.md', ctx });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'recommendv2:content/source.md');
    assert.equal(calls[0].ttl, 60000);
  });

  it('returns 400 for an invalid path before the cache and never scans', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => false, cached };

    const res = await invoke({ search: '?path=../secret', ctx });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Invalid path' });
    assert.equal(calls.length, 0, 'the invalid-path guard returns before cached() is reached');
    assert.equal(store.size, 0, 'the 400 path is never cached');
    assert.equal(counts.readdirSync, 0, 'no scan on an invalid path');
    assert.equal(counts.readFileSync, 0, 'no reads on an invalid path');
  });

  it('does not cache a 404 for a missing source file (the error path stays outside the cache)', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };

    const res = await invoke({ search: '?path=content/missing.md', ctx });
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'File not found' });
    // The try/catch sits OUTSIDE the cached closure, and fs.readFileSync on the absent
    // source throws inside fn(); the real server/index.js cached() runs fn() before it stores,
    // so the throw leaves nothing cached. This pins the error-stays-uncached invariant.
    assert.ok(calls.length >= 1, 'the handler reaches cached() since the path passed isValidFilePath');
    assert.equal(store.size, 0, 'the 404 is never cached');
    assert.equal(counts.readdirSync, 0, 'the content walk never starts when the source read fails');
  });
});
