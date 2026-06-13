import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module the way the sibling route tests
// do (tests/next-whiteboard-write-ownprop-guard.test.mjs and
// tests/next-citations-cache.test.mjs). This add-only characterization test pins
// the CURRENT, correct behavior of three network-free handlers over a fully
// mocked ctx: no real filesystem, network, subprocess, clock, or randomness.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/misc-tools.js');

const WHITEBOARDS_FILE = '/fake/whiteboards.json';
const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// GET /api/whiteboards (the plural list, distinct from the singular
// /api/whiteboard covered by tests/next-whiteboard-write-ownprop-guard.test.mjs).
// The handler is not wrapped in cached and has no try/catch, so it always answers
// 200. It reads only loadJSON, WHITEBOARDS_FILE, and json from ctx, mapping
// Object.values(store) to {id, elementCount, updatedAt} where elementCount falls
// back to 0 when the elements field is missing.
async function listWhiteboards(store) {
  const url = new URL('http://localhost/api/whiteboards');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    WHITEBOARDS_FILE,
    loadJSON: (file) => (file === WHITEBOARDS_FILE ? store : {}),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/whiteboards', ctx);
  return captured;
}

describe('GET /api/whiteboards: plural list summary', () => {
  it('maps a populated store to per-record id, elementCount, and updatedAt', async () => {
    const store = {
      'board-1': { id: 'board-1', elements: [{}, {}, {}], updatedAt: '2026-01-01T00:00:00.000Z' },
      'board-2': { id: 'board-2', elements: [{}], updatedAt: '2026-02-02T00:00:00.000Z' },
    };
    const r = await listWhiteboards(store);
    assert.equal(r.status, 200);
    // Object.values preserves insertion order, so board-1 precedes board-2.
    assert.deepEqual(r.payload, {
      whiteboards: [
        { id: 'board-1', elementCount: 3, updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'board-2', elementCount: 1, updatedAt: '2026-02-02T00:00:00.000Z' },
      ],
    });
  });

  it('returns an empty list for an empty store', async () => {
    const r = await listWhiteboards({});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { whiteboards: [] });
  });

  it('treats a record with no elements field as elementCount 0', async () => {
    const store = { 'board-3': { id: 'board-3', updatedAt: '2026-03-03T00:00:00.000Z' } };
    const r = await listWhiteboards(store);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      whiteboards: [{ id: 'board-3', elementCount: 0, updatedAt: '2026-03-03T00:00:00.000Z' }],
    });
  });
});

// GET /api/references/impact. Wrapped in cached('ref-impact', 60000, fn). The
// closure reads bibliography/references.yaml through the real js-yaml, walks
// content/ counting [@key] citations (skipping dot and underscore prefixes and
// non-allowed extensions), then scores each reference:
//   score = round((citations*3 + venueBonus + recencyBonus) * 10) / 10
// venueBonus = 2 for a top venue else 0; recencyBonus = 1 (year >= 2022),
// 0.5 (year >= 2020), else 0. Both thresholds are static literals, so the scoring
// is fully deterministic and clock-independent.

// In-memory fs over a {bibliography, content} tree keyed by absolute path.
// readdirSync and readFileSync are counted so a test can prove the second request
// is served from cache. Mirrors makeFs in tests/next-citations-cache.test.mjs.
function makeFs(tree, root) {
  const dirs = new Map();
  const files = new Map();
  (function walk(node, dirPath) {
    const entries = [];
    for (const [name, val] of Object.entries(node)) {
      const fp = path.join(dirPath, name);
      if (typeof val === 'string') { entries.push({ name, dir: false }); files.set(fp, val); }
      else { entries.push({ name, dir: true }); walk(val, fp); }
    }
    dirs.set(dirPath, entries);
  })(tree, root);

  const counts = { readdir: 0, read: 0 };
  const fsMock = {
    readdirSync(dir) {
      counts.readdir++;
      const entries = dirs.get(dir);
      if (!entries) throw new Error(`ENOENT readdir ${dir}`);
      return entries.map(e => ({ name: e.name, isDirectory: () => e.dir }));
    },
    readFileSync(fp) {
      counts.read++;
      if (files.has(fp)) return files.get(fp);
      throw new Error(`ENOENT read ${fp}`);
    },
  };
  return { fsMock, counts };
}

// A memoizing cached(key, ttl, fn) that also records every (key, ttlMs) pair so a
// test can pin the exact cache key and TTL. Permanent memo (TTL ignored): the
// tests issue back-to-back calls, so the hit is deterministic without a clock.
// Mirrors makeCached in tests/next-citations-cache.test.mjs.
function makeCached() {
  const store = new Map();
  const calls = [];
  function cached(key, ttlMs, fn) {
    calls.push({ key, ttlMs });
    if (store.has(key)) return store.get(key);
    const data = fn();
    store.set(key, data);
    return data;
  }
  cached.calls = calls;
  return cached;
}

// Turn an array of {key, title, year, venue} rows into the bibliography text the
// real js-yaml parses. Real YAML text, real library (per the task: feed YAML, do
// not mock js-yaml).
function bib(entries) {
  const lines = [];
  for (const e of entries) {
    lines.push(`${e.key}:`);
    lines.push(`  title: ${e.title}`);
    lines.push(`  year: ${e.year}`);
    lines.push(`  venue: ${e.venue}`);
  }
  lines.push('');
  return lines.join('\n');
}

function impactFixture(entries, content = {}) {
  return { bibliography: { 'references.yaml': bib(entries) }, content };
}

async function invokeImpact(fsMock, cached) {
  const url = new URL('http://localhost/api/references/impact');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs: fsMock, path, PROJECT_ROOT, ALLOWED_EXTS, cached,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/references/impact', ctx);
  return captured;
}

describe('GET /api/references/impact: deterministic scoring', () => {
  // One bibliography that exercises citation counting, the top-venue bonus, and
  // all three recency tiers, with scores chosen distinct so the sort order does
  // not depend on tie-breaking.
  const YAML = bib([
    { key: 'citedpaper', title: 'Cited Paper', year: 2023, venue: 'CVPR' },
    { key: 'venuetop', title: 'Venue Top', year: 2019, venue: 'ICLR' },
    { key: 'recencyhigh', title: 'Recency High', year: 2022, venue: 'ArXiv' },
    { key: 'recencymid', title: 'Recency Mid', year: 2020, venue: 'ArXiv' },
    { key: 'plainold', title: 'Plain Old', year: 2019, venue: 'ArXiv' },
  ]);
  // citedpaper is cited once at the root and once in a subdirectory (proving the
  // walk recurses). The non-allowed extension, the dotfile, and the underscore
  // file each cite citedpaper too, but all sit on skip paths, so citedpaper must
  // settle at exactly 2 citations.
  const CONTENT = {
    'intro.md': 'see [@citedpaper]',
    sub: { 'deep.md': 'again [@citedpaper]' },
    'skip.txt': 'wrong ext [@citedpaper]',
    '.hidden.md': 'hidden [@citedpaper]',
    '_draft.md': 'underscore [@citedpaper]',
  };
  const TREE = { bibliography: { 'references.yaml': YAML }, content: CONTENT };

  // citedpaper: round((2*3 + 2 + 1)*10)/10 = 9; venuetop: 0 + 2 + 0 = 2;
  // recencyhigh: 0 + 0 + 1 = 1; recencymid: 0 + 0 + 0.5 = 0.5; plainold: 0.
  const EXPECTED = {
    references: [
      { key: 'citedpaper', title: 'Cited Paper', year: 2023, venue: 'CVPR', citations: 2, score: 9 },
      { key: 'venuetop', title: 'Venue Top', year: 2019, venue: 'ICLR', citations: 0, score: 2 },
      { key: 'recencyhigh', title: 'Recency High', year: 2022, venue: 'ArXiv', citations: 0, score: 1 },
      { key: 'recencymid', title: 'Recency Mid', year: 2020, venue: 'ArXiv', citations: 0, score: 0.5 },
      { key: 'plainold', title: 'Plain Old', year: 2019, venue: 'ArXiv', citations: 0, score: 0 },
    ],
    total: 5,
  };

  it('scores and sorts a populated bibliography, counting cites only on allowed, non-skipped files', async () => {
    const { fsMock } = makeFs(TREE, PROJECT_ROOT);
    const r = await invokeImpact(fsMock, makeCached());
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED);
  });

  it('serves the second back-to-back call from cache, keyed ref-impact with a 60000 ttl', async () => {
    const { fsMock, counts } = makeFs(TREE, PROJECT_ROOT);
    const cached = makeCached();

    const first = await invokeImpact(fsMock, cached);
    const readdirAfterFirst = counts.readdir;
    const readAfterFirst = counts.read;
    assert.equal(first.status, 200);
    assert.ok(readdirAfterFirst > 0, 'the first request walks the content tree');
    assert.ok(readAfterFirst > 0, 'the first request reads files');

    const second = await invokeImpact(fsMock, cached);
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(counts.readdir, readdirAfterFirst, 'second request does not re-walk: served from cache');
    assert.equal(counts.read, readAfterFirst, 'second request reads no files: served from cache');
    assert.deepEqual(cached.calls, [
      { key: 'ref-impact', ttlMs: 60000 },
      { key: 'ref-impact', ttlMs: 60000 },
    ]);
  });
});

describe('GET /api/references/impact: scoring components and error branch', () => {
  it('adds a venue bonus of 2 for a top venue and 0 otherwise', async () => {
    // Same year (recency 0) and zero citations, so the only difference is venue.
    const tree = impactFixture([
      { key: 'withvenue', title: 'With Venue', year: 2019, venue: 'NeurIPS' },
      { key: 'novenue', title: 'No Venue', year: 2019, venue: 'ArXiv' },
    ]);
    const { fsMock } = makeFs(tree, PROJECT_ROOT);
    const r = await invokeImpact(fsMock, makeCached());
    assert.equal(r.status, 200);
    const byKey = Object.fromEntries(r.payload.references.map(x => [x.key, x.score]));
    assert.equal(byKey.withvenue, 2);
    assert.equal(byKey.novenue, 0);
  });

  it('applies recency tiers: 1 for year >= 2022, 0.5 for year >= 2020, else 0', async () => {
    // Non-top venue and zero citations, so the only difference is recency.
    const tree = impactFixture([
      { key: 'y2022', title: 'Y 2022', year: 2022, venue: 'ArXiv' },
      { key: 'y2020', title: 'Y 2020', year: 2020, venue: 'ArXiv' },
      { key: 'y2019', title: 'Y 2019', year: 2019, venue: 'ArXiv' },
    ]);
    const { fsMock } = makeFs(tree, PROJECT_ROOT);
    const r = await invokeImpact(fsMock, makeCached());
    assert.equal(r.status, 200);
    const byKey = Object.fromEntries(r.payload.references.map(x => [x.key, x.score]));
    assert.equal(byKey.y2022, 1);
    assert.equal(byKey.y2020, 0.5);
    assert.equal(byKey.y2019, 0);
  });

  it('returns 200 with an empty list when the bibliography YAML is empty', async () => {
    // yaml.load('') is undefined, so `|| {}` yields no references.
    const tree = { bibliography: { 'references.yaml': '' }, content: {} };
    const { fsMock } = makeFs(tree, PROJECT_ROOT);
    const r = await invokeImpact(fsMock, makeCached());
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { references: [], total: 0 });
  });

  it('returns 500 Impact scoring failed when the references.yaml read throws', async () => {
    const throwingFs = {
      readFileSync() { throw new Error('disk error'); },
      readdirSync() { return []; },
    };
    const r = await invokeImpact(throwingFs, makeCached());
    assert.equal(r.status, 500);
    assert.deepEqual(r.payload, { error: 'Impact scoring failed' });
  });
});

// GET /api/debug/routes. No I/O and not cached: the handler echoes exactly eight
// fields off ctx._routeDiagnostics. The boot-time analysis that fills
// _routeDiagnostics runs in server.js, so the test injects a fake object and pins
// the echo rather than exercising the analyzer.
async function debugRoutes(diagnostics) {
  const url = new URL('http://localhost/api/debug/routes');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    _routeDiagnostics: diagnostics,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/debug/routes', ctx);
  return captured;
}

describe('GET /api/debug/routes: diagnostics echo', () => {
  it('echoes exactly the eight diagnostics fields, dropping any extras', async () => {
    const diagnostics = {
      totalHandlers: 42,
      uniqueRoutes: 40,
      duplicateCount: 2,
      deadCodeLines: 7,
      startupMs: 123,
      memoryAtStartupMB: 55,
      routes: ['/api/a', '/api/b'],
      duplicates: [{ path: '/api/x', count: 2 }],
      secretInternal: 'should not be echoed',
    };
    const r = await debugRoutes(diagnostics);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      totalHandlers: 42,
      uniqueRoutes: 40,
      duplicateCount: 2,
      deadCodeLines: 7,
      startupMs: 123,
      memoryAtStartupMB: 55,
      routes: ['/api/a', '/api/b'],
      duplicates: [{ path: '/api/x', count: 2 }],
    });
    // The extra field is not part of the echoed shape.
    assert.equal(Object.hasOwn(r.payload, 'secretInternal'), false);
  });

  it('reflects a different injected object so the echo is not hardcoded', async () => {
    const diagnostics = {
      totalHandlers: 0,
      uniqueRoutes: 0,
      duplicateCount: 0,
      deadCodeLines: 0,
      startupMs: 0,
      memoryAtStartupMB: 0,
      routes: [],
      duplicates: [],
    };
    const r = await debugRoutes(diagnostics);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, diagnostics);
  });
});
