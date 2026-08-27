import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the sibling per-key cache
// suites do (next-recommendv2-cache, next-wordfreq-cache) and reuse their
// ctx-mocking shape. GET /api/content-reading-path now wraps its full content/
// walk and depth-bounded BFS in cached('readingpath:' + startPath + ':' + maxDepth,
// 60000, fn); these tests drive that wrap directly with a counting fs and a
// memoizing cached, no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`, counting how
// often the recursive scan touches disk. The handler walks directories with
// readdirSync({withFileTypes}) and reads each candidate with readFileSync; the
// counters let a test prove a cache hit performs no fresh reads while a distinct
// start or depth re-walks. A nested file (content/sub/end.md) forces the recursion
// so the cached scan provably covers the whole tree.
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

// Invoke the content-reading-path handler with a mocked ctx and capture the
// response handed to `json(res, status, payload)`. Fully in-process: no network,
// no server is started.
async function invoke({ search = '', ctx = {} }) {
  const pathname = '/api/content-reading-path';
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

// An unambiguous wiki-link chain start -> middle -> end. Each link target is the
// suffix of exactly one file path, so resolution never depends on readdirSync order
// and the reading path is fully deterministic. end.md lives under content/sub so the
// scan must recurse to read it, proving the recursive walk is inside the cached
// closure. middle uses the [[end|alias]] form so the alias branch is exercised too.
const FIXTURE = {
  'content/start.md': '---\ntitle: Start\n---\nbegin, then read [[middle]] next\n',
  'content/middle.md': '---\ntitle: Middle\n---\ncontinue to [[end|the end]] now\n',
  'content/sub/end.md': '---\ntitle: End\n---\nyou have arrived, no links here\n',
};

// The proven pre-cache output for start=content/start.md at the default depth (3).
// Field order matches the handler's returned literal
// ({startPath, readingPath, totalPages, maxDepthReached}) and each step
// ({path, title, depth}), so the JSON.stringify comparison pins serialization, not
// just structural equality. start -> middle -> end gives depths 0,1,2.
const EXPECTED_START_D3 = {
  startPath: 'content/start.md',
  readingPath: [
    { path: 'content/start.md', title: 'Start', depth: 0 },
    { path: 'content/middle.md', title: 'Middle', depth: 1 },
    { path: 'content/sub/end.md', title: 'End', depth: 2 },
  ],
  totalPages: 3,
  maxDepthReached: 2,
};

// Same start, depth=1: the BFS stops before end.md (depth 2 > 1), so a shorter path.
// A distinct payload from EXPECTED_START_D3 proves the depth is part of the key.
const EXPECTED_START_D1 = {
  startPath: 'content/start.md',
  readingPath: [
    { path: 'content/start.md', title: 'Start', depth: 0 },
    { path: 'content/middle.md', title: 'Middle', depth: 1 },
  ],
  totalPages: 2,
  maxDepthReached: 1,
};

// A distinct start (content/middle.md, default depth) reaches only middle -> end, so
// the payload differs from both start-keyed results and proves the start is keyed.
const EXPECTED_MIDDLE_D3 = {
  startPath: 'content/middle.md',
  readingPath: [
    { path: 'content/middle.md', title: 'Middle', depth: 0 },
    { path: 'content/sub/end.md', title: 'End', depth: 1 },
  ],
  totalPages: 2,
  maxDepthReached: 1,
};

describe('GET /api/content-reading-path (walk + BFS cached via cached("readingpath:" + start + ":" + depth))', () => {
  it('returns the expected payload, byte-identical, on the first call and walks the fs', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };

    const res = await invoke({ search: '?start=content/start.md', ctx });
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_START_D3);
    // Byte-identity: same fields, same order, same serialization as before caching.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_START_D3));
    assert.ok(counts.readdirSync > 0, 'the first call walks content/');
    assert.ok(counts.readFileSync > 0, 'the first call reads files');
  });

  it('serves a repeat request for the same start and depth from cache with no repeat content walk', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };

    const first = await invoke({ search: '?start=content/start.md', ctx });
    const dirAfterFirst = counts.readdirSync;
    const fileAfterFirst = counts.readFileSync;
    assert.equal(first.status, 200);
    assert.ok(dirAfterFirst > 0 && fileAfterFirst > 0, 'the first call hits the filesystem');

    const second = await invoke({ search: '?start=content/start.md', ctx });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readdirSync, dirAfterFirst, 'cached repeat must not readdirSync again');
    assert.equal(counts.readFileSync, fileAfterFirst, 'cached repeat must not readFileSync again');
    assert.equal(store.size, 1, 'one cache entry for the single start/depth pair');
    assert.ok(store.has('readingpath:content/start.md:3'), 'cache key is "readingpath:" + start + ":" + depth');
  });

  it('keys each distinct start path separately and re-walks for a new start', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };

    const start = await invoke({ search: '?start=content/start.md', ctx });
    assert.equal(start.status, 200);
    const dirAfterFirst = counts.readdirSync;

    const middle = await invoke({ search: '?start=content/middle.md', ctx });
    assert.equal(middle.status, 200);
    assert.deepEqual(middle.payload, EXPECTED_MIDDLE_D3);
    assert.notDeepEqual(middle.payload, start.payload);
    assert.ok(counts.readdirSync > dirAfterFirst, 'a new start misses the cache and re-walks content/');
    assert.equal(store.size, 2, 'each start gets its own cache entry');
    assert.ok(store.has('readingpath:content/start.md:3') && store.has('readingpath:content/middle.md:3'));
  });

  it('keys each distinct depth separately for the same start and re-walks for a new depth', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };

    const deep = await invoke({ search: '?start=content/start.md', ctx }); // default depth 3
    assert.equal(deep.status, 200);
    assert.deepEqual(deep.payload, EXPECTED_START_D3);
    const dirAfterFirst = counts.readdirSync;

    const shallow = await invoke({ search: '?start=content/start.md&depth=1', ctx });
    assert.equal(shallow.status, 200);
    assert.deepEqual(shallow.payload, EXPECTED_START_D1);
    assert.notDeepEqual(shallow.payload, deep.payload);
    assert.ok(counts.readdirSync > dirAfterFirst, 'a new depth misses the cache and re-walks content/');
    assert.equal(store.size, 2, 'each depth gets its own cache entry for the same start');
    assert.ok(store.has('readingpath:content/start.md:3') && store.has('readingpath:content/start.md:1'));
  });

  it('pins the cache key (start and depth) and the 60000 ms TTL the handler passes', async () => {
    const { fs } = makeCountingFs(FIXTURE);
    const { cached, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };

    await invoke({ search: '?start=content/start.md&depth=2', ctx });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'readingpath:content/start.md:2');
    assert.equal(calls[0].ttl, 60000);
  });

  it('returns 400 for an invalid start before the cache and never scans', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => false, cached };

    const res = await invoke({ search: '?start=../secret', ctx });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Invalid start path' });
    assert.equal(calls.length, 0, 'the invalid-start guard returns before cached() is reached');
    assert.equal(store.size, 0, 'the 400 path is never cached');
    assert.equal(counts.readdirSync, 0, 'no scan on an invalid start');
    assert.equal(counts.readFileSync, 0, 'no reads on an invalid start');
  });

  it('does not cache a 404 when the content walk fails (the error path stays outside the cache)', async () => {
    // No content/ dir in this fixture, so scan()'s first readdirSync throws ENOENT
    // inside fn(). The try/catch sits OUTSIDE the cached closure, and the real
    // server/index.js cached() runs fn() before it stores, so the throw leaves nothing
    // cached. This pins the error-stays-uncached invariant.
    const { fs, counts } = makeCountingFs({ 'other/x.md': '---\ntitle: X\n---\nno content dir\n' });
    const { cached, store, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidFilePath: () => true, cached };

    const res = await invoke({ search: '?start=content/start.md', ctx });
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'Start path not found' });
    assert.ok(calls.length >= 1, 'the handler reaches cached() since the start passed isValidFilePath');
    assert.equal(store.size, 0, 'the 404 is never cached');
    assert.equal(counts.readFileSync, 0, 'no file is read once the content readdir throws');
  });
});
