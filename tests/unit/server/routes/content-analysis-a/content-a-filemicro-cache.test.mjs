import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it via createRequire the way the sibling
// per-file cache suite does (next-content-b-filemicro-cache.test.mjs) and reuse its
// ctx-mocking shape. Three GET handlers now wrap their per-file scan in cached(...):
//   GET /api/file/similarity -> cached('similarity:' + path1 + ':' + path2, 30000, fn)
//   GET /api/file/health     -> cached('filehealth:' + path, 30000, fn)
//   GET /api/file/toc-tree   -> cached('toctree:' + path, 30000, fn)
// These tests drive all three wraps directly with a counting fs and a memoizing
// cached, no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/proj';

// In-memory fs stub returning file contents keyed by absolute path and counting how
// often a handler touches disk. All three handlers read content files with
// fs.readFileSync(path.join(PROJECT_ROOT, p)) and never walk a directory, so the stub
// only needs readFileSync. The counter lets a test prove a cache hit performs no
// fresh read while the first call provably hits disk.
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
// pre-cache code path. The byte-identity tests compare the memoized output against a
// pass-through run to prove the cache wrapper alters nothing.
function passThroughCached() {
  const calls = [];
  const cached = (key, ttl, fn) => { calls.push({ key, ttl }); return fn(); };
  return { cached, calls };
}

// Invoke a GET handler with a mocked ctx and capture the response handed to
// json(res, status, payload). isValidFilePath defaults to accepting every path so the
// happy path reaches the file read; pass a rejecting validator to exercise the 400
// guard.
async function invoke(pathname, search, { fs, cached, isValidFilePath = () => true }) {
  const url = new URL(`http://localhost${pathname}${search}`);
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

const qp = v => encodeURIComponent(v);

// ── similarity fixtures ──

const SIM_A_REL = 'content/sim-a.md';
const SIM_B_REL = 'content/sim-b.md';
const SIM_C_REL = 'content/sim-c.md';
const SIM_A_ABS = path.join(PROJECT_ROOT, SIM_A_REL);
const SIM_B_ABS = path.join(PROJECT_ROOT, SIM_B_REL);
const SIM_C_ABS = path.join(PROJECT_ROOT, SIM_C_REL);

// set(a) = {apple, banana, cherry, delta}, set(b) = {cherry, delta, mango, peach}.
// intersection {cherry, delta} = 2; union = 4 + 4 - 2 = 6; 2 / 6 = 0.333. sharedWords
// follows set(a) insertion order, so [cherry, delta]. These mirror the proven
// partial-overlap case in next-file-similarity-union-algebra.test.mjs. Every word is
// length > 3 and none is a SIMILARITY_STOP_WORD, so the keyword sets are exactly these.
const SIM_A = 'apple banana cherry delta';
const SIM_B = 'cherry delta mango peach';
const SIM_C = 'mango peach quince raisin';
const SIM_AB_EXPECTED = {
  similarity: 0.333,
  sharedWords: ['cherry', 'delta'],
  uniqueToFile1: 2,
  uniqueToFile2: 2,
  sharedCount: 2,
};

function simFs() {
  return makeCountingFs(new Map([[SIM_A_ABS, SIM_A], [SIM_B_ABS, SIM_B], [SIM_C_ABS, SIM_C]]));
}
const simSearch = (p1, p2) => `?path1=${qp(p1)}&path2=${qp(p2)}`;

describe('GET /api/file/similarity (cached("similarity:" + path1 + ":" + path2, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    const viaCache = await invoke('/api/file/similarity', simSearch(SIM_A_REL, SIM_B_REL), { ...simFs(), ...makeCached() });
    const viaPre = await invoke('/api/file/similarity', simSearch(SIM_A_REL, SIM_B_REL), { ...simFs(), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.deepEqual(viaCache.payload, SIM_AB_EXPECTED);
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = simFs();
    const { cached, store } = makeCached();

    const first = await invoke('/api/file/similarity', simSearch(SIM_A_REL, SIM_B_REL), { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 2, 'the first call reads both files once');

    const second = await invoke('/api/file/similarity', simSearch(SIM_A_REL, SIM_B_REL), { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 2, 'cached repeat must not read either file again');
    assert.equal(store.size, 1, 'one cache entry for the path pair');
    assert.ok(store.has('similarity:' + SIM_A_REL + ':' + SIM_B_REL), 'cache key is similarity:<path1>:<path2>');
  });

  it('keys the cache per path pair so a different second path re-reads', async () => {
    const { fs, counts } = simFs();
    const { cached, store } = makeCached();

    const ab = await invoke('/api/file/similarity', simSearch(SIM_A_REL, SIM_B_REL), { fs, cached });
    const ac = await invoke('/api/file/similarity', simSearch(SIM_A_REL, SIM_C_REL), { fs, cached });
    assert.equal(ab.status, 200);
    assert.equal(ac.status, 200);
    assert.equal(store.size, 2, 'two path pairs produce two cache entries');
    assert.ok(store.has('similarity:' + SIM_A_REL + ':' + SIM_B_REL));
    assert.ok(store.has('similarity:' + SIM_A_REL + ':' + SIM_C_REL));
    // sim-a and sim-c share no words, so the second pair scores differently.
    assert.notEqual(ab.payload.similarity, ac.payload.similarity);
    assert.equal(ac.payload.similarity, 0);
    assert.equal(counts.readFileSync, 4, 'each distinct pair reads its two files');
  });

  it('pins the similarity: key and the 30000 ms TTL', async () => {
    const { fs } = simFs();
    const { cached, calls } = makeCached();
    await invoke('/api/file/similarity', simSearch(SIM_A_REL, SIM_B_REL), { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'similarity:' + SIM_A_REL + ':' + SIM_B_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = simFs();
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/similarity', simSearch('../etc/passwd', SIM_B_REL), { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid paths' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when a file cannot be read (reads stay inside the closure)', async () => {
    // Empty fs: the first readFileSync inside fn() throws ENOENT; the real server/index.js
    // cached() runs fn() before it stores, so the throw leaves nothing cached and the
    // outer catch returns the 404 envelope.
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/similarity', simSearch(SIM_A_REL, SIM_B_REL), { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});

// ── health fixtures ──

const HEALTH_REL = 'content/health-sample.md';
const HEALTH_ABS = path.join(PROJECT_ROOT, HEALTH_REL);
// Frontmatter with title + tags + date scores 10 + 10 + 5 + 5 = 30; 13 whitespace
// tokens give round(13 / 50) = 0 word points; one ATX heading adds min(15, 1 * 3) = 3;
// no citations, links, or images. Total 33, so the level is "needs-improvement".
// imagesWithoutAlt is absent because there are zero alt-less images.
const HEALTH_SAMPLE = `---
title: T
tags: [x]
date: 2026-01-01
---
# H1
alpha beta gamma
`;
const HEALTH_EXPECTED = {
  path: HEALTH_REL,
  healthScore: 33,
  level: 'needs-improvement',
  checks: { hasFrontmatter: true, hasTitle: true, hasTags: true, hasDate: true, wordCount: 13, headings: 1, citations: 0, links: 0, images: 0 },
};

const HEALTH_REL_2 = 'content/health-other.md';
const HEALTH_ABS_2 = path.join(PROJECT_ROOT, HEALTH_REL_2);
// No frontmatter, five words, no structure: score 0, level "minimal". A clearly
// different score from HEALTH_SAMPLE so the per-path entries are provably independent.
const HEALTH_SAMPLE_2 = `plain text no frontmatter here
`;

const fileSearch = p => `?path=${qp(p)}`;

describe('GET /api/file/health (cached("filehealth:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    const viaCache = await invoke('/api/file/health', fileSearch(HEALTH_REL), { ...makeCountingFs(new Map([[HEALTH_ABS, HEALTH_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke('/api/file/health', fileSearch(HEALTH_REL), { ...makeCountingFs(new Map([[HEALTH_ABS, HEALTH_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.deepEqual(viaCache.payload, HEALTH_EXPECTED);
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[HEALTH_ABS, HEALTH_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke('/api/file/health', fileSearch(HEALTH_REL), { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');

    const second = await invoke('/api/file/health', fileSearch(HEALTH_REL), { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has('filehealth:' + HEALTH_REL), 'cache key is filehealth:<path>');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[HEALTH_ABS, HEALTH_SAMPLE], [HEALTH_ABS_2, HEALTH_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke('/api/file/health', fileSearch(HEALTH_REL), { fs, cached });
    const b = await invoke('/api/file/health', fileSearch(HEALTH_REL_2), { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has('filehealth:' + HEALTH_REL));
    assert.ok(store.has('filehealth:' + HEALTH_REL_2));
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.notEqual(a.payload.healthScore, b.payload.healthScore);
    assert.equal(b.payload.level, 'minimal');
    assert.equal(a.payload.path, HEALTH_REL);
    assert.equal(b.payload.path, HEALTH_REL_2);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the filehealth: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[HEALTH_ABS, HEALTH_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke('/api/file/health', fileSearch(HEALTH_REL), { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'filehealth:' + HEALTH_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/health', fileSearch('../etc/passwd'), { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when the file cannot be read (read stays inside the closure)', async () => {
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/health', fileSearch(HEALTH_REL), { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});

// ── toc-tree fixtures ──

const TOC_REL = 'content/toc-sample.md';
const TOC_ABS = path.join(PROJECT_ROOT, TOC_REL);
// Five headings (# A, ## B, ## C, ### D, # E) nest into two top-level nodes: A holds B
// and C, C holds D, and E stands alone. The frontmatter delimiters are not fenced code,
// so they never toggle the code-skip and never match the heading regex.
const TOC_SAMPLE = `---
title: TOC
---
# A
## B
## C
### D
# E
`;
const TOC_EXPECTED = {
  tree: [
    { text: 'A', level: 1, children: [
      { text: 'B', level: 2, children: [] },
      { text: 'C', level: 2, children: [{ text: 'D', level: 3, children: [] }] },
    ] },
    { text: 'E', level: 1, children: [] },
  ],
  totalHeadings: 5,
};

const TOC_REL_2 = 'content/toc-other.md';
const TOC_ABS_2 = path.join(PROJECT_ROOT, TOC_REL_2);
// A single heading: a clearly different tree and totalHeadings so the per-path entries
// are provably independent.
const TOC_SAMPLE_2 = `# Solo
`;

describe('GET /api/file/toc-tree (cached("toctree:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    const viaCache = await invoke('/api/file/toc-tree', fileSearch(TOC_REL), { ...makeCountingFs(new Map([[TOC_ABS, TOC_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke('/api/file/toc-tree', fileSearch(TOC_REL), { ...makeCountingFs(new Map([[TOC_ABS, TOC_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.deepEqual(viaCache.payload, TOC_EXPECTED);
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[TOC_ABS, TOC_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke('/api/file/toc-tree', fileSearch(TOC_REL), { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');

    const second = await invoke('/api/file/toc-tree', fileSearch(TOC_REL), { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has('toctree:' + TOC_REL), 'cache key is toctree:<path>');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[TOC_ABS, TOC_SAMPLE], [TOC_ABS_2, TOC_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke('/api/file/toc-tree', fileSearch(TOC_REL), { fs, cached });
    const b = await invoke('/api/file/toc-tree', fileSearch(TOC_REL_2), { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has('toctree:' + TOC_REL));
    assert.ok(store.has('toctree:' + TOC_REL_2));
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.notEqual(a.payload.totalHeadings, b.payload.totalHeadings);
    assert.equal(b.payload.totalHeadings, 1);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the toctree: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[TOC_ABS, TOC_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke('/api/file/toc-tree', fileSearch(TOC_REL), { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'toctree:' + TOC_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/toc-tree', fileSearch('../etc/passwd'), { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when the file cannot be read (read stays inside the closure)', async () => {
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/toc-tree', fileSearch(TOC_REL), { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});
