import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it via createRequire the way the sibling
// per-key cache suite does (next-recommendv2-cache.test.mjs) and reuse its
// ctx-mocking shape. GET /api/references/reading-order now wraps its whole
// computation in cached('reading-order', 60000, fn) and GET
// /api/references/completeness in cached('references-completeness', 60000, fn);
// these tests drive both wraps directly with a counting fs and a memoizing cached,
// no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`, counting how
// often each handler touches disk. reading-order reads bibliography/references.yaml
// (parsed with the real js-yaml) and walks content/ via readdirSync
// ({withFileTypes:true}) + readFileSync; completeness reads only references.yaml.
// The counters let a test prove a cache hit performs no fresh read while the first
// call provably hits disk. `yamlReads` isolates the references.yaml reads that the
// Done-when criterion ("no second references.yaml read") names.
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

  const counts = { readdirSync: 0, readFileSync: 0, yamlReads: 0 };
  const fs = {
    readdirSync(dir) {
      counts.readdirSync++;
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      counts.readFileSync++;
      if (String(fp).endsWith('references.yaml')) counts.yamlReads++;
      if (fileContents.has(fp)) return fileContents.get(fp);
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

// ── reading-order fixture and proven pre-cache output ──

// Four references with strictly increasing years, so the year sort and the
// citation-derived prerequisites are both deterministic. The grouped citations in
// intro.md drive the cross-year prerequisites, so a full content/ walk is needed.
const READING_ORDER_FIXTURE = {
  'bibliography/references.yaml': `alpha:
  title: Alpha Foundations
  year: 2015
  venue: VenueA
bravo:
  title: Bravo Methods
  year: 2018
  venue: VenueB
charlie:
  title: Charlie Systems
  year: 2021
  venue: VenueC
delta:
  title: Delta Survey
  year: 2023
  venue: VenueD
`,
  'content/intro.md': `# Intro

This builds on [@charlie; @alpha] and then on [@delta; @bravo].
`,
  'content/more.md': `# More

Further reading: [@delta; @charlie].
`,
};

// The proven pre-cache output for READING_ORDER_FIXTURE. This is the same reading
// order next-readingorder-hoist-citere.test.mjs asserts the handler returns for the
// same fixture, wrapped in the handler's {readingOrder, totalOrdered} envelope, so
// it pins byte-identity against the pre-cache computation. Field order matches the
// returned literal so a JSON.stringify comparison pins serialization, not just
// structural equality.
const EXPECTED_READING_ORDER = {
  readingOrder: [
    { order: 1, key: 'alpha', title: 'Alpha Foundations', year: 2015, venue: 'VenueA', prerequisites: [] },
    { order: 2, key: 'bravo', title: 'Bravo Methods', year: 2018, venue: 'VenueB', prerequisites: ['alpha'] },
    { order: 3, key: 'charlie', title: 'Charlie Systems', year: 2021, venue: 'VenueC', prerequisites: ['alpha', 'bravo'] },
    { order: 4, key: 'delta', title: 'Delta Survey', year: 2023, venue: 'VenueD', prerequisites: ['charlie', 'alpha', 'bravo'] },
  ],
  totalOrdered: 4,
};

// ── completeness fixture and proven pre-cache output ──

// A mix of fully complete, partial, and empty entries so every field-coverage
// count and percentage is non-trivial. Mirrors completeness-scan.test.mjs.
const COMPLETENESS_FIXTURE = {
  'bibliography/references.yaml': `
a:
  title: "A title"
  author:
    - Alice
  year: 2024
  venue: "NeurIPS"
  doi: "10.1000/a"
  url: "https://example.com/a"
b:
  title: "B title"
  author:
    - Bob
  year: 2021
  venue: "ICML"
c:
  title: "C title"
  year: 2020
d: {}
`,
};

// The proven pre-cache output for COMPLETENESS_FIXTURE, identical to the literal
// completeness-scan.test.mjs pins for the same references, so it anchors
// byte-identity independently of the pass-through run.
const EXPECTED_COMPLETENESS = {
  averageCompleteness: 50,
  totalReferences: 4,
  fullyComplete: 1,
  incomplete: [
    { key: 'd', title: 'd', completeness: 0, missing: ['title', 'author', 'year', 'venue', 'doi', 'url'], presentCount: 0 },
    { key: 'c', title: 'C title', completeness: 33, missing: ['author', 'venue', 'doi', 'url'], presentCount: 2 },
    { key: 'b', title: 'B title', completeness: 67, missing: ['doi', 'url'], presentCount: 4 },
  ],
  fieldCoverage: [
    { field: 'title', count: 3, percentage: 75 },
    { field: 'author', count: 2, percentage: 50 },
    { field: 'year', count: 3, percentage: 75 },
    { field: 'venue', count: 2, percentage: 50 },
    { field: 'doi', count: 1, percentage: 25 },
    { field: 'url', count: 1, percentage: 25 },
  ],
};

describe('GET /api/references/reading-order (cached("reading-order", 60000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    // The memoizing run (first call computes via fn) and the pass-through run
    // (fn inline, the exact pre-cache path) must both serialize to the documented
    // pre-cache output.
    const viaCache = await invoke('/api/references/reading-order', { ...makeCountingFs(READING_ORDER_FIXTURE), ...makeCached() });
    const viaPre = await invoke('/api/references/reading-order', { ...makeCountingFs(READING_ORDER_FIXTURE), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.deepEqual(viaCache.payload, EXPECTED_READING_ORDER);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(EXPECTED_READING_ORDER));
    // Wrapping in cached() changes nothing the pre-cache path produced.
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second references.yaml read or re-walk', async () => {
    const { fs, counts } = makeCountingFs(READING_ORDER_FIXTURE);
    const { cached, store } = makeCached();

    const first = await invoke('/api/references/reading-order', { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.yamlReads, 1, 'the first call reads references.yaml');
    assert.ok(counts.readdirSync > 0, 'the first call walks content/');
    const dirAfterFirst = counts.readdirSync;
    const fileAfterFirst = counts.readFileSync;

    const second = await invoke('/api/references/reading-order', { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.yamlReads, 1, 'cached repeat must not re-read references.yaml');
    assert.equal(counts.readdirSync, dirAfterFirst, 'cached repeat must not re-walk content/');
    assert.equal(counts.readFileSync, fileAfterFirst, 'cached repeat must not read any file again');
    assert.equal(store.size, 1, 'one cache entry for the param-free key');
    assert.ok(store.has('reading-order'), 'cache key is the static "reading-order"');
  });

  it('pins the cache key and the 60000 ms TTL the handler passes', async () => {
    const { fs } = makeCountingFs(READING_ORDER_FIXTURE);
    const { cached, calls } = makeCached();
    await invoke('/api/references/reading-order', { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'reading-order');
    assert.equal(calls[0].ttl, 60000);
  });

  it('does not cache a 500 when references.yaml cannot be read (catch stays outside the closure)', async () => {
    // No bibliography/references.yaml, so the read inside fn() throws; the real
    // server.js cached() runs fn() before it stores, so the throw leaves nothing
    // cached and the outer catch returns the 500 envelope.
    const { fs } = makeCountingFs({ 'content/intro.md': 'See [@alpha; @bravo].\n' });
    const { cached, store, calls } = makeCached();
    const res = await invoke('/api/references/reading-order', { fs, cached });
    assert.deepEqual(res, { status: 500, payload: { error: 'Reading order failed' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 500 is never cached');
  });
});

describe('GET /api/references/completeness (cached("references-completeness", 60000))', () => {
  it('returns a payload byte-identical to the pre-cache computation', async () => {
    const viaCache = await invoke('/api/references/completeness', { ...makeCountingFs(COMPLETENESS_FIXTURE), ...makeCached() });
    const viaPre = await invoke('/api/references/completeness', { ...makeCountingFs(COMPLETENESS_FIXTURE), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.deepEqual(viaCache.payload, EXPECTED_COMPLETENESS);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(EXPECTED_COMPLETENESS));
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('serves a repeat request from cache with no second references.yaml read', async () => {
    const { fs, counts } = makeCountingFs(COMPLETENESS_FIXTURE);
    const { cached, store } = makeCached();

    const first = await invoke('/api/references/completeness', { fs, cached });
    assert.equal(first.status, 200);
    assert.equal(counts.yamlReads, 1, 'the first call reads references.yaml');
    const fileAfterFirst = counts.readFileSync;

    const second = await invoke('/api/references/completeness', { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.yamlReads, 1, 'cached repeat must not re-read references.yaml');
    assert.equal(counts.readFileSync, fileAfterFirst, 'cached repeat must not read any file again');
    assert.equal(store.size, 1, 'one cache entry for the param-free key');
    assert.ok(store.has('references-completeness'), 'cache key is the static "references-completeness"');
  });

  it('pins the cache key and the 60000 ms TTL the handler passes', async () => {
    const { fs } = makeCountingFs(COMPLETENESS_FIXTURE);
    const { cached, calls } = makeCached();
    await invoke('/api/references/completeness', { fs, cached });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'references-completeness');
    assert.equal(calls[0].ttl, 60000);
  });

  it('does not cache a 500 when references.yaml cannot be read (catch stays outside the closure)', async () => {
    const { fs } = makeCountingFs({});
    const { cached, store, calls } = makeCached();
    const res = await invoke('/api/references/completeness', { fs, cached });
    assert.deepEqual(res, { status: 500, payload: { error: 'Completeness check failed' } });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
    assert.equal(store.size, 0, 'the 500 is never cached');
  });
});
