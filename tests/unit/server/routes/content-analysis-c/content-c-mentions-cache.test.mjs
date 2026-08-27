import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the sibling route suites do
// (next-related-cache, next-filedeps-cache) and reuse their ctx-mocking shape.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`, the same shape
// the sibling per-file cache suites use, but it counts BOTH readdirSync and
// readFileSync. The counts let a test prove a cached repeat skips the whole
// recursive scan: neither the directory reads nor the file reads run a second time.
function makeFs(fileMap) {
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
  return {
    counts,
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

// Drive GET /api/file/mentions once. fs and cached are passed in so a single pair
// can be shared across calls within a test, letting the cache persist.
async function getMentions(fs, cached, filePath, isValidFilePath = () => true) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    isValidFilePath,
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL(`http://localhost/api/file/mentions?path=${encodeURIComponent(filePath)}`);
  await routes({ method: 'GET' }, { writableEnded: false }, url, '/api/file/mentions', ctx);
  return captured;
}

// Source page: its frontmatter title and its basename give the two search terms,
// "graph-theory" (basename) and "graph theory" (title), both length > 3.
const SOURCE = `---
title: Graph Theory
---

An overview page.
`;

// Mentions the basename token (hyphenated), so its matchedTerm is "graph-theory"
// (the first search term, which wins and breaks the loop).
const BY_BASENAME = `---
title: By Basename
---

Discussion of graph-theory fundamentals.
`;

// Mentions the title token (spaced) but not the hyphenated basename, so the first
// search term misses and matchedTerm is "graph theory".
const BY_TITLE = `---
title: By Title
---

An essay on graph theory and its uses.
`;

// Mentions neither term, so it never appears in the result.
const NO_MENTION = `---
title: No Mention
---

Topics in number systems and algebra.
`;

// A nested page that mentions the basename token, proving the recursive walk is
// part of the cached scan and is skipped on a cache hit.
const NESTED = `---
title: Nested Mention
---

See also graph-theory notes.
`;

const FIXTURE = {
  'content/graph-theory.md': SOURCE,
  'content/by-basename.md': BY_BASENAME,
  'content/by-title.md': BY_TITLE,
  'content/no-mention.md': NO_MENTION,
  'content/sub/nested.md': NESTED,
};

const SOURCE_PATH = 'content/graph-theory.md';

// The proven pre-cache output for SOURCE_PATH. Field order matches the handler's
// returned object literal and each pushed mention ({file, matchedTerm}), so a
// JSON.stringify comparison pins byte-identity, not just structural equality. The
// source page itself is skipped (rel === path); no-mention.md matches no term.
const EXPECTED = {
  path: SOURCE_PATH,
  title: 'Graph Theory',
  mentions: [
    { file: 'content/by-basename.md', matchedTerm: 'graph-theory' },
    { file: 'content/by-title.md', matchedTerm: 'graph theory' },
    { file: 'content/sub/nested.md', matchedTerm: 'graph-theory' },
  ],
  total: 3,
};

describe('GET /api/file/mentions (result cached via cached("mentions:" + path))', () => {
  it('returns the expected mentions payload, byte-identical, on the first call', async () => {
    const fs = makeFs(FIXTURE);
    const { cached } = makeCached();
    const res = await getMentions(fs, cached, SOURCE_PATH);
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED);
    // Byte-identity: same fields, same order, same serialization as before caching.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED));
    assert.ok(fs.counts.readdirSync > 0, 'the first call walks content/');
    assert.ok(fs.counts.readFileSync > 0, 'the first call reads files');
  });

  it('serves a repeat request for the same path from cache with no repeat readdirSync / readFileSync', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    const first = await getMentions(fs, cached, SOURCE_PATH);
    const dirAfterFirst = fs.counts.readdirSync;
    const fileAfterFirst = fs.counts.readFileSync;
    assert.equal(first.status, 200);
    assert.ok(dirAfterFirst > 0 && fileAfterFirst > 0, 'the first call hits the filesystem');

    const second = await getMentions(fs, cached, SOURCE_PATH);
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(fs.counts.readdirSync, dirAfterFirst, 'cached repeat must not readdirSync again');
    assert.equal(fs.counts.readFileSync, fileAfterFirst, 'cached repeat must not readFileSync again');
    assert.equal(store.size, 1, 'one cache entry for the single path');
    assert.ok(store.has('mentions:' + SOURCE_PATH), 'cache key is "mentions:" + path');
  });

  it('keys each distinct path separately and re-scans for a new path', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    await getMentions(fs, cached, SOURCE_PATH);
    const dirAfterFirst = fs.counts.readdirSync;

    const other = await getMentions(fs, cached, 'content/by-title.md');
    assert.equal(other.status, 200);
    assert.ok(fs.counts.readdirSync > dirAfterFirst, 'a new path key misses the cache and re-walks content/');
    assert.equal(store.size, 2, 'each path gets its own cache entry');
    assert.ok(store.has('mentions:content/by-title.md'));
  });

  it('pins the cache key and the 30000 ms TTL the handler passes', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, calls } = makeCached();
    await getMentions(fs, cached, SOURCE_PATH);
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'mentions:' + SOURCE_PATH);
    assert.equal(calls[0].ttl, 30000);
  });

  it('returns 404 for a missing target file and never caches it', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();
    const first = await getMentions(fs, cached, 'content/missing.md');
    assert.equal(first.status, 404);
    assert.deepEqual(first.payload, { error: 'File not found' });
    assert.equal(store.size, 0, 'the 404 path is never cached');
    // The read threw inside cached() before anything was stored, so a repeat
    // request re-attempts the read and still 404s, never serving a cached error.
    const second = await getMentions(fs, cached, 'content/missing.md');
    assert.equal(second.status, 404);
    assert.deepEqual(second.payload, { error: 'File not found' });
    assert.equal(store.size, 0, 'still nothing cached after a repeat 404');
  });

  it('still enforces the 400 invalid-path guard before the cache', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    const res = await getMentions(fs, cached, 'bad', () => false);
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Invalid path' });
    assert.equal(calls.length, 0, 'the invalid-path guard returns before cached() is reached');
    assert.equal(store.size, 0);
    assert.equal(fs.counts.readdirSync, 0, 'no scan on an invalid path');
  });
});
