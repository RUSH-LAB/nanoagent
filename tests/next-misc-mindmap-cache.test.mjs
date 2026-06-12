import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it via createRequire the way the sibling per-path
// cache suites do (next-misc-filequality-cache.test.mjs) and reuse the same
// ctx-mocking shape. GET /api/file/mindmap now wraps its whole computation in
// cached('filemindmap:' + filePath, 30000, fn); these tests drive that wrap
// directly with a counting fs and a memoizing cached, no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';

// In-memory fs stub that returns a single file's content keyed by absolute path and
// counts how often the handler touches disk. The handler reads exactly one file
// (fs.readFileSync(path.join(PROJECT_ROOT, filePath))) and never walks a directory,
// so the stub only needs readFileSync. The counter lets a test prove a cache hit
// performs no fresh read while the first call provably hits disk.
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

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js
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

// Invoke GET /api/file/mindmap with a mocked ctx and capture the response handed to
// json(res, status, payload). isValidFilePath defaults to accepting the path so the
// happy path reaches the file read; pass a rejecting validator to exercise the 400
// guard.
async function invoke(filePath, { fs, cached, isValidFilePath = () => true }) {
  const pathname = '/api/file/mindmap';
  const url = new URL(`http://localhost${pathname}?path=${encodeURIComponent(filePath)}`);
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
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// ── fixtures ──

const MINDMAP_REL = 'content/mindmap-sample.md';
const MINDMAP_ABS = path.join(PROJECT_ROOT, MINDMAP_REL);

// A document with frontmatter (title + date), one H1, two H2s, and one nested H3.
// After the frontmatter strip the handler keeps only the #{1,4} heading lines, so
// the tree nests Section A and Section B under Heading One and Subsection B1 under
// Section B. The root text is the basename with the extension stripped
// ('mindmap-sample'). These hand-countable nodes anchor the byte-identity check.
const MINDMAP_SAMPLE = `---
title: Mindmap Sample
date: 2026-02-02
---

# Heading One

Alpha beta gamma delta.

## Section A

More text here for section a.

## Section B

### Subsection B1

Leaf text under b one.
`;

// A second, clearly different file so the per-path cache keys are provably
// independent: a single H1 and no nesting, distinct from the sample's deep tree.
const MINDMAP_REL_2 = 'content/mindmap-other.md';
const MINDMAP_ABS_2 = path.join(PROJECT_ROOT, MINDMAP_REL_2);
const MINDMAP_SAMPLE_2 = `---
title: Other Mindmap
date: 2026-03-03
---

# Only Heading

Short body with a few words.
`;

describe('GET /api/file/mindmap (cached("filemindmap:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    // The memoizing run (first call computes via fn) and the pass-through run (fn
    // inline, the exact pre-cache path) must serialize identically.
    const viaCache = await invoke(MINDMAP_REL, { ...makeCountingFs(new Map([[MINDMAP_ABS, MINDMAP_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke(MINDMAP_REL, { ...makeCountingFs(new Map([[MINDMAP_ABS, MINDMAP_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    // Concrete anchors hand-counted from MINDMAP_SAMPLE: root basename, the single
    // H1, its two H2 children, and the H3 nested under the second H2.
    assert.equal(viaCache.payload.root.text, 'mindmap-sample');
    assert.equal(viaCache.payload.root.children.length, 1);
    assert.equal(viaCache.payload.root.children[0].text, 'Heading One');
    assert.equal(viaCache.payload.root.children[0].children.length, 2);
    assert.equal(viaCache.payload.root.children[0].children[0].text, 'Section A');
    assert.deepEqual(viaCache.payload.root.children[0].children[0].children, []);
    assert.equal(viaCache.payload.root.children[0].children[1].text, 'Section B');
    assert.equal(viaCache.payload.root.children[0].children[1].children.length, 1);
    assert.equal(viaCache.payload.root.children[0].children[1].children[0].text, 'Subsection B1');
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[MINDMAP_ABS, MINDMAP_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke(MINDMAP_REL, { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');

    const second = await invoke(MINDMAP_REL, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has('filemindmap:' + MINDMAP_REL), 'cache key is filemindmap:<path>');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[MINDMAP_ABS, MINDMAP_SAMPLE], [MINDMAP_ABS_2, MINDMAP_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke(MINDMAP_REL, { fs, cached });
    const b = await invoke(MINDMAP_REL_2, { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has('filemindmap:' + MINDMAP_REL));
    assert.ok(store.has('filemindmap:' + MINDMAP_REL_2));
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.equal(a.payload.root.text, 'mindmap-sample');
    assert.equal(b.payload.root.text, 'mindmap-other');
    assert.equal(b.payload.root.children.length, 1);
    assert.equal(b.payload.root.children[0].text, 'Only Heading');
    assert.deepEqual(b.payload.root.children[0].children, []);
    assert.notEqual(a.payload.root.children[0].children.length, b.payload.root.children[0].children.length);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the filemindmap: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[MINDMAP_ABS, MINDMAP_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke(MINDMAP_REL, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'filemindmap:' + MINDMAP_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('../etc/passwd', { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when the file cannot be read (read stays inside the closure)', async () => {
    // Empty fs: the readFileSync inside fn() throws ENOENT; the real server.js
    // cached() runs fn() before it stores, so the throw leaves nothing cached and
    // the outer catch returns the 404 envelope.
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke(MINDMAP_REL, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});
