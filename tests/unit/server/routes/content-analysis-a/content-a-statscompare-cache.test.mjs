import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the sibling per-key cache
// suites do (next-content-a-readingpath-cache, next-wordfreq-cache) and reuse
// their ctx-mocking shape. GET /api/stats/compare now wraps its two-directory
// recursive scan and assembled comparison in
// cached('statscompare:' + dir1 + ':' + dir2, 30000, fn); these tests drive that
// wrap directly with a counting fs and a memoizing cached, no network and no
// server.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`, counting how
// often the recursive scan touches disk. The handler walks each directory with
// readdirSync({withFileTypes}) and reads every candidate with readFileSync; the
// counters let a test prove a cache hit performs no fresh reads while a distinct
// dir pair re-walks. A nested file (content/docs/sub/deep.md) forces the recursion
// so the cached scan provably covers the whole tree.
function makeCountingFs(fileMap) {
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

// Invoke the stats/compare handler with a mocked ctx and capture the response
// handed to `json(res, status, payload)`. Fully in-process: no network, no server
// is started.
async function invoke({ search = '', ctx = {} }) {
  const pathname = '/api/stats/compare';
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

// Two directories with predictable word/heading counts. deep.md lives under
// content/docs/sub so the scan must recurse to read it, proving the recursive walk
// is inside the cached closure. Frontmatter is intentionally omitted: the handler
// does not strip it, so the counts here are the literal whitespace-token and
// heading-line counts of each file.
const FIXTURE = {
  'content/docs/intro.md': '# Intro\nalpha beta gamma\n',
  'content/docs/sub/deep.md': '## Deep\ndelta\n',
  'content/blog/post.md': '# Post\n## Sub\nepsilon zeta eta\n',
};

// The proven pre-cache output for dir1=content/docs, dir2=content/blog. Field order
// matches the handler's returned literals — each dirStats
// ({directory, files, words, headings, avgWordsPerFile}) and the top-level
// ({dir1, dir2, comparison}) — so the JSON.stringify comparison pins serialization,
// not just structural equality. docs: 2 files, 8 words, 2 headings, avg 4; blog:
// 1 file, 7 words, 2 headings, avg 7.
const EXPECTED_DOCS_BLOG = {
  dir1: { directory: 'content/docs', files: 2, words: 8, headings: 2, avgWordsPerFile: 4 },
  dir2: { directory: 'content/blog', files: 1, words: 7, headings: 2, avgWordsPerFile: 7 },
  comparison: { fileDiff: 1, wordDiff: 1, avgWordsDiff: -3 },
};

// The swapped pair dir1=content/blog, dir2=content/docs: a distinct payload AND a
// distinct key, proving the (dir1, dir2) order is part of the cache key.
const EXPECTED_BLOG_DOCS = {
  dir1: { directory: 'content/blog', files: 1, words: 7, headings: 2, avgWordsPerFile: 7 },
  dir2: { directory: 'content/docs', files: 2, words: 8, headings: 2, avgWordsPerFile: 4 },
  comparison: { fileDiff: -1, wordDiff: -1, avgWordsDiff: 3 },
};

describe('GET /api/stats/compare (two-dir scan cached via cached("statscompare:" + dir1 + ":" + dir2))', () => {
  it('returns the expected payload, byte-identical, on the first call and walks the fs', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidDir: () => true, cached };

    const res = await invoke({ search: '?dir1=content/docs&dir2=content/blog', ctx });
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_DOCS_BLOG);
    // Byte-identity: same fields, same order, same serialization as before caching.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_DOCS_BLOG));
    assert.ok(counts.readdirSync > 0, 'the first call walks the directories');
    assert.ok(counts.readFileSync > 0, 'the first call reads files');
  });

  it('serves a repeat request for the same dir pair from cache with no repeat scan', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidDir: () => true, cached };

    const first = await invoke({ search: '?dir1=content/docs&dir2=content/blog', ctx });
    const dirAfterFirst = counts.readdirSync;
    const fileAfterFirst = counts.readFileSync;
    assert.equal(first.status, 200);
    assert.ok(dirAfterFirst > 0 && fileAfterFirst > 0, 'the first call hits the filesystem');

    const second = await invoke({ search: '?dir1=content/docs&dir2=content/blog', ctx });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readdirSync, dirAfterFirst, 'cached repeat must not readdirSync again');
    assert.equal(counts.readFileSync, fileAfterFirst, 'cached repeat must not readFileSync again');
    assert.equal(store.size, 1, 'one cache entry for the single dir pair');
    assert.ok(store.has('statscompare:content/docs:content/blog'), 'cache key is "statscompare:" + dir1 + ":" + dir2');
  });

  it('keys each distinct dir pair separately and re-scans for a new pair', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidDir: () => true, cached };

    const docsBlog = await invoke({ search: '?dir1=content/docs&dir2=content/blog', ctx });
    assert.equal(docsBlog.status, 200);
    assert.deepEqual(docsBlog.payload, EXPECTED_DOCS_BLOG);
    const dirAfterFirst = counts.readdirSync;

    const blogDocs = await invoke({ search: '?dir1=content/blog&dir2=content/docs', ctx });
    assert.equal(blogDocs.status, 200);
    assert.deepEqual(blogDocs.payload, EXPECTED_BLOG_DOCS);
    assert.notDeepEqual(blogDocs.payload, docsBlog.payload);
    assert.ok(counts.readdirSync > dirAfterFirst, 'a new pair misses the cache and re-scans');
    assert.equal(store.size, 2, 'each dir pair gets its own cache entry');
    assert.ok(store.has('statscompare:content/docs:content/blog') && store.has('statscompare:content/blog:content/docs'));
  });

  it('pins the cache key (dir1 and dir2) and the 30000 ms TTL the handler passes', async () => {
    const { fs } = makeCountingFs(FIXTURE);
    const { cached, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidDir: () => true, cached };

    await invoke({ search: '?dir1=content/docs&dir2=content/blog', ctx });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'statscompare:content/docs:content/blog');
    assert.equal(calls[0].ttl, 30000);
  });

  it('returns 400 for an invalid directory before the cache and never scans', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidDir: () => false, cached };

    const res = await invoke({ search: '?dir1=../secret&dir2=content/blog', ctx });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Invalid directories' });
    assert.equal(calls.length, 0, 'the invalid-directory guard returns before cached() is reached');
    assert.equal(store.size, 0, 'the 400 path is never cached');
    assert.equal(counts.readdirSync, 0, 'no scan on an invalid directory');
    assert.equal(counts.readFileSync, 0, 'no reads on an invalid directory');
  });

  it('does not cache a 500 when the scan fails (the error path stays outside the cache)', async () => {
    // The target directories are absent from this fixture, so dirStats's first
    // readdirSync throws ENOENT inside fn(). The try/catch sits OUTSIDE the cached
    // closure, and the real server/index.js cached() runs fn() before it stores, so the
    // throw leaves nothing cached. This pins the error-stays-uncached invariant.
    const { fs, counts } = makeCountingFs({ 'other/x.md': '# X\nno target dirs here\n' });
    const { cached, store, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidDir: () => true, cached };

    const res = await invoke({ search: '?dir1=content/docs&dir2=content/blog', ctx });
    assert.equal(res.status, 500);
    assert.deepEqual(res.payload, { error: 'Comparison failed' });
    assert.ok(calls.length >= 1, 'the handler reaches cached() since both dirs passed isValidDir');
    assert.equal(store.size, 0, 'the 500 is never cached');
    assert.equal(counts.readFileSync, 0, 'no file is read once the directory readdir throws');
  });
});
