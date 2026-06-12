import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// files.js is CommonJS; load it the way the sibling per-key cache suites do
// (next-recommendv2-cache, next-trajectory-cache) and reuse their ctx-mocking
// shape. GET /api/files/search now wraps its directory walk in
// cached('search:list', 30000, () => flatFiles(fullDir)); these tests drive that
// wrap directly with a counting flatFiles and a memoizing cached, no network and
// no server. The mutation handlers (create, delete, rename, upload) each call
// invalidateCache('search') so the snapshot is cleared the moment a file changes.
const require = createRequire(import.meta.url);
const filesRoutes = require('../server/routes/files.js');

const PROJECT_ROOT = '/fake/root';

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js
// helper: run fn and store on a miss, return the stored value untouched on a hit.
// Every call is recorded in `calls` so a test can pin the exact key and TTL the
// handler passes.
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

// Build a counting flatFiles + readFileSync pair sharing one set of counters, so
// a test can prove a repeat search reuses the cached list (flatFiles stays at 1)
// while the per-match title read still touches disk every time (not cached).
function makeSearchEnv(files, contents) {
  const abs = new Map(
    Object.entries(contents).map(([rel, text]) => [path.join(PROJECT_ROOT, rel), text])
  );
  const counts = { flatFiles: 0, readFileSync: 0 };
  const flatFiles = () => { counts.flatFiles++; return files; };
  const fs = {
    readFileSync(fp) {
      counts.readFileSync++;
      if (abs.has(fp)) return abs.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
  return { flatFiles, fs, counts };
}

// Drive GET /api/files/search with the supplied flatFiles/fs/cached and capture
// the json() response.
async function search({ flatFiles, fs, cached, query }) {
  let captured = null;
  const ctx = {
    path, PROJECT_ROOT, cached, flatFiles, fs,
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/files/search?q=${encodeURIComponent(query)}`);
  await filesRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/files/search', ctx);
  return captured;
}

// Drive an arbitrary files.js route with a mocked ctx and capture the response.
async function invokeRoute({ method, pathname, search: qs = '', ctx }) {
  const url = new URL(`http://localhost${pathname}${qs}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await filesRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

// alpha carries a YAML front-matter `title:` (so the handler surfaces it); beta
// has no front-matter (so the title falls back to the filename minus extension);
// gamma lives under content/sub so it only matches a distinct query, proving the
// cached list still filters correctly for a different query.
const WITH_FM_ALPHA = `---
title: Alpha Title
---

Body text for alpha.
`;

const NO_FM_BETA = `Just body text for beta, with no front matter at all.
`;

const WITH_FM_GAMMA = `---
title: Gamma Title
---

Body text for gamma.
`;

const FILES = [
  { name: 'alpha-note.md', path: 'content/alpha-note.md' },
  { name: 'beta-note.md', path: 'content/beta-note.md' },
  { name: 'gamma-doc.md', path: 'content/sub/gamma-doc.md' },
];

const CONTENTS = {
  'content/alpha-note.md': WITH_FM_ALPHA,
  'content/beta-note.md': NO_FM_BETA,
  'content/sub/gamma-doc.md': WITH_FM_GAMMA,
};

// The proven output for query "note": the two "note" files in flatFiles order,
// each enriched with its title ({name, path, title} matches the handler's
// {...f, title} literal). A JSON.stringify comparison pins serialization, not
// just structural equality.
const EXPECTED_NOTE = {
  files: [
    { name: 'alpha-note.md', path: 'content/alpha-note.md', title: 'Alpha Title' },
    { name: 'beta-note.md', path: 'content/beta-note.md', title: 'beta-note' },
  ],
};

describe('GET /api/files/search (walk cached via cached("search:list", 30000, ...))', () => {
  it('returns the expected {files} payload byte-identically and narrows by query', async () => {
    const { flatFiles, fs, counts } = makeSearchEnv(FILES, CONTENTS);
    const { cached } = makeCached();

    const res = await search({ flatFiles, fs, cached, query: 'note' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, EXPECTED_NOTE);
    // Byte-identity: same fields, same order, same serialization as before caching.
    assert.equal(JSON.stringify(res.body), JSON.stringify(EXPECTED_NOTE));
    // The per-query filter narrowed to the two "note" files, dropping gamma.
    assert.deepEqual(res.body.files.map(f => f.path), ['content/alpha-note.md', 'content/beta-note.md']);
    assert.equal(counts.flatFiles, 1, 'the first search walks the tree once');
  });

  it('serves a repeat search from the cached list with no second flatFiles walk', async () => {
    const { flatFiles, fs, counts } = makeSearchEnv(FILES, CONTENTS);
    const { cached, store } = makeCached();

    const first = await search({ flatFiles, fs, cached, query: 'note' });
    assert.equal(first.status, 200);
    assert.equal(counts.flatFiles, 1, 'the first search walks the tree');

    // A second search with a DIFFERENT query reuses the cached list: no second
    // walk, yet the filter still narrows correctly against the snapshot.
    const second = await search({ flatFiles, fs, cached, query: 'gamma' });
    assert.equal(second.status, 200);
    assert.equal(counts.flatFiles, 1, 'the repeat search reuses the cached list, no second walk');
    assert.deepEqual(second.body.files.map(f => f.path), ['content/sub/gamma-doc.md']);
    assert.equal(second.body.files[0].title, 'Gamma Title');
    assert.equal(store.size, 1, 'a single cache entry keyed by search:list');
    assert.ok(store.has('search:list'), 'the cache key is search:list');
  });

  it('returns the full cached list for an empty query', async () => {
    const { flatFiles, fs, counts } = makeSearchEnv(FILES, CONTENTS);
    const { cached } = makeCached();

    const res = await search({ flatFiles, fs, cached, query: '' });
    assert.equal(res.status, 200);
    // The empty-query branch returns the cached list verbatim (no title field).
    assert.deepEqual(res.body, { files: FILES });
    assert.equal(JSON.stringify(res.body), JSON.stringify({ files: FILES }));
    assert.equal(counts.flatFiles, 1, 'the empty-query branch still routes through the cache once');
  });

  it('passes the exact cache key "search:list" and a 30000 ms TTL', async () => {
    const { flatFiles, fs } = makeSearchEnv(FILES, CONTENTS);
    const { cached, calls } = makeCached();

    await search({ flatFiles, fs, cached, query: 'note' });
    assert.ok(calls.length >= 1, 'the handler routes the walk through cached()');
    assert.equal(calls[0].key, 'search:list');
    assert.equal(calls[0].ttl, 30000);
  });

  it('returns 500 and caches nothing when the walk throws (the catch stays outside the closure)', async () => {
    // The outer try/catch wraps cached(), and server.js cached() runs fn() before
    // it stores, so a throwing walk propagates to the 500 handler and leaves
    // 'search:list' unset, so the next search retries rather than serving an error.
    const { cached, store } = makeCached();
    const flatFiles = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
    const fs = { readFileSync() { throw new Error('unreached: the walk fails first'); } };
    const res = await search({ flatFiles, fs, cached, query: 'note' });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Search failed' });
    assert.equal(store.has('search:list'), false, 'a failed walk caches nothing, so the next search retries');
  });
});

describe('file mutations clear the "search" cache prefix (so search:list is dropped)', () => {
  it('POST /api/file (create) invalidates search', async () => {
    const invalidations = [];
    const ctx = {
      path, PROJECT_ROOT,
      rateLimit: () => true,
      isValidFilePath: () => true,
      readBody: async () => ({ path: 'content/new.md', content: 'hello' }),
      invalidateCache: (p) => invalidations.push(p),
      fs: { existsSync: () => false, mkdirSync: () => {}, writeFileSync: () => {} },
    };
    const res = await invokeRoute({ method: 'POST', pathname: '/api/file', ctx });
    assert.equal(res.status, 200);
    assert.ok(invalidations.includes('search'), 'create clears the search cache');
  });

  it('DELETE /api/file invalidates search', async () => {
    const invalidations = [];
    const ctx = {
      path, PROJECT_ROOT,
      rateLimit: () => true,
      isValidFilePath: () => true,
      invalidateCache: (p) => invalidations.push(p),
      TRASH_DIR: path.join(PROJECT_ROOT, '.trash'),
      fs: { existsSync: () => true, mkdirSync: () => {}, renameSync: () => {} },
    };
    const res = await invokeRoute({ method: 'DELETE', pathname: '/api/file', search: '?path=content/old.md', ctx });
    assert.equal(res.status, 200);
    assert.ok(invalidations.includes('search'), 'delete clears the search cache');
  });

  it('POST /api/file/rename invalidates search', async () => {
    const invalidations = [];
    const fullOld = path.join(PROJECT_ROOT, 'content/old.md');
    const ctx = {
      path, PROJECT_ROOT,
      isValidFilePath: () => true,
      readBody: async () => ({ oldPath: 'content/old.md', newPath: 'content/new.md' }),
      invalidateCache: (p) => invalidations.push(p),
      // fullOld exists (source), fullNew does not (target), so the rename runs.
      fs: { existsSync: (p) => p === fullOld, mkdirSync: () => {}, renameSync: () => {} },
    };
    const res = await invokeRoute({ method: 'POST', pathname: '/api/file/rename', ctx });
    assert.equal(res.status, 200);
    assert.ok(invalidations.includes('search'), 'rename clears the search cache');
  });

  it('POST /api/upload invalidates search', async () => {
    const invalidations = [];
    const ctx = {
      path, PROJECT_ROOT,
      IMAGE_EXTS: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
      readRawBody: async () => Buffer.from('binary-image-bytes'),
      invalidateCache: (p) => invalidations.push(p),
      fs: { mkdirSync: () => {}, writeFileSync: () => {} },
    };
    const res = await invokeRoute({ method: 'POST', pathname: '/api/upload', search: '?name=pic.png', ctx });
    assert.equal(res.status, 200);
    assert.ok(invalidations.includes('search'), 'upload clears the search cache');
  });
});
