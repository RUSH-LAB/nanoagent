import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other route tests do
// (mirrors tests/next-studyknow-dedup-frontmatter.test.mjs).
const require = createRequire(import.meta.url);
const routes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`. It backs the
// content/ walk (readdirSync with withFileTypes-style entries plus readFileSync)
// and the direct bibliography/references.yaml read, and counts BOTH readdirSync
// and readFileSync so a cache hit can be proven to touch neither. Mirrors makeFs
// in tests/next-linksuggest-scan-cache.test.mjs.
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

// Memoizing cached(key, ttl, fn) backed by a Map, mirroring the server helper in
// server.js: run fn and store on a miss, return the stored value untouched on a
// hit. It also records every (key, ttl) pair so a test can assert the exact
// 'suggest:'-prefixed key and 30000 ms TTL the handler passes.
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

// Drive GET /api/search/suggest once. fs and cached are passed in so a single pair
// can be shared across calls within a test, letting the cache persist.
async function suggest(fs, cached, query) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    cached,
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/search/suggest?q=${encodeURIComponent(query)}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await routes(req, { writableEnded: false }, url, '/api/search/suggest', ctx);
  return captured;
}

// content/ holds two pages whose names contain "neural" (one with front matter so
// the title surfaces, one without so it falls back to the filename) plus an
// unrelated page and a non-markdown file that the extension filter drops.
// bibliography/references.yaml carries one matching entry and one that does not,
// exercising both the page and reference branches of the assembled payload.
const FIXTURE = {
  'content/neural-with-fm.md': '---\ntitle: Deep Neural Networks\n---\n\nBody about neural nets.\n',
  'content/neural-plain.md': 'Plain neural body with no front matter block.\n',
  'content/unrelated.md': '---\ntitle: Unrelated Page\n---\n\nNothing overlaps here.\n',
  'content/diagram.png': 'not markdown\n',
  'bibliography/references.yaml': 'neural2020:\n  title: A Neural Survey\n  author: [Jane Doe]\nother2019:\n  title: Something Else\n',
};

// The "neural" query in content/ walk order: the two matching pages (title from
// front matter, else the filename stem) followed by the matching reference.
const EXPECTED = {
  suggestions: [
    { type: 'page', text: 'Deep Neural Networks', path: 'content/neural-with-fm.md' },
    { type: 'page', text: 'neural-plain', path: 'content/neural-plain.md' },
    { type: 'reference', text: 'A Neural Survey', key: 'neural2020' },
  ],
};

describe('GET /api/search/suggest (per-query scan cache)', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    // A pass-through cached runs fn() every time and stores nothing, so it is the
    // pre-cache computation. The real memoizing cache must produce the same bytes.
    const passthrough = (_k, _t, fn) => fn();
    const preCache = await suggest(makeFs(FIXTURE), passthrough, 'neural');
    assert.equal(preCache.status, 200);
    assert.deepEqual(preCache.body, EXPECTED);

    const { cached } = makeCached();
    const cachedRes = await suggest(makeFs(FIXTURE), cached, 'neural');
    assert.equal(cachedRes.status, 200);
    assert.deepEqual(cachedRes.body, preCache.body);
    assert.deepEqual(cachedRes.body, EXPECTED);
  });

  it('serves a repeat request for the same query from cache without rescanning', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    const first = await suggest(fs, cached, 'neural');
    const afterReaddir = fs.counts.readdirSync;
    const afterReadFile = fs.counts.readFileSync;
    assert.equal(first.status, 200);
    assert.ok(afterReaddir > 0, 'the first call walks the content tree');
    assert.ok(afterReadFile > 0, 'the first call reads files');

    const second = await suggest(fs, cached, 'neural');
    assert.equal(second.status, 200);
    assert.equal(fs.counts.readdirSync, afterReaddir, 'no second directory walk');
    assert.equal(fs.counts.readFileSync, afterReadFile, 'no second file read');
    assert.deepEqual(second.body, first.body);
    // The production cached() hands back its stored object by reference, so the hit
    // returns the very same payload instance, never a re-scan or a clone.
    assert.strictEqual(second.body, first.body, 'the cache returns the same object reference');
    assert.equal(store.size, 1, 'one cache entry for the single query');
  });

  it('treats a different query as a distinct cache entry that scans again', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store } = makeCached();

    await suggest(fs, cached, 'neural');
    const afterFirst = fs.counts.readdirSync;

    const other = await suggest(fs, cached, 'unrelated');
    assert.equal(other.status, 200);
    assert.ok(fs.counts.readdirSync > afterFirst, 'a new query triggers a fresh scan');
    // "unrelated" matches only unrelated.md by filename, and no reference key or
    // title contains it, so this entry holds its OWN scan result rather than the
    // "neural" payload, pinning that the second key is a fresh computation.
    assert.deepEqual(other.body, {
      suggestions: [{ type: 'page', text: 'Unrelated Page', path: 'content/unrelated.md' }],
    });
    assert.equal(store.size, 2, 'each query gets its own cache entry');
  });

  it('returns the empty result for a short query before reaching the cache', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    // An empty term and a single-character term both trip the query.length < 2
    // early return, which sits above cached().
    for (const q of ['', 'a']) {
      const res = await suggest(fs, cached, q);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { suggestions: [] });
    }
    assert.equal(calls.length, 0, 'cached() is never entered for a short query');
    assert.equal(store.size, 0, 'nothing is cached for a short query');
    assert.equal(fs.counts.readdirSync, 0, 'no content scan for a short query');
  });

  it('does not cache when the scan throws', async () => {
    // No content/ directory in the fixture: readdirSync('/proj/content') throws,
    // the error propagates out of the cached() closure before it can store, and
    // the outer try/catch yields the empty fallback.
    const fs = makeFs({});
    const { cached, store, calls } = makeCached();

    const res = await suggest(fs, cached, 'neural');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { suggestions: [] });
    assert.equal(calls.length, 1, 'cached() was entered, so the throw is inside the closure');
    assert.equal(store.size, 0, 'the error result is never cached');

    // A second call re-runs the scan instead of serving a memoized empty payload.
    const beforeRetry = fs.counts.readdirSync;
    const retry = await suggest(fs, cached, 'neural');
    assert.deepEqual(retry.body, { suggestions: [] });
    assert.ok(fs.counts.readdirSync > beforeRetry, 'the error path is recomputed, not cached');
  });

  it('passes the exact suggest: key prefix and a 30000 ms TTL to cached()', async () => {
    const fs = makeFs(FIXTURE);
    const { cached, calls } = makeCached();
    await suggest(fs, cached, 'neural');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, 'suggest:neural');
    assert.equal(calls[0].ttl, 30000);
  });
});
