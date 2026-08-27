import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it via createRequire the way the sibling
// per-file cache suite does (next-content-b-filemicro-cache.test.mjs) and reuse its
// ctx-mocking shape. GET /api/file/accessibility now wraps its whole computation in
// cached('accessibility:' + filePath, 30000, fn), GET /api/file/jsonld in
// cached('jsonld:' + filePath, 30000, fn), and GET /api/file/quality-score in
// cached('qualityscore:' + filePath, 30000, fn); these tests drive all three wraps
// directly with a counting fs and a memoizing cached, no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

const PROJECT_ROOT = '/proj';

// A fixed mtime so the jsonld payload (which reads stat.mtime, exactly like the
// blessed fileinfo: cache) is deterministic across the cache and pass-through runs.
const FIXED_MTIME = new Date('2024-02-20T12:00:00.000Z');

// In-memory fs stub that returns a single file's content keyed by absolute path and
// counts how often each handler touches disk. accessibility and quality-score read
// exactly one file; jsonld also stats it. The stub therefore answers readFileSync
// and statSync, both keyed off the same map so a missing path throws ENOENT from
// either. The counters let a test prove a cache hit performs no fresh read or stat
// while the first call provably hits disk.
function makeCountingFs(absFileMap, { mtime = FIXED_MTIME } = {}) {
  const counts = { readFileSync: 0, statSync: 0 };
  const fs = {
    readFileSync(fp) {
      counts.readFileSync++;
      if (absFileMap.has(fp)) return absFileMap.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
    statSync(fp) {
      counts.statSync++;
      if (absFileMap.has(fp)) return { mtime };
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
// json(res, status, payload). isValidFilePath defaults to accepting the path so the
// happy path reaches the file read; pass a rejecting validator to exercise the 400
// guard.
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

// ── accessibility fixture ──

const A11Y_REL = 'content/a11y-sample.md';
const A11Y_ABS = path.join(PROJECT_ROOT, A11Y_REL);

// One alt-less image (![](...) matches ACCESS_IMG_NOALT_RE) yields one warning, and
// the h1 then h3 jump (skipping h2) yields one info issue, so issueCount = 2 and
// score = 100 - 1*10 - 1*3 = 87. These two easily-counted fields anchor the
// byte-identity comparison.
const A11Y_SAMPLE = `# Title

![](pic.png)

### Subsection

Body text.
`;
const A11Y_EXPECTED_SCORE = 87;
const A11Y_EXPECTED_ISSUE_COUNT = 2;

// A second, clean file (well-nested headings, no alt-less image) so the per-path
// cache keys are provably independent: no issues, score 100.
const A11Y_REL_2 = 'content/a11y-clean.md';
const A11Y_ABS_2 = path.join(PROJECT_ROOT, A11Y_REL_2);
const A11Y_SAMPLE_2 = `# Clean

## Section

All good here.
`;

// ── jsonld fixture ──

const JSONLD_REL = 'content/jsonld-sample.md';
const JSONLD_ABS = path.join(PROJECT_ROOT, JSONLD_REL);

// Frontmatter supplies title/date/description/tags/authors; the date override makes
// datePublished deterministic and stat.mtime makes dateModified deterministic. These
// three fields anchor the byte-identity comparison.
const JSONLD_SAMPLE = `---
title: My Article
date: 2023-05-01
description: A short description
tags: [alpha, beta]
authors: [Jane Doe, John Smith]
---

Body with several words here.
`;
const JSONLD_EXPECTED_HEADLINE = 'My Article';
const JSONLD_EXPECTED_DATE_PUBLISHED = '2023-05-01T00:00:00Z';
const JSONLD_EXPECTED_DATE_MODIFIED = FIXED_MTIME.toISOString();

// A second file with no frontmatter so the headline falls back to the basename, a
// provably different payload and therefore a distinct cache entry.
const JSONLD_REL_2 = 'content/jsonld-other.md';
const JSONLD_ABS_2 = path.join(PROJECT_ROOT, JSONLD_REL_2);
const JSONLD_SAMPLE_2 = `Plain body without frontmatter.
`;

// ── quality-score fixture ──

const QS_REL = 'content/quality-sample.md';
const QS_ABS = path.join(PROJECT_ROOT, QS_REL);

// All four frontmatter keys present give breakdown.frontmatter = 5 + 3 + 3 + 4 = 15,
// the easiest stable anchor for the byte-identity comparison.
const QS_SAMPLE = `---
title: Quality Doc
date: 2023-01-01
tags: [x]
description: Desc here
---

# Heading

Some body content with a few words.
`;
const QS_EXPECTED_FRONTMATTER = 15;

// A second, minimal file (no frontmatter, one word) scores 0 / level "minimal", a
// provably different payload and therefore a distinct cache entry.
const QS_REL_2 = 'content/quality-tiny.md';
const QS_ABS_2 = path.join(PROJECT_ROOT, QS_REL_2);
const QS_SAMPLE_2 = `Tiny.
`;

describe('GET /api/file/accessibility (cached("accessibility:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    // The memoizing run (first call computes via fn) and the pass-through run (fn
    // inline, the exact pre-cache path) must serialize identically.
    const viaCache = await invoke('/api/file/accessibility', A11Y_REL, { ...makeCountingFs(new Map([[A11Y_ABS, A11Y_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke('/api/file/accessibility', A11Y_REL, { ...makeCountingFs(new Map([[A11Y_ABS, A11Y_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.equal(viaCache.payload.score, A11Y_EXPECTED_SCORE);
    assert.equal(viaCache.payload.issueCount, A11Y_EXPECTED_ISSUE_COUNT);
    assert.equal(viaCache.payload.path, A11Y_REL);
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[A11Y_ABS, A11Y_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke('/api/file/accessibility', A11Y_REL, { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');

    const second = await invoke('/api/file/accessibility', A11Y_REL, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has('accessibility:' + A11Y_REL), 'cache key is accessibility:<path>');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[A11Y_ABS, A11Y_SAMPLE], [A11Y_ABS_2, A11Y_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke('/api/file/accessibility', A11Y_REL, { fs, cached });
    const b = await invoke('/api/file/accessibility', A11Y_REL_2, { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has('accessibility:' + A11Y_REL));
    assert.ok(store.has('accessibility:' + A11Y_REL_2));
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.notEqual(a.payload.score, b.payload.score);
    assert.equal(a.payload.path, A11Y_REL);
    assert.equal(b.payload.path, A11Y_REL_2);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the accessibility: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[A11Y_ABS, A11Y_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke('/api/file/accessibility', A11Y_REL, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'accessibility:' + A11Y_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/accessibility', '../etc/passwd', { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when the file cannot be read (read stays inside the closure)', async () => {
    // Empty fs: the readFileSync inside fn() throws ENOENT; the real server/index.js
    // cached() runs fn() before it stores, so the throw leaves nothing cached and the
    // outer catch returns the 404 envelope.
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/accessibility', A11Y_REL, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});

describe('GET /api/file/jsonld (cached("jsonld:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    const viaCache = await invoke('/api/file/jsonld', JSONLD_REL, { ...makeCountingFs(new Map([[JSONLD_ABS, JSONLD_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke('/api/file/jsonld', JSONLD_REL, { ...makeCountingFs(new Map([[JSONLD_ABS, JSONLD_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.equal(viaCache.payload.headline, JSONLD_EXPECTED_HEADLINE);
    assert.equal(viaCache.payload.datePublished, JSONLD_EXPECTED_DATE_PUBLISHED);
    assert.equal(viaCache.payload.dateModified, JSONLD_EXPECTED_DATE_MODIFIED);
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync or statSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[JSONLD_ABS, JSONLD_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke('/api/file/jsonld', JSONLD_REL, { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');
    assert.equal(counts.statSync, 1, 'the first call stats the file once');

    const second = await invoke('/api/file/jsonld', JSONLD_REL, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(counts.statSync, 1, 'cached repeat must not stat the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has('jsonld:' + JSONLD_REL), 'cache key is jsonld:<path>');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[JSONLD_ABS, JSONLD_SAMPLE], [JSONLD_ABS_2, JSONLD_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke('/api/file/jsonld', JSONLD_REL, { fs, cached });
    const b = await invoke('/api/file/jsonld', JSONLD_REL_2, { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has('jsonld:' + JSONLD_REL));
    assert.ok(store.has('jsonld:' + JSONLD_REL_2));
    // Distinct content, so the per-path entries are not cross-contaminated: the
    // frontmatter file keeps its title, the bare file falls back to its basename.
    assert.equal(a.payload.headline, JSONLD_EXPECTED_HEADLINE);
    assert.equal(b.payload.headline, 'jsonld-other');
    assert.notEqual(a.payload.headline, b.payload.headline);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the jsonld: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[JSONLD_ABS, JSONLD_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke('/api/file/jsonld', JSONLD_REL, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'jsonld:' + JSONLD_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/jsonld', '../etc/passwd', { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when the file cannot be read (read stays inside the closure)', async () => {
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/jsonld', JSONLD_REL, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});

describe('GET /api/file/quality-score (cached("qualityscore:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    const viaCache = await invoke('/api/file/quality-score', QS_REL, { ...makeCountingFs(new Map([[QS_ABS, QS_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke('/api/file/quality-score', QS_REL, { ...makeCountingFs(new Map([[QS_ABS, QS_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.equal(viaCache.payload.breakdown.frontmatter, QS_EXPECTED_FRONTMATTER);
    assert.equal(viaCache.payload.path, QS_REL);
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[QS_ABS, QS_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke('/api/file/quality-score', QS_REL, { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');

    const second = await invoke('/api/file/quality-score', QS_REL, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has('qualityscore:' + QS_REL), 'cache key is qualityscore:<path>');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[QS_ABS, QS_SAMPLE], [QS_ABS_2, QS_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke('/api/file/quality-score', QS_REL, { fs, cached });
    const b = await invoke('/api/file/quality-score', QS_REL_2, { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has('qualityscore:' + QS_REL));
    assert.ok(store.has('qualityscore:' + QS_REL_2));
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.notEqual(a.payload.score, b.payload.score);
    assert.equal(a.payload.path, QS_REL);
    assert.equal(b.payload.path, QS_REL_2);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the qualityscore: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[QS_ABS, QS_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke('/api/file/quality-score', QS_REL, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'qualityscore:' + QS_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/quality-score', '../etc/passwd', { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when the file cannot be read (read stays inside the closure)', async () => {
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/quality-score', QS_REL, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});
