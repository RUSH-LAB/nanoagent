import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the REAL module the way the sibling server
// route tests do (mirroring tests/next-search-history-guards.test.mjs). The GET
// /api/search/history aggregation handler (roughly lines 124 to 134 of
// server/routes/content-analysis-c.js) lives in this module, so these tests exercise
// the genuine aggregation rather than a reimplementation.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

const PROJECT_ROOT = '/fake/root';

// Drive the real GET /api/search/history handler through a mocked ctx. Unlike the POST
// record handler (covered by next-search-history-guards.test.mjs), this GET path has no
// rate limit and no guards: it is a single linear success path that calls loadJSON once
// and json once. So loadJSON RETURNS the supplied store (rather than throwing) and we
// capture the json(res, status, payload) response plus counters proving loadJSON ran
// exactly once and nothing was written. The handler reads no clock, random, or network
// value, so the whole {recent, popular, total} payload is deterministic.
async function invokeGet(store) {
  const pathname = '/api/search/history';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCount = 0;
  let saveCount = 0;
  let jsonCount = 0;
  let loadedFile = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    loadJSON: (file) => { loadCount++; loadedFile = file; return store; },
    saveJSON: () => { saveCount++; },
    json(_res, status, payload) {
      jsonCount++;
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return { captured, loadCount, saveCount, jsonCount, loadedFile };
}

describe('GET /api/search/history aggregation (recent, popular, total)', () => {
  it('returns 200 {recent:[], popular:[], total:0} for an empty store, reading once and writing nothing', async () => {
    const result = await invokeGet({});
    assert.equal(result.captured.status, 200);
    assert.deepEqual(result.captured.payload, { recent: [], popular: [], total: 0 });
    // The handler reads data/search-history.json exactly once and never writes.
    assert.equal(result.loadCount, 1);
    assert.equal(result.jsonCount, 1);
    assert.equal(result.saveCount, 0);
    assert.equal(result.loadedFile, path.join(PROJECT_ROOT, 'var', 'data', 'search-history.json'));
  });

  it('returns the same empty aggregation when the store has an empty searches array', async () => {
    const result = await invokeGet({ searches: [] });
    assert.equal(result.captured.status, 200);
    assert.deepEqual(result.captured.payload, { recent: [], popular: [], total: 0 });
    assert.equal(result.loadCount, 1);
    assert.equal(result.saveCount, 0);
  });

  it('recent is the last 50 entries, most recent first, dropping the older ones', async () => {
    // Seed 60 searches tagged with an idx so order is unambiguous. recent should be
    // the final 50 (idx 10 through 59) reversed to most recent first, and the oldest
    // 10 (idx 0 through 9) should be dropped.
    const searches = [];
    for (let i = 0; i < 60; i++) searches.push({ query: `q${i}`, resultCount: i, idx: i });
    const result = await invokeGet({ searches });

    const recent = result.captured.payload.recent;
    assert.equal(recent.length, 50);
    assert.equal(recent[0].idx, 59, 'recent[0] is the most recently appended entry');
    assert.equal(recent[49].idx, 10, 'recent[49] is the 50th most recent entry');
    // Strictly reversed: position k holds the entry with idx 59 minus k.
    for (let k = 0; k < 50; k++) assert.equal(recent[k].idx, 59 - k);
    // The oldest 10 entries fall outside the window.
    assert.ok(recent.every((r) => r.idx >= 10), 'idx 0 through 9 are dropped');
  });

  it('total is the full search count (not capped at the 50-entry recent window) and popular counts the whole store', async () => {
    // 60 occurrences of "hot" at the front, then 77 unique "cold-N" entries. The 137
    // entries push every "hot" outside the recent-50 window, yet popular still ranks
    // "hot" first with its full count, proving popular aggregates the entire store and
    // total is the uncapped length.
    const searches = [];
    for (let i = 0; i < 60; i++) searches.push({ query: 'hot', resultCount: 0 });
    for (let i = 0; i < 77; i++) searches.push({ query: `cold-${i}`, resultCount: 0 });
    const result = await invokeGet({ searches });

    assert.equal(result.captured.payload.total, 137);
    assert.equal(result.captured.payload.recent.length, 50);
    assert.deepEqual(result.captured.payload.popular[0], { query: 'hot', count: 60 });
    assert.ok(
      result.captured.payload.recent.every((r) => r.query !== 'hot'),
      '"hot" is absent from recent yet still tops popular',
    );
  });

  it('popular is the top 10 queries by descending count, capped at 10 entries shaped {query, count}', async () => {
    // 12 distinct queries with strictly descending frequencies. popular keeps the top
    // 10 by count and drops q11 (count 2) and q12 (count 1).
    const counts = { q01: 12, q02: 11, q03: 10, q04: 9, q05: 8, q06: 7, q07: 6, q08: 5, q09: 4, q10: 3, q11: 2, q12: 1 };
    const searches = [];
    for (const [query, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) searches.push({ query, resultCount: 0 });
    }
    const result = await invokeGet({ searches });

    assert.equal(result.captured.payload.popular.length, 10);
    assert.deepEqual(result.captured.payload.popular, [
      { query: 'q01', count: 12 },
      { query: 'q02', count: 11 },
      { query: 'q03', count: 10 },
      { query: 'q04', count: 9 },
      { query: 'q05', count: 8 },
      { query: 'q06', count: 7 },
      { query: 'q07', count: 6 },
      { query: 'q08', count: 5 },
      { query: 'q09', count: 4 },
      { query: 'q10', count: 3 },
    ]);
    assert.equal(result.captured.payload.total, 78);
  });

  it('popular preserves first-insertion order on count ties (stable sort, not alphabetical)', async () => {
    // Two pairs of tied counts. First occurrences land in the order banana, apple,
    // date, cherry, elder, which is the reverse of alphabetical within each tie group.
    // The stable sort keeps that insertion order, so banana precedes apple and date
    // precedes cherry even though alphabetical order would swap them.
    const searches = [];
    for (let i = 0; i < 3; i++) searches.push({ query: 'banana', resultCount: 0 });
    for (let i = 0; i < 3; i++) searches.push({ query: 'apple', resultCount: 0 });
    for (let i = 0; i < 2; i++) searches.push({ query: 'date', resultCount: 0 });
    for (let i = 0; i < 2; i++) searches.push({ query: 'cherry', resultCount: 0 });
    searches.push({ query: 'elder', resultCount: 0 });
    const result = await invokeGet({ searches });

    assert.deepEqual(result.captured.payload.popular, [
      { query: 'banana', count: 3 },
      { query: 'apple', count: 3 },
      { query: 'date', count: 2 },
      { query: 'cherry', count: 2 },
      { query: 'elder', count: 1 },
    ]);
  });

  it('recent echoes the stored search objects as-is in reversed order', async () => {
    // A representative entry deep-equals its stored form, and the full payload matches:
    // recent is the stored list reversed, popular counts each single occurrence in
    // first-insertion order, and total is the length.
    const searches = [
      { query: 'alpha', userId: 'u1', resultCount: 3, timestamp: '2026-01-01T00:00:00Z' },
      { query: 'beta', userId: 'anonymous', resultCount: 0, timestamp: '2026-01-02T00:00:00Z' },
      { query: 'gamma', userId: 'u2', resultCount: 7, timestamp: '2026-01-03T00:00:00Z' },
    ];
    const result = await invokeGet({ searches });

    // The newest stored entry leads recent and echoes its stored object exactly.
    assert.deepEqual(result.captured.payload.recent[0], searches[2]);
    assert.deepEqual(result.captured.payload, {
      recent: [searches[2], searches[1], searches[0]],
      popular: [
        { query: 'alpha', count: 1 },
        { query: 'beta', count: 1 },
        { query: 'gamma', count: 1 },
      ],
      total: 3,
    });
  });
});
