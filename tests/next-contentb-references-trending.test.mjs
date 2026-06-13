import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS, so load the REAL module via createRequire (the same
// shape the sibling next-contentb-calendar-audience-coverage.test.mjs uses) and drive its
// GET /api/references/trending handler over a fully mocked ctx.
//
// This is an ADD-ONLY characterization test. It pins the CURRENT, correct behavior of
// GET /api/references/trending, which had no direct coverage before this file. The
// handler wraps a content/ tree walk in cached('ref-trending', 60000, fn): it loads
// bibliography/references.yaml, counts EVERY [@key] citation across the tree (no per-file
// dedup, unlike the Set-deduping content-coverage in the same module), then keeps the
// papers whose year falls within the last two years AND that carry at least one citation,
// sorted by citation count descending and capped at 20, returned as {trending, total}.
// Reads happen only through ctx.fs, with a try/catch that returns a 500 on a throwing fs.
// The handler reads no randomness or network. Its one wall-clock read is the current year
// inside the closure, which is NOT injectable, so each fixture derives its years from the
// same runtime year the handler observes (the global Date is left untouched), pinning the
// window edge regardless of the real calendar year. No source file is touched.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/virtual-root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// The handler reads the current year through the global clock inside its cache closure;
// that read is not injectable, so every fixture below derives its years from the same
// value the handler will observe. Captured once at load (the process cannot cross a year
// boundary within a single test run), it keeps the window edge (currentYear - 2) pinned
// no matter the real calendar year.
const CURRENT_YEAR = new Date().getFullYear();

// In-memory fs stub built from a flat `${rel-from-PROJECT_ROOT}: content` map. It
// synthesizes the directory tree so readdirSync(dir, {withFileTypes:true}) returns
// Dirent-like entries (name + isDirectory()) and readFileSync serves the fixture.
// readdirSync of a directory that was never declared throws ENOENT (this is how the
// handler's outer catch is reached when content/ is absent). Listing order is the
// declaration order; every assertion below is either order independent (aggregate counts)
// or re-sorted by the handler, so the tests do not depend on a platform fs ordering. The
// trending handler never stats, so statSync is an inert stub.
function makeFs(fileMap) {
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

  return {
    readdirSync(dir) {
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
    statSync() { return {}; },
  };
}

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js helper:
// run fn and store on a miss, return the stored value on a hit, store nothing when fn
// throws (so a 500 stays uncached). Every call records its key and ttl so a test can pin
// the exact arguments the handler passes.
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

// Build a fresh ctx bundle for one fixture: the in-memory fs plus a memoizing cached and
// its observable store/calls. A fresh cached per it() keeps each fixture's cache isolated.
function harness(fileMap) {
  const fs = makeFs(fileMap);
  const { cached, store, calls } = makeCached();
  return { fs, cached, store, calls };
}

// A harness whose fs throws on every access, driving the handler's outer catch. The cached
// store stays observable so a test can prove a thrown scan caches nothing. For trending the
// first fs touch is the references.yaml read, so readFileSync throwing is enough to reach
// the 500.
function throwingHarness() {
  const { cached, store, calls } = makeCached();
  const fs = {
    readdirSync() { throw new Error('disk failure'); },
    readFileSync() { throw new Error('disk failure'); },
    statSync() { throw new Error('disk failure'); },
  };
  return { fs, cached, store, calls };
}

// Invoke a GET handler with a mocked ctx and capture the response handed to
// json(res, status, payload).
async function invoke(pathname, { fs, cached }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    cached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// Build a references.yaml body from a list of [key, {title, year, venue}] entries, omitting
// the year line when year is undefined so the `entry.year && ...` guard can be exercised.
// js-yaml parses an unquoted `year: 2025` as a number, matching the handler's numeric
// comparison.
function refsYaml(entries) {
  const lines = [];
  for (const [key, e] of entries) {
    lines.push(`${key}:`);
    if (e.title !== undefined) lines.push(`  title: ${e.title}`);
    if (e.year !== undefined) lines.push(`  year: ${e.year}`);
    if (e.venue !== undefined) lines.push(`  venue: ${e.venue}`);
  }
  return lines.join('\n');
}

describe('GET /api/references/trending (cached("ref-trending", 60000))', () => {
  it('returns {trending,total} with recent cited papers sorted by citation count descending', async () => {
    const yaml = refsYaml([
      ['r1', { title: 'Paper One', year: CURRENT_YEAR, venue: 'ICML' }],
      ['r2', { title: 'Paper Two', year: CURRENT_YEAR - 1, venue: 'NeurIPS' }],
      ['r3', { title: 'Paper Three', year: CURRENT_YEAR - 2, venue: 'ICLR' }],
    ]);
    const h = harness({
      'bibliography/references.yaml': yaml,
      'content/a.md': '[@r1] [@r1] [@r3]',
      'content/b.md': '[@r1] [@r2] [@r3]',
    });
    const res = await invoke('/api/references/trending', h);
    assert.equal(res.status, 200);
    // r1 cited 3 (twice in a.md plus once in b.md), r3 cited 2, r2 cited 1; the element
    // shape is exactly {key, title, year, venue, citations} and the array is sorted desc.
    assert.deepEqual(res.payload.trending, [
      { key: 'r1', title: 'Paper One', year: CURRENT_YEAR, venue: 'ICML', citations: 3 },
      { key: 'r3', title: 'Paper Three', year: CURRENT_YEAR - 2, venue: 'ICLR', citations: 2 },
      { key: 'r2', title: 'Paper Two', year: CURRENT_YEAR - 1, venue: 'NeurIPS', citations: 1 },
    ]);
    assert.equal(res.payload.total, 3);
    assert.equal(res.payload.total, res.payload.trending.length);
    assert.deepEqual(Object.keys(res.payload), ['trending', 'total']);
    assert.equal(h.calls[0].key, 'ref-trending');
    assert.equal(h.calls[0].ttl, 60000);
  });

  it('applies the year window: currentYear-2 stays, currentYear-3 and missing/zero-citation drop', async () => {
    const yaml = refsYaml([
      ['current', { title: 'Current', year: CURRENT_YEAR, venue: 'A' }],
      ['boundary', { title: 'Boundary', year: CURRENT_YEAR - 2, venue: 'B' }],
      ['tooOld', { title: 'Too Old', year: CURRENT_YEAR - 3, venue: 'C' }],
      ['zeroCite', { title: 'Zero Cite', year: CURRENT_YEAR, venue: 'D' }],
      ['noYear', { title: 'No Year', venue: 'E' }],
    ]);
    const h = harness({
      'bibliography/references.yaml': yaml,
      // current x2, boundary x1, tooOld x5, noYear x1; zeroCite is never cited.
      'content/cites.md': '[@current] [@current] [@boundary] [@tooOld] [@tooOld] [@tooOld] [@tooOld] [@tooOld] [@noYear]',
    });
    const res = await invoke('/api/references/trending', h);
    assert.equal(res.status, 200);
    const keys = res.payload.trending.map(t => t.key);
    // currentYear and the currentYear-2 boundary are inside the window; currentYear-3 is
    // out even though it is the most cited, the zero-citation recent paper is out, and the
    // paper with no year is out because of the `entry.year && ...` guard.
    assert.deepEqual(keys, ['current', 'boundary']);
    assert.equal(res.payload.total, 2);
    assert.ok(!keys.includes('tooOld'));
    assert.ok(!keys.includes('zeroCite'));
    assert.ok(!keys.includes('noYear'));
    assert.equal(res.payload.trending[0].citations, 2);
    assert.equal(res.payload.trending[1].citations, 1);
  });

  it('counts every occurrence with no per-file dedup, scans underscore files and subdirs, skips dot and wrong-ext', async () => {
    const yaml = refsYaml([
      ['dup', { title: 'Dup', year: CURRENT_YEAR, venue: 'D' }],
      ['under', { title: 'Under', year: CURRENT_YEAR, venue: 'U' }],
      ['deep', { title: 'Deep', year: CURRENT_YEAR, venue: 'P' }],
      ['hidden', { title: 'Hidden', year: CURRENT_YEAR, venue: 'H' }],
      ['wrongext', { title: 'Wrong Ext', year: CURRENT_YEAR, venue: 'W' }],
    ]);
    const h = harness({
      'bibliography/references.yaml': yaml,
      'content/dup.md': 'see [@dup] then [@dup] then [@dup]',
      'content/_under.md': '[@under] and again [@under]',
      'content/sub/deep.md': 'nested [@deep]',
      'content/.hidden.md': '[@hidden]',
      'content/skip.txt': '[@wrongext]',
    });
    const res = await invoke('/api/references/trending', h);
    assert.equal(res.status, 200);
    const byKey = Object.fromEntries(res.payload.trending.map(t => [t.key, t.citations]));
    // No per-file Set dedup: three [@dup] in one file count as 3 (content-coverage in this
    // same module would dedup that to 1). The underscore-prefixed file is scanned (under=2)
    // and the subdirectory is recursed (deep=1).
    assert.equal(byKey.dup, 3);
    assert.equal(byKey.under, 2);
    assert.equal(byKey.deep, 1);
    // The dot-prefixed file and the wrong-extension file are never read, so their keys land
    // at zero citations and drop out entirely.
    assert.ok(!('hidden' in byKey));
    assert.ok(!('wrongext' in byKey));
    assert.deepEqual(res.payload.trending.map(t => t.key), ['dup', 'under', 'deep']);
    assert.equal(res.payload.total, 3);
  });

  it('keeps only the 20 most-cited papers (slice cap) while dropping the rest', async () => {
    // 25 recent papers, paper rNN cited NN times, so the sort is total and the cap is
    // unambiguous: the 20 highest survive and the five least cited (r01..r05) are dropped.
    const entries = [];
    const files = {};
    for (let i = 1; i <= 25; i++) {
      const key = 'r' + String(i).padStart(2, '0');
      entries.push([key, { title: 'Title ' + i, year: CURRENT_YEAR, venue: 'V' }]);
      files['content/' + key + '.md'] = ('[@' + key + '] ').repeat(i);
    }
    const h = harness({ 'bibliography/references.yaml': refsYaml(entries), ...files });
    const res = await invoke('/api/references/trending', h);
    assert.equal(res.status, 200);
    assert.equal(res.payload.trending.length, 20);
    assert.equal(res.payload.total, 20);
    // total reflects the capped array length (20), not the 25 eligible papers, since the
    // handler computes total as trending.length after the slice.
    assert.equal(res.payload.total, res.payload.trending.length);
    assert.deepEqual(res.payload.trending[0], { key: 'r25', title: 'Title 25', year: CURRENT_YEAR, venue: 'V', citations: 25 });
    assert.deepEqual(res.payload.trending[19], { key: 'r06', title: 'Title 6', year: CURRENT_YEAR, venue: 'V', citations: 6 });
    for (let i = 0; i < res.payload.trending.length - 1; i++) {
      assert.ok(res.payload.trending[i].citations > res.payload.trending[i + 1].citations);
    }
    const survived = new Set(res.payload.trending.map(t => t.key));
    for (const dropped of ['r05', 'r04', 'r03', 'r02', 'r01']) assert.ok(!survived.has(dropped));
  });

  it('passes ("ref-trending", 60000) to cached and serves the memoized array without re-walking', async () => {
    const h = harness({
      'bibliography/references.yaml': refsYaml([['solo', { title: 'Solo', year: CURRENT_YEAR, venue: 'S' }]]),
      'content/c.md': '[@solo]',
    });
    const res1 = await invoke('/api/references/trending', h);
    assert.equal(res1.status, 200);
    assert.equal(h.calls[0].key, 'ref-trending');
    assert.equal(h.calls[0].ttl, 60000);
    assert.ok(h.store.has('ref-trending'));
    assert.deepEqual(res1.payload, { trending: [{ key: 'solo', title: 'Solo', year: CURRENT_YEAR, venue: 'S', citations: 1 }], total: 1 });
    // A second call with an fs that throws on any access must still return the cached value,
    // proving the handler served the memoized trending array instead of re-walking the tree.
    const poisoned = {
      fs: {
        readdirSync() { throw new Error('should not walk'); },
        readFileSync() { throw new Error('should not walk'); },
        statSync() { throw new Error('should not walk'); },
      },
      cached: h.cached,
    };
    const res2 = await invoke('/api/references/trending', poisoned);
    assert.deepEqual(res2, res1);
    assert.equal(h.calls.length, 2);
  });

  it('returns 500 {error: "Trending analysis failed"} when the scan throws, caching nothing', async () => {
    const h = throwingHarness();
    const res = await invoke('/api/references/trending', h);
    assert.deepEqual(res, { status: 500, payload: { error: 'Trending analysis failed' } });
    assert.equal(h.store.size, 0);
  });

  it('treats an empty references.yaml as {} and returns an empty trending list cached as []', async () => {
    // yaml.load('') is undefined, which the handler coalesces to {}, so there are no papers
    // to rank. The content scan still runs (content/ exists), so this is a cached 200 with
    // an empty list, NOT the uncached 500 of the throwing case above.
    const h = harness({
      'bibliography/references.yaml': '',
      'content/x.md': 'prose with no citations',
    });
    const res = await invoke('/api/references/trending', h);
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, { trending: [], total: 0 });
    assert.deepEqual(Object.keys(res.payload), ['trending', 'total']);
    assert.ok(h.store.has('ref-trending'));
    assert.deepEqual(h.store.get('ref-trending'), []);
  });
});
