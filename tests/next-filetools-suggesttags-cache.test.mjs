import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it via createRequire the way the sibling per-file
// cache suites do (next-filetools-microcache.test.mjs, next-filedeps-cache.test.mjs) and
// reuse their ctx-mocking shape. GET /api/file/suggest-tags now wraps its whole
// computation in cached('suggesttags:' + filePath, 30000, fn): the per-file read, the
// frequency-map build, and the suggestion fold over the corpus tag set. These tests drive
// the wrap directly with a counting fs and a memoizing cached, no network and no server.
//
// Unlike summary/outline/lint, this handler ALSO calls cached('all-tags-set', 30000, fn)
// for the corpus scan, so a run leaves two store entries (suggesttags:<path> plus the
// shared all-tags-set). The assertions below pin the suggesttags: entry by key rather than
// asserting on the raw store size.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from a `${rel-from-PROJECT_ROOT}: content` map. The handler
// touches readFileSync (the source file, then each corpus file during the all-tags-set
// scan) and readdirSync (the recursive content walk with {withFileTypes:true}); both are
// counted so a test can prove a cache hit performs no fresh read. A missing path throws
// ENOENT exactly like the real fs, so the closure throws and the outer catch returns 404.
function makeCountingFs(fileMap) {
  const dirs = new Map();         // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
  const counts = { readFileSync: 0, readdirSync: 0 };
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

  const fs = {
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
  return { fs, counts };
}

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js helper:
// run fn and store on a miss, return the stored value untouched on a hit; fn() throwing
// stores nothing, so an error response stays uncached. Every call is recorded in `calls`
// so a test can pin the exact key and TTL the handler passes.
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

// Invoke the GET /api/file/suggest-tags handler with a mocked ctx and capture the response
// handed to json(res, status, payload). isValidFilePath defaults to accepting the path so
// the happy path reaches the file read; pass a rejecting validator to exercise the 400
// guard.
async function invoke(filePath, { fs, cached, isValidFilePath = () => true }) {
  const pathname = '/api/file/suggest-tags';
  const url = new URL(`http://localhost${pathname}?path=${encodeURIComponent(filePath)}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    isValidFilePath,
    cached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// ── fixtures ──

// Frontmatter tags drive the suggestions; the body repeats three content words at
// distinct counts (neural×3, networks×2, machine×1) and seeds two stop words ("should",
// "other") that must be dropped. With only this file in content/ the corpus tag set is
// {neural, networks}, so both tags clear the freq >= 2 bar and yield stable confidences.
const SRC_REL = 'content/source.md';
const SRC_ABS = path.join(PROJECT_ROOT, SRC_REL);
const SRC = '---\ntitle: Source\ntags: [neural, networks]\n---\nneural neural neural networks networks machine should should other other other\n';
const SRC_EXPECTED = {
  suggestions: [
    { tag: 'neural', confidence: 0.6 },
    { tag: 'networks', confidence: 0.4 },
  ],
  topKeywords: ['neural', 'networks', 'machine'],
};

// A second file with distinct tags and body, a provably different payload and therefore a
// distinct suggesttags: cache entry. python×3, coding×2, script×1; "should"/"other" drop.
const OTHER_REL = 'content/other.md';
const OTHER = '---\ntitle: Other\ntags: [python, coding]\n---\npython python python coding coding script should should other other other\n';
const OTHER_EXPECTED = {
  suggestions: [
    { tag: 'python', confidence: 0.6 },
    { tag: 'coding', confidence: 0.4 },
  ],
  topKeywords: ['python', 'coding', 'script'],
};

describe('GET /api/file/suggest-tags (cached("suggesttags:" + path, 30000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    // The memoizing run (first call computes via fn) and the pass-through run (fn inline,
    // the exact pre-cache path) must serialize identically.
    const viaCache = await invoke(SRC_REL, { ...makeCountingFs({ [SRC_REL]: SRC }), ...makeCached() });
    const viaPre = await invoke(SRC_REL, { ...makeCountingFs({ [SRC_REL]: SRC }), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.deepEqual(viaCache.payload, SRC_EXPECTED);
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs({ [SRC_REL]: SRC });
    const { cached, store } = makeCached();

    const first = await invoke(SRC_REL, { fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, SRC_EXPECTED);
    // One source read plus one corpus-scan read of that same single content file.
    const afterFirst = counts.readFileSync;
    assert.equal(afterFirst, 2, 'the first call reads the source and scans the corpus once');

    const second = await invoke(SRC_REL, { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, afterFirst, 'cached repeat must not read any file again');
    assert.ok(store.has('suggesttags:' + SRC_REL), 'cache key is suggesttags:<path>');
    // The corpus scan keeps its own shared entry, so the store also holds all-tags-set.
    assert.equal([...store.keys()].filter(k => k.startsWith('suggesttags:')).length, 1, 'one suggesttags entry for the per-path key');
  });

  it('keys the cache per path so distinct paths get distinct entries', async () => {
    // Both files live in content/, so the shared all-tags-set spans {neural, networks,
    // python, coding}; each file only matches its own frequency map, giving two payloads.
    const { fs } = makeCountingFs({ [SRC_REL]: SRC, [OTHER_REL]: OTHER });
    const { cached, store } = makeCached();

    const a = await invoke(SRC_REL, { fs, cached });
    const b = await invoke(OTHER_REL, { fs, cached });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(a.payload, SRC_EXPECTED);
    assert.deepEqual(b.payload, OTHER_EXPECTED);
    // Distinct content, so the per-path entries are not cross-contaminated.
    assert.notDeepEqual(a.payload, b.payload);
    const suggestKeys = [...store.keys()].filter(k => k.startsWith('suggesttags:'));
    assert.equal(suggestKeys.length, 2, 'two paths produce two suggesttags cache entries');
    assert.ok(store.has('suggesttags:' + SRC_REL));
    assert.ok(store.has('suggesttags:' + OTHER_REL));
    assert.ok(store.has('all-tags-set'), 'the corpus tag scan keeps its own shared cache entry');
  });

  it('pins the suggesttags: key prefix and the 30000 ms TTL', async () => {
    const { fs } = makeCountingFs({ [SRC_REL]: SRC });
    const { cached, calls } = makeCached();
    await invoke(SRC_REL, { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    // The outer payload cache is entered before the inner all-tags-set cache.
    assert.equal(calls[0].key, 'suggesttags:' + SRC_REL);
    assert.equal(calls[0].ttl, 30000);
  });

  it('rejects an invalid path with 400 before cached() and caches nothing', async () => {
    const { fs, counts } = makeCountingFs({});
    const { cached, store, calls } = makeCached();
    const r = await invoke('../etc/passwd', { fs, cached, isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
    assert.equal(calls.length, 0, 'the 400 guard returns before cached() is called');
    assert.equal(counts.readFileSync, 0, 'no file is read on the rejected path');
    assert.equal(store.size, 0, 'nothing is cached for an invalid path');
  });

  it('does not cache a 404 when the file cannot be read (read stays inside the closure)', async () => {
    // Empty fs: the source readFileSync inside fn() throws ENOENT; the memoizing cached()
    // runs fn() before it stores, so the throw leaves nothing cached and the outer catch
    // returns the 404 envelope. The throw is at the first line, so the inner all-tags-set
    // cache is never reached either.
    const { fs, counts } = makeCountingFs({});
    const { cached, store, calls } = makeCached();
    const r = await invoke(SRC_REL, { fs, cached });
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(calls[0].key, 'suggesttags:' + SRC_REL);
    assert.equal(counts.readFileSync, 1, 'only the source read is attempted before the throw');
    assert.equal(store.size, 0, 'the 404 is never cached');
  });
});
