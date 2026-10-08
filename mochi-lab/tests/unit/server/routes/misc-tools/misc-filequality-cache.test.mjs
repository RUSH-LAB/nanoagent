import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { key } from '../../../_harness.mjs';
import {repositoryContext} from './_document-repository.mjs';

// misc-tools.js is CommonJS; load it via createRequire the way the sibling per-path
// cache suites do (next-content-b-filemicro-cache.test.mjs) and reuse the same
// ctx-mocking shape. GET /api/content/analysis/quality now wraps its whole computation in
// cached(cacheKey(orgId, 'filequality:' + filePath), 30000, fn); these tests drive that wrap
// directly with a counting fs and a memoizing cached, no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';
// The path a request carries is relative to the caller's own content root, which
// the session resolves to one organization's tree under content/.
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content', 'mochi');

// In-memory fs stub that returns a single file's content keyed by absolute path and
// counts how often the handler touches disk. The handler reads exactly one file
// (fs.readFileSync(path.join(contentRootFor(orgId), filePath))) and never walks a directory,
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
    const val = Promise.resolve().then(fn);
    store.set(key, val);
    val.catch(() => { if (store.get(key) === val) store.delete(key); });
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

// Invoke GET /api/content/analysis/quality with a mocked ctx and capture the response handed to
// json(res, status, payload). isValidFilePath defaults to accepting the path so the
// happy path reaches the file read; pass a rejecting validator to exercise the 400
// guard.
async function invoke(filePath, { fs, cached, isValidFilePath = () => true }) {
  const pathname = '/api/content/analysis/quality';
  const url = new URL(`http://localhost${pathname}?path=${encodeURIComponent(filePath)}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    contentRootFor: () => CONTENT_DIR,
    isValidFilePath,
    cached,
    cacheKey: (_orgId, name) => key(name),
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...repositoryContext({fs, root: CONTENT_DIR, path}),
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// ── fixtures ──

const QUALITY_REL = 'quality-sample.md';
const QUALITY_ABS = path.join(CONTENT_DIR, QUALITY_REL);

// A document with frontmatter (title + date), one H1 and one H2, and a plain body.
// After the frontmatter strip the body splits into 24 whitespace tokens, so
// breakdown.words.wordCount === 24; the frontmatter has both title and date, so
// breakdown.structure.frontmatter === 15; headingCounts === {h1:1, h2:1, h3:0}.
// These hand-countable fields anchor the byte-identity comparison.
const QUALITY_SAMPLE = `---
title: Sample Quality Doc
date: 2026-02-02
---

# Heading One

Alpha beta gamma delta epsilon zeta eta theta.

## Section Two

Iota kappa lambda mu nu xi omicron pi rho sigma.
`;
const QUALITY_EXPECTED_WORDS = 24;
const QUALITY_EXPECTED_FRONTMATTER = 15;
const QUALITY_EXPECTED_HEADINGS = { h1: 1, h2: 1, h3: 0 };

// A second, clearly different file so the per-path cache keys are provably
// independent (different wordCount, two distinct cache entries).
const QUALITY_REL_2 = 'quality-other.md';
const QUALITY_ABS_2 = path.join(CONTENT_DIR, QUALITY_REL_2);
const QUALITY_SAMPLE_2 = `---
title: Other Doc
date: 2026-03-03
---

Short body with only a few words here today.
`;
const QUALITY_EXPECTED_WORDS_2 = 9;

describe('GET /api/content/analysis/quality (cached("filequality:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    // The memoizing run (first call computes via fn) and the pass-through run (fn
    // inline, the exact pre-cache path) must serialize identically.
    const viaCache = await invoke(QUALITY_REL, { ...makeCountingFs(new Map([[QUALITY_ABS, QUALITY_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke(QUALITY_REL, { ...makeCountingFs(new Map([[QUALITY_ABS, QUALITY_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    // Concrete anchors hand-counted from QUALITY_SAMPLE.
    assert.equal(viaCache.payload.path, QUALITY_REL);
    assert.equal(viaCache.payload.breakdown.words.wordCount, QUALITY_EXPECTED_WORDS);
    assert.equal(viaCache.payload.breakdown.structure.frontmatter, QUALITY_EXPECTED_FRONTMATTER);
    assert.deepEqual(viaCache.payload.breakdown.structure.headingCounts, QUALITY_EXPECTED_HEADINGS);
    assert.ok(typeof viaCache.payload.score === 'number' && viaCache.payload.score >= 0 && viaCache.payload.score <= 100);
    assert.ok(Array.isArray(viaCache.payload.suggestions));
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[QUALITY_ABS, QUALITY_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke(QUALITY_REL, { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');

    const second = await invoke(QUALITY_REL, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has(key('filequality:test-user:' + QUALITY_REL)), 'cache key is scoped by workspace, user, and path');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[QUALITY_ABS, QUALITY_SAMPLE], [QUALITY_ABS_2, QUALITY_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke(QUALITY_REL, { fs, cached });
    const b = await invoke(QUALITY_REL_2, { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has(key('filequality:test-user:' + QUALITY_REL)));
    assert.ok(store.has(key('filequality:test-user:' + QUALITY_REL_2)));
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.equal(a.payload.breakdown.words.wordCount, QUALITY_EXPECTED_WORDS);
    assert.equal(b.payload.breakdown.words.wordCount, QUALITY_EXPECTED_WORDS_2);
    assert.notEqual(a.payload.breakdown.words.wordCount, b.payload.breakdown.words.wordCount);
    assert.equal(a.payload.path, QUALITY_REL);
    assert.equal(b.payload.path, QUALITY_REL_2);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the filequality: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[QUALITY_ABS, QUALITY_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke(QUALITY_REL, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, key('filequality:test-user:' + QUALITY_REL));
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
    // Empty fs: the readFileSync inside fn() throws ENOENT; the real server/index.js
    // cached() runs fn() before it stores, so the throw leaves nothing cached and
    // the outer catch returns the 404 envelope.
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke(QUALITY_REL, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});
