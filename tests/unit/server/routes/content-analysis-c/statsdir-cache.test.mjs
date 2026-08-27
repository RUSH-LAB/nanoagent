import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the sibling route tests do
// (mirrors tests/next-healthsummary-cache.test.mjs).
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

// GET /api/stats/directory now wraps its recursive directory walk in
// cached('statsdir:' + dir, 30000, fn), keyed by the requested dir. This suite
// proves the wrap is behavior preserving (the payload is unchanged) AND that the
// cache short-circuits the scan per dir: a repeat request for the same dir must
// not re-walk the filesystem, while a different dir is a distinct cache entry that
// scans on its own. It also pins the guards that stay OUTSIDE the cache: an
// invalid dir is rejected with 400 before any scan runs.
//
// The handler is driven over an in-memory mock fs (so readdirSync calls can be
// counted), an isValidDir injected per call, and a memoizing cached (so a second
// same-key call is served from the store).

const PROJECT_ROOT = '/virtual-root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Fixture tree rooted at PROJECT_ROOT. `dir` is resolved relative to PROJECT_ROOT
// (fullDir = path.join(PROJECT_ROOT, dir)), so the walked directories live directly
// under the root, not under content/. The nested blog/sub directory exercises the
// recursive count() (a full blog scan makes more than one readdirSync call). The
// skip.txt (disallowed extension) and the .hidden directory exercise the handler's
// skip paths: neither contributes to the totals, and .hidden is never recursed
// into (so its file is never read and its directory never listed).
const TREE = {
  blog: {
    'a.md': '# Title A\n\nalpha beta gamma',
    'b.md': '---\ndraft: true\n---\none two',
    sub: {
      'c.md': 'hello there big world',
    },
    'skip.txt': 'this wrong-extension file must not be counted',
    '.hidden': {
      'secret.md': 'hidden words that must never be counted at all',
    },
  },
  notes: {
    'x.md': 'solo content here now',
    'y.md': 'extra notes here',
  },
};

// Hand-computed expected payloads for the fixture above. Both averages are
// intentionally non-integer before rounding, so the Math.round in avgWordsPerFile
// is genuinely exercised: a "no rounding" or a floor/ceil regression would change
// the value and fail deepEqual, pinning the GOAL's byte-identical rounding.
//   blog: 3 counted files (a.md, b.md, sub/c.md; skip.txt and .hidden are skipped).
//     words = 6 (a.md) + 6 (b.md) + 4 (c.md) = 16; b.md's `draft: true` frontmatter
//     makes drafts = 1; avgWordsPerFile = round(16 / 3) = round(5.33) = 5 (rounds down).
//   notes: 2 files, words = 4 (x.md) + 3 (y.md) = 7, no drafts;
//     avgWordsPerFile = round(7 / 2) = round(3.5) = 4 (rounds up).
const EXPECTED_BLOG = { directory: 'blog', files: 3, words: 16, drafts: 1, avgWordsPerFile: 5 };
const EXPECTED_NOTES = { directory: 'notes', files: 2, words: 7, drafts: 0, avgWordsPerFile: 4 };

// Minimal in-memory fs exposing only what the handler uses: readdirSync (with
// withFileTypes Dirent-likes) and readFileSync. It records how many times each
// runs so a test can prove the cached second request never re-walks the tree.
// Directory listing order is fixed (object insertion order), keeping the scan
// deterministic without depending on a platform-defined fs ordering.
function buildMockFs(rootPath, tree) {
  const dirEntries = new Map(); // fullPath -> [{ name, isDir }]
  const fileContent = new Map(); // fullPath -> string
  (function walk(prefix, node) {
    const entries = [];
    for (const [name, value] of Object.entries(node)) {
      const full = path.join(prefix, name);
      if (typeof value === 'string') {
        fileContent.set(full, value);
        entries.push({ name, isDir: false });
      } else {
        entries.push({ name, isDir: true });
        walk(full, value);
      }
    }
    dirEntries.set(prefix, entries);
  })(rootPath, tree);

  let readdirCalls = 0;
  let readCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    get readCalls() { return readCalls; },
    readdirSync(dir) {
      readdirCalls++;
      const entries = dirEntries.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return entries.map(({ name, isDir }) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      readCalls++;
      if (fileContent.has(fp)) return fileContent.get(fp);
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

// Drive the real GET /api/stats/directory handler once for a given dir and return
// the captured json() response. fs/cached/isValidDir are supplied by the caller so
// a sequence of calls can share one mock fs and one cache.
async function runStatsDir(dir, { fs, cached, isValidDir }) {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    cached,
    isValidDir,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL(`http://localhost/api/stats/directory?dir=${encodeURIComponent(dir)}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, '/api/stats/directory', ctx);
  return captured;
}

const acceptAll = () => true;

describe('GET /api/stats/directory (cached per-dir scan)', () => {
  it('returns the expected aggregate counts on the first call for a dir', async () => {
    const fs = buildMockFs(PROJECT_ROOT, TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runStatsDir('blog', { fs, cached, isValidDir: acceptAll });

    assert.equal(status, 200);
    assert.deepEqual(payload, EXPECTED_BLOG);
  });

  it('serves a deeply equal payload from cache on a second back-to-back call for the same dir', async () => {
    const fs = buildMockFs(PROJECT_ROOT, TREE);
    const cached = buildMemoizingCached();

    const first = await runStatsDir('blog', { fs, cached, isValidDir: acceptAll });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, EXPECTED_BLOG);
    const readdirAfterFirst = fs.readdirCalls;
    const readAfterFirst = fs.readCalls;
    assert.ok(readdirAfterFirst > 0, 'the first request walks the directory tree');

    const second = await runStatsDir('blog', { fs, cached, isValidDir: acceptAll });
    assert.equal(second.status, 200);
    // (1) The back-to-back call returns a deeply equal payload.
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(second.payload, EXPECTED_BLOG);
    // (2) The cache short-circuits the scan: no further fs access on the 2nd call.
    assert.equal(fs.readdirCalls, readdirAfterFirst, 'second request is served from cache (no repeat readdirSync)');
    assert.equal(fs.readCalls, readAfterFirst, 'second request reads no files (served from cache)');
  });

  it('treats a different dir as a distinct cache entry that scans again', async () => {
    const fs = buildMockFs(PROJECT_ROOT, TREE);
    const cached = buildMemoizingCached();

    // Warm the cache for 'blog', then confirm a repeat 'blog' is a cache hit.
    await runStatsDir('blog', { fs, cached, isValidDir: acceptAll });
    const readdirAfterBlog = fs.readdirCalls;
    await runStatsDir('blog', { fs, cached, isValidDir: acceptAll });
    assert.equal(fs.readdirCalls, readdirAfterBlog, 'a repeat blog request is a cache hit');

    // A different dir misses the cache and runs its own scan.
    const notes = await runStatsDir('notes', { fs, cached, isValidDir: acceptAll });
    assert.equal(notes.status, 200);
    assert.deepEqual(notes.payload, EXPECTED_NOTES);
    assert.ok(fs.readdirCalls > readdirAfterBlog, 'a different dir is a distinct entry that scans again');

    // And that fresh entry is itself cached on a repeat.
    const readdirAfterNotes = fs.readdirCalls;
    const notesAgain = await runStatsDir('notes', { fs, cached, isValidDir: acceptAll });
    assert.deepEqual(notesAgain.payload, EXPECTED_NOTES);
    assert.equal(fs.readdirCalls, readdirAfterNotes, 'a repeat notes request is a cache hit');
  });

  it('rejects an invalid dir with 400 without scanning', async () => {
    const fs = buildMockFs(PROJECT_ROOT, TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runStatsDir('../outside', { fs, cached, isValidDir: () => false });

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'Invalid directory' });
    assert.equal(fs.readdirCalls, 0, 'an invalid dir is rejected before any readdirSync');
    assert.equal(fs.readCalls, 0, 'an invalid dir reads no files');
  });
});
