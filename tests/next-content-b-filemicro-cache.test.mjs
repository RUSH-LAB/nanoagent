import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it via createRequire the way the sibling
// per-key cache suite does (next-content-b-ref-caches.test.mjs) and reuse its
// ctx-mocking shape. GET /api/file/style now wraps its whole computation in
// cached('filestyle:' + filePath, 30000, fn) and GET /api/file/complexity in
// cached('filecomplexity:' + filePath, 30000, fn); these tests drive both wraps
// directly with a counting fs and a memoizing cached, no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/proj';

// In-memory fs stub that returns a single file's content keyed by absolute path
// and counts how often each handler touches disk. Both handlers read exactly one
// file (fs.readFileSync(path.join(PROJECT_ROOT, filePath))) and never walk a
// directory, so the stub only needs readFileSync. The counter lets a test prove a
// cache hit performs no fresh read while the first call provably hits disk.
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
// pre-cache code path. The byte-identity tests compare the memoized output against
// a pass-through run to prove the cache wrapper alters nothing.
function passThroughCached() {
  const calls = [];
  const cached = (key, ttl, fn) => { calls.push({ key, ttl }); return fn(); };
  return { cached, calls };
}

// Invoke a GET handler with a mocked ctx and capture the response handed to
// json(res, status, payload). isValidFilePath defaults to accepting the path so
// the happy path reaches the file read; pass a rejecting validator to exercise
// the 400 guard.
async function invoke(pathname, filePath, { fs, cached, isValidFilePath = () => true }) {
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

// ── style fixture ──

const STYLE_REL = 'content/style-sample.md';
const STYLE_ABS = path.join(PROJECT_ROOT, STYLE_REL);

// The exact content next-style-passive-hoist.test.mjs pins, so its proven outputs
// anchor the byte-identity comparison here: 5 sentences after the [.!?]+ split, 3
// passive constructions in the body (the frontmatter "was reviewed" is stripped),
// so round(3 / 5 * 100) = 60.
const STYLE_SAMPLE = `---
title: Style Sample
note: this file was reviewed already
---

The document was created by the author. This page is maintained regularly. Readers enjoy the clear prose style here. The results are summarized in a table. We discuss the method in detail today.
`;
const STYLE_EXPECTED_SENTENCES = 5;
const STYLE_EXPECTED_PASSIVE_PCT = 60;

// A second, clearly different style file so the per-path cache keys are provably
// independent (different totalWords, two distinct cache entries).
const STYLE_REL_2 = 'content/style-other.md';
const STYLE_ABS_2 = path.join(PROJECT_ROOT, STYLE_REL_2);
const STYLE_SAMPLE_2 = `Short note here. Only this.
`;

// ── complexity fixture ──

const CX_REL = 'content/complexity-sample.md';
const CX_ABS = path.join(PROJECT_ROOT, CX_REL);

// content.split(/\s+/).filter(Boolean) yields 11 tokens (# Heading One + the eight
// body words). One ATX heading line matches /^#{1,6}\s+/gm, so headings = 1. These
// two easily-counted fields anchor the byte-identity comparison.
const CX_SAMPLE = `# Heading One

Alpha beta gamma delta. Epsilon zeta eta theta.
`;
const CX_EXPECTED_WORDS = 11;
const CX_EXPECTED_HEADINGS = 1;

// A second complexity file with a different word count (7) so the per-path cache
// keys are provably independent.
const CX_REL_2 = 'content/complexity-other.md';
const CX_ABS_2 = path.join(PROJECT_ROOT, CX_REL_2);
const CX_SAMPLE_2 = `Plain line with a few words here.
`;

describe('GET /api/file/style (cached("filestyle:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    // The memoizing run (first call computes via fn) and the pass-through run
    // (fn inline, the exact pre-cache path) must serialize identically.
    const viaCache = await invoke('/api/file/style', STYLE_REL, { ...makeCountingFs(new Map([[STYLE_ABS, STYLE_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke('/api/file/style', STYLE_REL, { ...makeCountingFs(new Map([[STYLE_ABS, STYLE_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    // Concrete anchors proven by next-style-passive-hoist.test.mjs for this content.
    assert.equal(viaCache.payload.style.totalSentences, STYLE_EXPECTED_SENTENCES);
    assert.equal(viaCache.payload.style.passiveVoicePercentage, STYLE_EXPECTED_PASSIVE_PCT);
    assert.equal(viaCache.payload.path, STYLE_REL);
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[STYLE_ABS, STYLE_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke('/api/file/style', STYLE_REL, { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');

    const second = await invoke('/api/file/style', STYLE_REL, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has('filestyle:' + STYLE_REL), 'cache key is filestyle:<path>');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[STYLE_ABS, STYLE_SAMPLE], [STYLE_ABS_2, STYLE_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke('/api/file/style', STYLE_REL, { fs, cached });
    const b = await invoke('/api/file/style', STYLE_REL_2, { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has('filestyle:' + STYLE_REL));
    assert.ok(store.has('filestyle:' + STYLE_REL_2));
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.notEqual(a.payload.style.totalWords, b.payload.style.totalWords);
    assert.equal(a.payload.path, STYLE_REL);
    assert.equal(b.payload.path, STYLE_REL_2);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the filestyle: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[STYLE_ABS, STYLE_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke('/api/file/style', STYLE_REL, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'filestyle:' + STYLE_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/style', '../etc/passwd', { fs, cached, isValidFilePath: () => false });
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
    const r = await invoke('/api/file/style', STYLE_REL, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});

describe('GET /api/file/complexity (cached("filecomplexity:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    const viaCache = await invoke('/api/file/complexity', CX_REL, { ...makeCountingFs(new Map([[CX_ABS, CX_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke('/api/file/complexity', CX_REL, { ...makeCountingFs(new Map([[CX_ABS, CX_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.equal(viaCache.payload.metrics.wordCount, CX_EXPECTED_WORDS);
    assert.equal(viaCache.payload.metrics.headings, CX_EXPECTED_HEADINGS);
    assert.equal(viaCache.payload.path, CX_REL);
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[CX_ABS, CX_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke('/api/file/complexity', CX_REL, { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');

    const second = await invoke('/api/file/complexity', CX_REL, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has('filecomplexity:' + CX_REL), 'cache key is filecomplexity:<path>');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[CX_ABS, CX_SAMPLE], [CX_ABS_2, CX_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke('/api/file/complexity', CX_REL, { fs, cached });
    const b = await invoke('/api/file/complexity', CX_REL_2, { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has('filecomplexity:' + CX_REL));
    assert.ok(store.has('filecomplexity:' + CX_REL_2));
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.notEqual(a.payload.metrics.wordCount, b.payload.metrics.wordCount);
    assert.equal(a.payload.path, CX_REL);
    assert.equal(b.payload.path, CX_REL_2);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the filecomplexity: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[CX_ABS, CX_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke('/api/file/complexity', CX_REL, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'filecomplexity:' + CX_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/complexity', '../etc/passwd', { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when the file cannot be read (read stays inside the closure)', async () => {
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/complexity', CX_REL, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});
