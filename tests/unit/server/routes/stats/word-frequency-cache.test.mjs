import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/stats.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub that also counts how often the recursive scan touches disk.
// The word-frequency handler reads directories with readdirSync({withFileTypes})
// and files with readFileSync; the counters let each test assert that a cache hit
// performs no fresh reads while a distinct dir does.
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

// Memoizing cached(key, ttl, fn) matching server-utils makeCache semantics for the
// purposes of this test: the first call per key runs fn and stores the result; later
// calls for the same key return that stored object without re-running fn. Distinct
// keys are independent entries.
function makeCached() {
  const store = new Map();
  return (key, _ttlMs, fn) => {
    if (store.has(key)) return store.get(key);
    const data = fn();
    store.set(key, data);
    return data;
  };
}

// Invoke a content-analysis-a route handler with a mocked ctx and capture the
// response handed to `json(res, status, payload)`.
async function invoke({ pathname, search = '', ctx = {} }) {
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

// Two sibling directories on one fs. `content/` has a nested file so the scan
// recurses; word counts are made distinct so the sorted table order is unambiguous
// and the payload assertion is exact rather than traversal-order dependent.
const FILES = {
  'content/a.md': 'machine machine machine learning learning',
  'content/sub/b.md': 'networks',
  'reports/c.md': 'algorithms algorithms structures',
};

describe('GET /api/stats/word-frequency (cached per dir)', () => {
  it('returns the frequency table and serves a repeat call for the same dir from cache', async () => {
    const { fs, counts } = makeCountingFs(FILES);
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidDir: () => true, cached: makeCached() };

    const first = await invoke({ pathname: '/api/stats/word-frequency', search: '?dir=content', ctx });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, {
      directory: 'content',
      words: [
        { word: 'machine', count: 3 },
        { word: 'learning', count: 2 },
        { word: 'networks', count: 1 },
      ],
      totalUniqueWords: 3,
    });
    assert.ok(counts.readdirSync > 0 && counts.readFileSync > 0, 'first call walks the fs');
    const afterFirst = { ...counts };

    const second = await invoke({ pathname: '/api/stats/word-frequency', search: '?dir=content', ctx });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(counts.readdirSync, afterFirst.readdirSync, 'cache hit performs no extra readdirSync');
    assert.equal(counts.readFileSync, afterFirst.readFileSync, 'cache hit performs no extra readFileSync');
  });

  it('treats a different dir as a distinct cache entry that re-scans', async () => {
    const { fs, counts } = makeCountingFs(FILES);
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidDir: () => true, cached: makeCached() };

    const content = await invoke({ pathname: '/api/stats/word-frequency', search: '?dir=content', ctx });
    assert.equal(content.status, 200);
    const afterContent = { ...counts };

    const reports = await invoke({ pathname: '/api/stats/word-frequency', search: '?dir=reports', ctx });
    assert.equal(reports.status, 200);
    assert.equal(reports.payload.directory, 'reports');
    assert.deepEqual(reports.payload, {
      directory: 'reports',
      words: [
        { word: 'algorithms', count: 2 },
        { word: 'structures', count: 1 },
      ],
      totalUniqueWords: 2,
    });
    assert.notDeepEqual(reports.payload, content.payload);
    assert.ok(counts.readdirSync > afterContent.readdirSync, 'distinct dir triggers a fresh readdirSync');
    assert.ok(counts.readFileSync > afterContent.readFileSync, 'distinct dir triggers a fresh readFileSync');
  });

  it('rejects an invalid directory with 400 before any scan', async () => {
    const { fs, counts } = makeCountingFs(FILES);
    const ctx = { fs, path, PROJECT_ROOT, ALLOWED_EXTS, isValidDir: () => false, cached: makeCached() };

    const r = await invoke({ pathname: '/api/stats/word-frequency', search: '?dir=../etc', ctx });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid directory' });
    assert.equal(counts.readdirSync, 0, 'the 400 path never calls readdirSync');
    assert.equal(counts.readFileSync, 0, 'the 400 path never calls readFileSync');
  });
});
