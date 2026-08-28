import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the sibling route tests do
// (mirrors tests/next-statsdir-cache.test.mjs).
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-c.js');

// GET /api/content-diff-summary now wraps its recursive content-tree date-range
// walk in cached('diffsummary:' + from + ':' + to, 30000, fn), keyed by both date
// params. This suite proves the wrap is behavior preserving (the payload is byte
// identical) AND that the cache short-circuits the scan per range: a repeat request
// for the same [from, to] must not re-walk the filesystem, while a different range
// is a distinct cache entry that scans on its own. It also pins the guard that
// stays OUTSIDE the cache: a request with no `from` is rejected with 400 before any
// scan runs.
//
// The handler is driven over an in-memory mock fs (so readdirSync and statSync
// calls can be counted) and a memoizing cached (so a second same-key call is served
// from the store). Every file node carries an mtime and a birthtime so the
// created vs modified bucketing is exercised end to end.

const PROJECT_ROOT = '/virtual-root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// A leaf file node: statSync returns Date objects for mtime/birthtime, matching the
// real fs.Stats fields the handler reads (stat.mtime, stat.birthtime).
function file(mtime, birthtime) {
  return { __file: true, mtime: new Date(mtime), birthtime: new Date(birthtime) };
}

// Fixture tree rooted at PROJECT_ROOT/content (the handler walks
// path.join(PROJECT_ROOT, 'content')), so reported paths are relative to the root
// and start with `content/`. The window under test is [2026-03-01, 2026-03-31]:
//   created  = mtime in window AND birthtime in window
//   modified = mtime in window but birthtime before the window
//   excluded = mtime outside the window
// blog/sub/created-nested.md exercises the recursion (a created file one level
// deeper). skip.txt (wrong extension), _draft.md (underscore prefix), and the
// .hidden directory exercise the handler's skip paths: none is counted and .hidden
// is never recursed into (its file is never stat'd, its directory never listed).
const TREE = {
  content: {
    blog: {
      'created-in-march.md': file('2026-03-15T12:00:00Z', '2026-03-10T08:00:00Z'),
      'modified-in-march.md': file('2026-03-20T09:00:00Z', '2026-01-05T00:00:00Z'),
      sub: {
        'created-nested.md': file('2026-03-25T15:30:00Z', '2026-03-22T00:00:00Z'),
      },
      'skip.txt': file('2026-03-18T00:00:00Z', '2026-03-18T00:00:00Z'),
      '_draft.md': file('2026-03-19T00:00:00Z', '2026-03-19T00:00:00Z'),
      '.hidden': {
        'secret.md': file('2026-03-17T00:00:00Z', '2026-03-17T00:00:00Z'),
      },
    },
    notes: {
      'old-file.md': file('2026-01-10T00:00:00Z', '2026-01-05T00:00:00Z'),
    },
  },
};

// Hand-computed payloads for the fixture above.
//   March window [2026-03-01, 2026-03-31]: created-in-march.md and the nested
//   created-nested.md are created (both timestamps inside); modified-in-march.md is
//   modified (mtime inside, birthtime in January, before the window);
//   old-file.md is excluded (mtime in January). Traversal is object insertion order:
//   blog before notes, and within blog the created file before the modified one,
//   then sub/.
const EXPECTED_MARCH = {
  from: '2026-03-01',
  to: '2026-03-31',
  created: 2,
  modified: 1,
  total: 3,
  createdFiles: [
    { path: 'content/blog/created-in-march.md', date: '2026-03-15' },
    { path: 'content/blog/sub/created-nested.md', date: '2026-03-25' },
  ],
  modifiedFiles: [
    { path: 'content/blog/modified-in-march.md', date: '2026-03-20' },
  ],
};

// January window [2026-01-01, 2026-01-31]: only old-file.md falls inside, and both
// its timestamps are in January, so it is created; every March file is excluded.
// A distinct bucketing outcome from the March window, proving the cache key carries
// the dates rather than serving the March result for a January request.
const EXPECTED_JANUARY = {
  from: '2026-01-01',
  to: '2026-01-31',
  created: 1,
  modified: 0,
  total: 1,
  createdFiles: [
    { path: 'content/notes/old-file.md', date: '2026-01-10' },
  ],
  modifiedFiles: [],
};

// Minimal in-memory fs exposing only what the handler uses: readdirSync (with
// withFileTypes Dirent-likes) and statSync (returning {mtime, birthtime} Dates). It
// records how many times each runs so a test can prove the cached second request
// never re-walks the tree. Directory listing order is fixed (object insertion
// order), keeping the scan deterministic without depending on a platform fs order.
function buildMockFs(rootPath, tree) {
  const dirEntries = new Map(); // fullPath -> [{ name, isDir }]
  const fileStat = new Map(); // fullPath -> { mtime, birthtime }
  (function walk(prefix, node) {
    const entries = [];
    for (const [name, value] of Object.entries(node)) {
      const full = path.join(prefix, name);
      if (value.__file) {
        fileStat.set(full, { mtime: value.mtime, birthtime: value.birthtime });
        entries.push({ name, isDir: false });
      } else {
        entries.push({ name, isDir: true });
        walk(full, value);
      }
    }
    dirEntries.set(prefix, entries);
  })(rootPath, tree);

  let readdirCalls = 0;
  let statCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    get statCalls() { return statCalls; },
    readdirSync(dir) {
      readdirCalls++;
      const entries = dirEntries.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return entries.map(({ name, isDir }) => ({ name, isDirectory: () => isDir }));
    },
    statSync(fp) {
      statCalls++;
      if (fileStat.has(fp)) return fileStat.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// A memoizing cached(key, ttl, fn): runs fn once per key, then serves the stored
// value, modelling the real server cache on a within-TTL hit. ttl is irrelevant to
// back-to-back calls, so it is intentionally ignored here.
function buildMemoizingCached() {
  const store = new Map();
  return (key, _ttl, fn) => {
    if (store.has(key)) return store.get(key);
    const value = fn();
    store.set(key, value);
    return value;
  };
}

// Drive the real GET /api/content-diff-summary handler once for a given date range
// and return the captured json() response. fs/cached are supplied by the caller so a
// sequence of calls can share one mock fs and one cache. `from`/`to` are omitted
// from the query string when undefined, so a request with no `from` is expressible.
async function runDiffSummary({ from, to }, { fs, cached }) {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const qs = new URLSearchParams();
  if (from !== undefined) qs.set('from', from);
  if (to !== undefined) qs.set('to', to);
  const url = new URL(`http://localhost/api/content-diff-summary?${qs.toString()}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, '/api/content-diff-summary', ctx);
  return captured;
}

describe('GET /api/content-diff-summary (cached per-range scan)', () => {
  it('returns the byte-identical payload on the first call for a range', async () => {
    const fs = buildMockFs(PROJECT_ROOT, TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runDiffSummary({ from: '2026-03-01', to: '2026-03-31' }, { fs, cached });

    assert.equal(status, 200);
    assert.deepEqual(payload, EXPECTED_MARCH);
  });

  it('serves a deeply equal payload from cache on a second back-to-back call for the same range', async () => {
    const fs = buildMockFs(PROJECT_ROOT, TREE);
    const cached = buildMemoizingCached();

    const first = await runDiffSummary({ from: '2026-03-01', to: '2026-03-31' }, { fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, EXPECTED_MARCH);
    const readdirAfterFirst = fs.readdirCalls;
    const statAfterFirst = fs.statCalls;
    assert.ok(readdirAfterFirst > 0, 'the first request walks the content tree');
    assert.ok(statAfterFirst > 0, 'the first request stats the matched files');

    const second = await runDiffSummary({ from: '2026-03-01', to: '2026-03-31' }, { fs, cached });
    assert.equal(second.status, 200);
    // (1) The back-to-back call returns a deeply equal payload.
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(second.payload, EXPECTED_MARCH);
    // (2) The cache short-circuits the scan: no further fs access on the 2nd call.
    assert.equal(fs.readdirCalls, readdirAfterFirst, 'second request is served from cache (no repeat readdirSync)');
    assert.equal(fs.statCalls, statAfterFirst, 'second request stats no files (served from cache)');
  });

  it('treats a different range as a distinct cache entry that scans again', async () => {
    const fs = buildMockFs(PROJECT_ROOT, TREE);
    const cached = buildMemoizingCached();

    // Warm the cache for the March range, then confirm a repeat March is a cache hit.
    await runDiffSummary({ from: '2026-03-01', to: '2026-03-31' }, { fs, cached });
    const readdirAfterMarch = fs.readdirCalls;
    const statAfterMarch = fs.statCalls;
    await runDiffSummary({ from: '2026-03-01', to: '2026-03-31' }, { fs, cached });
    assert.equal(fs.readdirCalls, readdirAfterMarch, 'a repeat March request is a cache hit');
    assert.equal(fs.statCalls, statAfterMarch, 'a repeat March request stats nothing');

    // A different range misses the cache and runs its own scan, with its own buckets.
    const january = await runDiffSummary({ from: '2026-01-01', to: '2026-01-31' }, { fs, cached });
    assert.equal(january.status, 200);
    assert.deepEqual(january.payload, EXPECTED_JANUARY);
    assert.ok(fs.readdirCalls > readdirAfterMarch, 'a different range is a distinct entry that scans again');
    assert.ok(fs.statCalls > statAfterMarch, 'a different range stats files on its own');

    // And that fresh entry is itself cached on a repeat.
    const readdirAfterJanuary = fs.readdirCalls;
    const januaryAgain = await runDiffSummary({ from: '2026-01-01', to: '2026-01-31' }, { fs, cached });
    assert.deepEqual(januaryAgain.payload, EXPECTED_JANUARY);
    assert.equal(fs.readdirCalls, readdirAfterJanuary, 'a repeat January request is a cache hit');
  });

  it('rejects a request with no from date with 400 without scanning', async () => {
    const fs = buildMockFs(PROJECT_ROOT, TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runDiffSummary({ to: '2026-03-31' }, { fs, cached });

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'Missing from date (YYYY-MM-DD)' });
    assert.equal(fs.readdirCalls, 0, 'a missing from date is rejected before any readdirSync');
    assert.equal(fs.statCalls, 0, 'a missing from date stats no files');
  });
});
