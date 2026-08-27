import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it via createRequire the way the sibling
// per-file cache suite does (next-content-c-filemicro-cache.test.mjs) and reuse its
// ctx-mocking shape. GET /api/file/diff now wraps its two reads plus the line-by-line
// diff build in cached('filediff:' + path1 + ':' + path2, 30000, fn); these tests
// drive that wrap directly with a counting fs and a memoizing cached, no network and
// no server.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

const PROJECT_ROOT = '/proj';

// In-memory fs stub that returns each file's content keyed by absolute path and
// counts how often the handler touches disk. The diff handler reads exactly two
// files per fresh computation and never stats, so the stub only answers
// readFileSync, keyed off the map so a missing path throws ENOENT. The counter lets
// a test prove a cache hit performs no fresh read while the first call provably
// reads both files.
function makeCountingFs(absFileMap) {
  const counts = { readFileSync: 0 };
  const fs = {
    readFileSync(fp) {
      counts.readFileSync++;
      if (absFileMap.has(fp)) return absFileMap.get(fp);
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

// A non-memoizing pass-through cached: it always runs fn(), reproducing the exact
// pre-cache code path. The byte-identity test compares the memoized output against a
// pass-through run to prove the cache wrapper alters nothing.
function passThroughCached() {
  const calls = [];
  const cached = (key, ttl, fn) => { calls.push({ key, ttl }); return fn(); };
  return { cached, calls };
}

// Invoke the GET /api/file/diff handler with a mocked ctx and capture the response
// handed to json(res, status, payload). isValidFilePath defaults to accepting both
// paths so the happy path reaches the file reads; pass a rejecting validator to
// exercise the 400 guard.
async function invoke(path1, path2, { fs, cached, isValidFilePath = () => true }) {
  const qs = `path1=${encodeURIComponent(path1)}&path2=${encodeURIComponent(path2)}`;
  const url = new URL(`http://localhost/api/file/diff?${qs}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    isValidFilePath,
    cached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/file/diff', ctx);
  return captured;
}

// ── diff fixtures ──

// path1 vs path2: line 1 identical, line 2 changed (beta to BETA), line 3 identical,
// and path2 carries an extra line 4 (added). No trailing newline, so split('\n')
// yields exactly the lines listed and the index-based diff is fully predictable.
const REL_1 = 'content/diff-a.md';
const ABS_1 = path.join(PROJECT_ROOT, REL_1);
const CONTENT_1 = 'alpha\nbeta\ngamma';

const REL_2 = 'content/diff-b.md';
const ABS_2 = path.join(PROJECT_ROOT, REL_2);
const CONTENT_2 = 'alpha\nBETA\ngamma\ndelta';

// The full payload the pre-cache handler returns for (REL_1, REL_2): one changed
// line and one added line, anchoring the byte-identity comparison.
const EXPECTED_1_2 = {
  path1: REL_1,
  path2: REL_2,
  lines1: 3,
  lines2: 4,
  changes: 2,
  diff: [
    { line: 2, type: 'changed', old: 'beta', new: 'BETA' },
    { line: 4, type: 'added', text: 'delta' },
  ],
};

// A third file shorter than path1, so the tail lines of path1 register as 'removed',
// the diff type the (REL_1, REL_2) pair does not exercise. Pairing it with REL_1 as
// path2 also shares path1 with the first pair, proving the cache key carries BOTH
// paths rather than only one.
const REL_3 = 'content/diff-c.md';
const ABS_3 = path.join(PROJECT_ROOT, REL_3);
const CONTENT_3 = 'alpha';

describe('GET /api/file/diff (cached("filediff:" + path1 + ":" + path2, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    // The memoizing run (first call computes via fn) and the pass-through run (fn
    // inline, the exact pre-cache path) must serialize identically.
    const viaCache = await invoke(REL_1, REL_2, { ...makeCountingFs(new Map([[ABS_1, CONTENT_1], [ABS_2, CONTENT_2]])), ...makeCached() });
    const viaPre = await invoke(REL_1, REL_2, { ...makeCountingFs(new Map([[ABS_1, CONTENT_1], [ABS_2, CONTENT_2]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.deepEqual(viaCache.payload, EXPECTED_1_2);
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second pair of reads', async () => {
    const { fs, counts } = makeCountingFs(new Map([[ABS_1, CONTENT_1], [ABS_2, CONTENT_2]]));
    const { cached, store } = makeCached();

    const first = await invoke(REL_1, REL_2, { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 2, 'the first call reads both files once');

    const second = await invoke(REL_1, REL_2, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 2, 'cached repeat must not read either file again');
    assert.equal(store.size, 1, 'one cache entry for the per-pair key');
    assert.ok(store.has('filediff:' + REL_1 + ':' + REL_2), 'cache key is filediff:<path1>:<path2>');
  });

  it('keys the cache per pair so a distinct pair gets a distinct entry', async () => {
    const { fs, counts } = makeCountingFs(new Map([[ABS_1, CONTENT_1], [ABS_2, CONTENT_2], [ABS_3, CONTENT_3]]));
    const { cached, store } = makeCached();

    const ab = await invoke(REL_1, REL_2, { fs, cached });
    const ac = await invoke(REL_1, REL_3, { fs, cached });
    assert.equal(ab.status, 200);
    assert.equal(ac.status, 200);
    assert.equal(store.size, 2, 'two pairs produce two cache entries');
    assert.ok(store.has('filediff:' + REL_1 + ':' + REL_2));
    assert.ok(store.has('filediff:' + REL_1 + ':' + REL_3), 'sharing path1 still keys distinctly on path2');
    // Distinct second file, so the entries are not cross-contaminated: the (REL_1,
    // REL_3) pair exercises the 'removed' type the first pair never produced.
    assert.deepEqual(ac.payload.diff, [
      { line: 2, type: 'removed', text: 'beta' },
      { line: 3, type: 'removed', text: 'gamma' },
    ]);
    assert.equal(ac.payload.changes, 2);
    assert.equal(counts.readFileSync, 4, 'each distinct pair reads its two files once');
  });

  it('pins the filediff: composite key and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[ABS_1, CONTENT_1], [ABS_2, CONTENT_2]]));
    const { cached, calls } = makeCached();
    await invoke(REL_1, REL_2, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'filediff:' + REL_1 + ':' + REL_2);
    assert.equal(calls[0].ttl, 30000);
  });

  it('caps the diff array at 200 entries while reporting the full change count', async () => {
    // Two 250-line files that differ on every line: changes counts all 250, but the
    // returned diff array is sliced to 200, so the cap is preserved through the cache.
    const big1 = Array.from({ length: 250 }, (_, i) => `x${i}`).join('\n');
    const big2 = Array.from({ length: 250 }, (_, i) => `y${i}`).join('\n');
    const REL_B1 = 'content/diff-cap-1.md';
    const REL_B2 = 'content/diff-cap-2.md';
    const ABS_B1 = path.join(PROJECT_ROOT, REL_B1);
    const ABS_B2 = path.join(PROJECT_ROOT, REL_B2);
    const { fs } = makeCountingFs(new Map([[ABS_B1, big1], [ABS_B2, big2]]));
    const { cached, store } = makeCached();

    const r = await invoke(REL_B1, REL_B2, { fs, cached });
    assert.equal(r.status, 200);
    assert.equal(r.payload.changes, 250, 'changes reports the full count');
    assert.equal(r.payload.diff.length, 200, 'diff is capped at 200 entries');
    assert.equal(r.payload.diff[0].type, 'changed');
    assert.ok(store.has('filediff:' + REL_B1 + ':' + REL_B2));
  });

  it('rejects invalid paths with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('../etc/passwd', REL_2, { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid paths' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected paths');
    assert.equal(store.size, 0, 'nothing is cached for invalid paths');
  });

  it('does not cache a 404 when a file cannot be read (reads stay inside the closure)', async () => {
    // Empty fs: the first readFileSync inside fn() throws ENOENT; the real server/index.js
    // cached() runs fn() before it stores, so the throw leaves nothing cached and the
    // outer catch returns the 404 envelope.
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke(REL_1, REL_2, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});
