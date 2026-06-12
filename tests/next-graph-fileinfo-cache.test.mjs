import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the sibling per-key cache
// suites do (next-recommendv2-cache) and reuse their ctx-mocking shape. GET
// /api/file/info now wraps its per-path stat, read, and feature detection in
// cached('fileinfo:' + filePath, 30000, fn); these tests drive that wrap directly
// with a counting fs and a memoizing cached, no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/graph-trash-files.js');

const PROJECT_ROOT = '/proj';

// A fixed stored mtime so the payload is deterministic: the handler reports
// stat.mtime.toISOString(), the file's stored mtime rather than wall-clock, so the
// snapshot is byte stable. The stub returns a real Date and the expected payload
// pins its ISO form.
const MTIME_ISO = '2024-01-02T03:04:05.000Z';

// Kitchen-sink fixture exercising every returned field at least once: YAML
// frontmatter with draft:true, three Latin words, a fenced code block, inline
// math, exactly two citations, exactly two images, and CJK text. Built from an
// array join so the exact bytes (and therefore wordCount) are unambiguous.
const DEMO_CONTENT = [
  '---',
  'title: Demo',
  'draft: true',
  '---',
  'alpha beta gamma',
  '```',
  'code',
  '```',
  'math $x+y$ here',
  'cite [@k1] and [@k2]',
  'img ![a](x.png) ![b](y.png)',
  '中文内容',
].join('\n');

// A second, plainer fixture: no frontmatter, no code/math/citations/images, three
// Latin words. Its payload differs from DEMO so a distinct-path test proves each
// path is keyed and computed independently.
const OTHER_CONTENT = 'plain text only';
const OTHER_MTIME_ISO = '2023-05-06T07:08:09.000Z';

// size is a pass-through of stat.size, so the stub uses the real UTF-8 byte length
// (CJK glyphs are three bytes each) and the expected payload references the same
// expression. mtime is a pass-through of stat.mtime.toISOString().
const DEMO_SIZE = Buffer.byteLength(DEMO_CONTENT);
const OTHER_SIZE = Buffer.byteLength(OTHER_CONTENT);

const FIXTURE = {
  'content/demo.md': { content: DEMO_CONTENT, size: DEMO_SIZE, mtime: new Date(MTIME_ISO) },
  'content/other.md': { content: OTHER_CONTENT, size: OTHER_SIZE, mtime: new Date(OTHER_MTIME_ISO) },
};

// The proven pre-cache output for path=content/demo.md. Field order matches the
// handler's returned literal exactly (path, size, mtime, wordCount,
// hasFrontmatter, draft, detectedLanguage, hasCodeBlocks, hasMath, citationCount,
// imageCount), so a JSON.stringify comparison pins serialization, not just
// structural equality. wordCount 23 = the whitespace-split token count of
// DEMO_CONTENT; cjk 4 vs latin 68 puts latinRatio above 0.7 so the language is
// 'english'. Every field here is hand-derived from DEMO_CONTENT, not copied from
// the handler's own output, so it is an independent anchor; edit it in lockstep if
// DEMO_CONTENT ever changes.
const EXPECTED_DEMO = {
  path: 'content/demo.md',
  size: DEMO_SIZE,
  mtime: MTIME_ISO,
  wordCount: 23,
  hasFrontmatter: true,
  draft: true,
  detectedLanguage: 'english',
  hasCodeBlocks: true,
  hasMath: true,
  citationCount: 2,
  imageCount: 2,
};

// path=content/other.md: no frontmatter, three words, no features. A payload
// distinct from EXPECTED_DEMO proves the second path is keyed and scanned on its
// own.
const EXPECTED_OTHER = {
  path: 'content/other.md',
  size: OTHER_SIZE,
  mtime: OTHER_MTIME_ISO,
  wordCount: 3,
  hasFrontmatter: false,
  draft: false,
  detectedLanguage: 'english',
  hasCodeBlocks: false,
  hasMath: false,
  citationCount: 0,
  imageCount: 0,
};

// fs stub over an absolute-path map, counting how often the handler touches disk.
// The /api/file/info handler stat()s then read()s exactly one file, both inside
// the cached closure, so the counters let a test prove a cache hit performs no
// fresh stat or read while a distinct path re-stats and re-reads. A missing path
// throws ENOENT from statSync, mirroring real fs.
function makeCountingFs(fileMap) {
  const byFull = new Map();
  for (const [rel, info] of Object.entries(fileMap)) {
    byFull.set(path.join(PROJECT_ROOT, rel), info);
  }
  const counts = { statSync: 0, readFileSync: 0 };
  const fs = {
    statSync(fp) {
      counts.statSync++;
      const info = byFull.get(fp);
      if (!info) { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; }
      return { size: info.size, mtime: info.mtime };
    },
    readFileSync(fp) {
      counts.readFileSync++;
      const info = byFull.get(fp);
      if (!info) { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; }
      return info.content;
    },
  };
  return { fs, counts };
}

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js
// helper: run fn and store on a miss, return the stored value untouched on a hit;
// fn() throwing stores nothing, so an error response stays uncached. Every call is
// recorded in `calls` so a test can pin the exact key and TTL the handler passes.
// It deliberately omits the server.js time-based expiry: these tests pin the TTL
// only as the value handed to cached() (calls[].ttl), never as observable expiry.
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

// Invoke the file/info handler with a mocked ctx and capture the response handed
// to json(res, status, payload). The handler reads only fs, path, PROJECT_ROOT,
// isValidFilePath, cached, and json from ctx, and reaches its branch directly
// because pathname is /api/file/info.
async function invoke({ search = '', ctx = {} }) {
  const pathname = '/api/file/info';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('GET /api/file/info (scan cached via cached("fileinfo:" + filePath))', () => {
  it('returns the expected payload, byte-identical to the pre-cache computation, and hits the fs', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    // A pass-through cached runs fn() exactly as the handler did before the wrap,
    // so this asserts byte-identity against the pre-cache output.
    const passThrough = (_k, _t, fn) => fn();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => true, cached: passThrough };

    const res = await invoke({ search: '?path=content/demo.md', ctx });
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_DEMO);
    // Byte-identity: same fields, same order, same serialization as before caching.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_DEMO));
    assert.equal(counts.statSync, 1, 'the first call stats the file');
    assert.equal(counts.readFileSync, 1, 'the first call reads the file');
  });

  it('serves a repeat request for the same path from cache with no second stat or read', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => true, cached };

    const first = await invoke({ search: '?path=content/demo.md', ctx });
    assert.equal(first.status, 200);
    assert.equal(counts.statSync, 1, 'the first call stats the file');
    assert.equal(counts.readFileSync, 1, 'the first call reads the file');

    const second = await invoke({ search: '?path=content/demo.md', ctx });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.statSync, 1, 'cached repeat must not statSync again');
    assert.equal(counts.readFileSync, 1, 'cached repeat must not readFileSync again');
    assert.equal(store.size, 1, 'one cache entry for the single path');
    assert.ok(store.has('fileinfo:content/demo.md'), 'cache key is "fileinfo:" + filePath');
  });

  it('keys each distinct path separately and re-scans for a new path', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => true, cached };

    const demo = await invoke({ search: '?path=content/demo.md', ctx });
    assert.equal(demo.status, 200);
    assert.equal(counts.statSync, 1);
    assert.equal(counts.readFileSync, 1);

    const other = await invoke({ search: '?path=content/other.md', ctx });
    assert.equal(other.status, 200);
    assert.deepEqual(other.payload, EXPECTED_OTHER);
    assert.notDeepEqual(other.payload, demo.payload);
    assert.equal(counts.statSync, 2, 'a new path misses the cache and re-stats');
    assert.equal(counts.readFileSync, 2, 'a new path misses the cache and re-reads');
    assert.equal(store.size, 2, 'each path gets its own cache entry');
    assert.ok(store.has('fileinfo:content/demo.md') && store.has('fileinfo:content/other.md'));
  });

  it('pins the cache key prefix and the 30000 ms TTL the handler passes', async () => {
    const { fs } = makeCountingFs(FIXTURE);
    const { cached, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => true, cached };

    await invoke({ search: '?path=content/demo.md', ctx });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'fileinfo:content/demo.md');
    assert.equal(calls[0].ttl, 30000);
  });

  it('returns 400 for an invalid path before the cache and never stats or reads', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => false, cached };

    const res = await invoke({ search: '?path=../secret', ctx });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Invalid path' });
    assert.equal(calls.length, 0, 'the invalid-path guard returns before cached() is reached');
    assert.equal(store.size, 0, 'the 400 path is never cached');
    assert.equal(counts.statSync, 0, 'no stat on an invalid path');
    assert.equal(counts.readFileSync, 0, 'no read on an invalid path');
  });

  it('does not cache a 404 for a missing file (the error path stays outside the cache)', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => true, cached };

    const res = await invoke({ search: '?path=content/missing.md', ctx });
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'File not found' });
    // The try/catch sits OUTSIDE the cached closure, and fs.statSync on the absent
    // file throws inside fn(); the real server.js cached() runs fn() before it
    // stores, so the throw leaves nothing cached. This pins the error-stays-uncached
    // invariant.
    assert.ok(calls.length >= 1, 'the handler reaches cached() since the path passed isValidFilePath');
    assert.equal(store.size, 0, 'the 404 is never cached');
    assert.equal(counts.statSync, 1, 'the stat is attempted once and throws');
    assert.equal(counts.readFileSync, 0, 'the read never runs when the stat fails');
  });
});
