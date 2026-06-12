import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it via createRequire the way the sibling per-file
// cache suites do (next-filedeps-cache.test.mjs, next-content-c-filemicro-cache.test.mjs)
// and reuse their ctx-mocking shape. GET /api/file/summary now wraps its whole
// computation in cached('filesummary:' + filePath, 30000, fn), GET /api/file/outline in
// cached('fileoutline:' + filePath, 30000, fn), and GET /api/file/lint in
// cached('filelint:' + filePath, 30000, fn); these tests drive all three wraps directly
// with a counting fs and a memoizing cached, no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/proj';

// In-memory fs stub that returns a single file's content keyed by absolute path and
// counts how often each handler touches disk. All three handlers read exactly one
// file via readFileSync, so the counter lets a test prove a cache hit performs no
// fresh read while the first call provably hits disk. A missing path throws ENOENT,
// exactly like the real fs, so the closure throws and the outer catch returns 404.
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

// ── summary fixture ──

const SUMMARY_REL = 'content/summary-sample.md';
const SUMMARY_ABS = path.join(PROJECT_ROOT, SUMMARY_REL);

// Frontmatter supplies the title; the two h1/h2 headings anchor the headings array and
// the two long paragraphs feed the summary. title and headings are the easiest stable
// anchors for the byte-identity comparison.
const SUMMARY_SAMPLE = `---
title: Summary Sample
---

# Heading One

This is the first paragraph with enough length to be counted in the summary text.

## Heading Two

A second paragraph that also clears the twenty character minimum length with ease.
`;
const SUMMARY_EXPECTED_TITLE = 'Summary Sample';
const SUMMARY_EXPECTED_HEADINGS = ['Heading One', 'Heading Two'];

// A second file with a distinct title and a single heading, a provably different
// payload and therefore a distinct cache entry.
const SUMMARY_REL_2 = 'content/summary-other.md';
const SUMMARY_ABS_2 = path.join(PROJECT_ROOT, SUMMARY_REL_2);
const SUMMARY_SAMPLE_2 = `---
title: Other Summary
---

# Only Section

A single paragraph here that is definitely longer than twenty characters total.
`;
const SUMMARY_EXPECTED_TITLE_2 = 'Other Summary';

// ── outline fixture ──

const OUTLINE_REL = 'content/outline-sample.md';
const OUTLINE_ABS = path.join(PROJECT_ROOT, OUTLINE_REL);

// Built line by line (single-quoted strings so the code fence can appear literally):
// the fenced block hides a '# not a heading' line, proving the inCode skip survives the
// cache wrap. The three real headings at lines 1, 3, and 9 anchor the byte comparison.
const OUTLINE_SAMPLE = [
  '# Title',          // 1
  '',                 // 2
  '## Section A',     // 3
  '',                 // 4
  '```',              // 5  code fence opens
  '# not a heading',  // 6  inside code, skipped
  '```',              // 7  code fence closes
  '',                 // 8
  '### Subsection',   // 9
  '',                 // 10
].join('\n');
const OUTLINE_EXPECTED_HEADINGS = [
  { level: 1, text: 'Title', line: 1 },
  { level: 2, text: 'Section A', line: 3 },
  { level: 3, text: 'Subsection', line: 9 },
];

// A second file with a single heading, a provably different payload (count 1 vs 3) and
// therefore a distinct cache entry.
const OUTLINE_REL_2 = 'content/outline-other.md';
const OUTLINE_ABS_2 = path.join(PROJECT_ROOT, OUTLINE_REL_2);
const OUTLINE_SAMPLE_2 = [
  '# Lonely',                       // 1
  '',                               // 2
  'Body without further headings.', // 3
].join('\n');

// ── lint fixture ──

const LINT_REL = 'content/lint-sample.md';
const LINT_ABS = path.join(PROJECT_ROOT, LINT_REL);

// Frontmatter with a title (so no missing-frontmatter/title issue) and a single empty
// heading at line 7, yielding exactly one issue. issues and issueCount anchor the
// byte-identity comparison.
const LINT_SAMPLE = [
  '---',                // 1
  'title: Lint Sample', // 2
  '---',                // 3
  '',                   // 4
  '# Good Heading',     // 5
  '',                   // 6
  '#',                  // 7  empty heading
  '',                   // 8
  'Normal paragraph.',  // 9
].join('\n');
const LINT_EXPECTED_ISSUES = [
  { line: 7, severity: 'warning', message: 'Empty heading' },
];

// A second file with no frontmatter and an empty heading, yielding two issues, a
// provably different payload (issueCount 2 vs 1) and therefore a distinct cache entry.
const LINT_REL_2 = 'content/lint-other.md';
const LINT_ABS_2 = path.join(PROJECT_ROOT, LINT_REL_2);
const LINT_SAMPLE_2 = [
  'No frontmatter here.', // 1  missing frontmatter (reported at line 1)
  '',                     // 2
  '##',                   // 3  empty heading
  '',                     // 4
  'Body text.',           // 5
].join('\n');

describe('GET /api/file/summary (cached("filesummary:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    // The memoizing run (first call computes via fn) and the pass-through run (fn
    // inline, the exact pre-cache path) must serialize identically.
    const viaCache = await invoke('/api/file/summary', SUMMARY_REL, { ...makeCountingFs(new Map([[SUMMARY_ABS, SUMMARY_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke('/api/file/summary', SUMMARY_REL, { ...makeCountingFs(new Map([[SUMMARY_ABS, SUMMARY_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.equal(viaCache.payload.title, SUMMARY_EXPECTED_TITLE);
    assert.deepEqual(viaCache.payload.headings, SUMMARY_EXPECTED_HEADINGS);
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[SUMMARY_ABS, SUMMARY_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke('/api/file/summary', SUMMARY_REL, { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');

    const second = await invoke('/api/file/summary', SUMMARY_REL, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has('filesummary:' + SUMMARY_REL), 'cache key is filesummary:<path>');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[SUMMARY_ABS, SUMMARY_SAMPLE], [SUMMARY_ABS_2, SUMMARY_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke('/api/file/summary', SUMMARY_REL, { fs, cached });
    const b = await invoke('/api/file/summary', SUMMARY_REL_2, { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has('filesummary:' + SUMMARY_REL));
    assert.ok(store.has('filesummary:' + SUMMARY_REL_2));
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.equal(a.payload.title, SUMMARY_EXPECTED_TITLE);
    assert.equal(b.payload.title, SUMMARY_EXPECTED_TITLE_2);
    assert.notEqual(a.payload.title, b.payload.title);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the filesummary: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[SUMMARY_ABS, SUMMARY_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke('/api/file/summary', SUMMARY_REL, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'filesummary:' + SUMMARY_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/summary', '../etc/passwd', { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when the file cannot be read (read stays inside the closure)', async () => {
    // Empty fs: the readFileSync inside fn() throws ENOENT; the real server.js cached()
    // runs fn() before it stores, so the throw leaves nothing cached and the outer catch
    // returns the 404 envelope.
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/summary', SUMMARY_REL, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});

describe('GET /api/file/outline (cached("fileoutline:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    const viaCache = await invoke('/api/file/outline', OUTLINE_REL, { ...makeCountingFs(new Map([[OUTLINE_ABS, OUTLINE_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke('/api/file/outline', OUTLINE_REL, { ...makeCountingFs(new Map([[OUTLINE_ABS, OUTLINE_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.deepEqual(viaCache.payload.headings, OUTLINE_EXPECTED_HEADINGS);
    assert.equal(viaCache.payload.count, 3);
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[OUTLINE_ABS, OUTLINE_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke('/api/file/outline', OUTLINE_REL, { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');

    const second = await invoke('/api/file/outline', OUTLINE_REL, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has('fileoutline:' + OUTLINE_REL), 'cache key is fileoutline:<path>');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[OUTLINE_ABS, OUTLINE_SAMPLE], [OUTLINE_ABS_2, OUTLINE_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke('/api/file/outline', OUTLINE_REL, { fs, cached });
    const b = await invoke('/api/file/outline', OUTLINE_REL_2, { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has('fileoutline:' + OUTLINE_REL));
    assert.ok(store.has('fileoutline:' + OUTLINE_REL_2));
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.notEqual(a.payload.count, b.payload.count);
    assert.equal(b.payload.count, 1);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the fileoutline: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[OUTLINE_ABS, OUTLINE_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke('/api/file/outline', OUTLINE_REL, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'fileoutline:' + OUTLINE_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/outline', '../etc/passwd', { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when the file cannot be read (read stays inside the closure)', async () => {
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/outline', OUTLINE_REL, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});

describe('GET /api/file/lint (cached("filelint:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    const viaCache = await invoke('/api/file/lint', LINT_REL, { ...makeCountingFs(new Map([[LINT_ABS, LINT_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke('/api/file/lint', LINT_REL, { ...makeCountingFs(new Map([[LINT_ABS, LINT_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.deepEqual(viaCache.payload.issues, LINT_EXPECTED_ISSUES);
    assert.equal(viaCache.payload.issueCount, 1);
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(new Map([[LINT_ABS, LINT_SAMPLE]]));
    const { cached, store } = makeCached();

    const first = await invoke('/api/file/lint', LINT_REL, { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');

    const second = await invoke('/api/file/lint', LINT_REL, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not read the file again');
    assert.equal(store.size, 1, 'one cache entry for the per-path key');
    assert.ok(store.has('filelint:' + LINT_REL), 'cache key is filelint:<path>');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    const { fs, counts } = makeCountingFs(new Map([[LINT_ABS, LINT_SAMPLE], [LINT_ABS_2, LINT_SAMPLE_2]]));
    const { cached, store } = makeCached();

    const a = await invoke('/api/file/lint', LINT_REL, { fs, cached });
    const b = await invoke('/api/file/lint', LINT_REL_2, { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(store.size, 2, 'two paths produce two cache entries');
    assert.ok(store.has('filelint:' + LINT_REL));
    assert.ok(store.has('filelint:' + LINT_REL_2));
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.notEqual(a.payload.issueCount, b.payload.issueCount);
    assert.equal(b.payload.issueCount, 2);
    assert.equal(counts.readFileSync, 2, 'each distinct path reads its file once');
  });

  it('pins the filelint: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs(new Map([[LINT_ABS, LINT_SAMPLE]]));
    const { cached, calls } = makeCached();
    await invoke('/api/file/lint', LINT_REL, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'filelint:' + LINT_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/lint', '../etc/passwd', { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when the file cannot be read (read stays inside the closure)', async () => {
    const { fs } = makeCountingFs(new Map());
    const { cached, store, calls } = makeCached();
    const r = await invoke('/api/file/lint', LINT_REL, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});
