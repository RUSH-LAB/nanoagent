import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';
const HISTORY_PATH = path.join(PROJECT_ROOT, 'var', 'data', 'search-history.json');

// Drive the real GET /api/search/analytics handler over a mocked ctx and capture
// the json() response. `loadJSON` only answers for the search-history path, so a
// wrong path would surface as a thrown error (caught as a 500) rather than a
// silent empty result. Fully in-process: no network, no disk, no server.
async function getAnalytics(history) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    loadJSON(fp) {
      if (fp !== HISTORY_PATH) throw new Error(`unexpected loadJSON path: ${fp}`);
      return history;
    },
    json(_res, status, body) { captured = { status, body }; return captured; },
  };
  const url = new URL('http://localhost/api/search/analytics');
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  await routes(req, res, url, '/api/search/analytics', ctx);
  return captured;
}

// Eight searches engineered so dedup, source order, count sorting, and the daily
// rollup all carry signal:
//   zero-result rows (in source order):  zzz, zzz, gamma, zzz, alpha
//     -> deduped + sliced -> ['zzz', 'gamma', 'alpha']  (first-seen order, three
//        zzz collapse to one, alpha is zero only on its third appearance)
//   queryCounts:  alpha 3, zzz 3, beta 1, gamma 1  (alpha/zzz and beta/gamma tie,
//     so the stable sort must keep first-insertion order: alpha, zzz, beta, gamma)
//   byDay:  2026-01-01 -> 2, 2026-01-02 -> 3, 2026-01-03 -> 3
const SEARCHES = [
  { query: 'alpha', resultCount: 5, timestamp: '2026-01-01T08:00:00Z' },
  { query: 'zzz', resultCount: 0, timestamp: '2026-01-01T09:00:00Z' },
  { query: 'beta', resultCount: 3, timestamp: '2026-01-02T10:00:00Z' },
  { query: 'zzz', resultCount: 0, timestamp: '2026-01-02T11:00:00Z' },
  { query: 'alpha', resultCount: 2, timestamp: '2026-01-02T12:00:00Z' },
  { query: 'gamma', resultCount: 0, timestamp: '2026-01-03T07:00:00Z' },
  { query: 'zzz', resultCount: 0, timestamp: '2026-01-03T08:00:00Z' },
  { query: 'alpha', resultCount: 0, timestamp: '2026-01-03T09:00:00Z' },
];

// Independent re-implementation of the original two-pass algorithm, kept here as
// an oracle: the folded single-pass handler must reproduce exactly what this
// produced for the same input.
function twoPassReference(searches) {
  const queryCounts = {};
  let zeroResults = 0;
  const byDay = {};
  for (const s of searches) {
    queryCounts[s.query] = (queryCounts[s.query] || 0) + 1;
    if (s.resultCount === 0) zeroResults++;
    if (s.timestamp) {
      const day = s.timestamp.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
  }
  const topQueries = Object.entries(queryCounts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([q, c]) => ({ query: q, count: c }));
  const zeroResultQueries = searches.filter(s => s.resultCount === 0).map(s => s.query);
  const uniqueZero = [...new Set(zeroResultQueries)].slice(0, 10);
  const dailyVolume = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count }));
  return {
    totalSearches: searches.length,
    uniqueQueries: Object.keys(queryCounts).length,
    zeroResultCount: zeroResults,
    topQueries,
    zeroResultQueries: uniqueZero,
    dailyVolume: dailyVolume.slice(-30),
  };
}

describe('GET /api/search/analytics single-pass fold', () => {
  it('returns the exact payload the two-pass version produced', async () => {
    const res = await getAnalytics({ searches: SEARCHES });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      totalSearches: 8,
      uniqueQueries: 4,
      zeroResultCount: 5,
      topQueries: [
        { query: 'alpha', count: 3 },
        { query: 'zzz', count: 3 },
        { query: 'beta', count: 1 },
        { query: 'gamma', count: 1 },
      ],
      zeroResultQueries: ['zzz', 'gamma', 'alpha'],
      dailyVolume: [
        { day: '2026-01-01', count: 2 },
        { day: '2026-01-02', count: 3 },
        { day: '2026-01-03', count: 3 },
      ],
    });
  });

  it('matches the independent two-pass oracle field for field', async () => {
    const res = await getAnalytics({ searches: SEARCHES });
    assert.deepEqual(res.body, twoPassReference(SEARCHES));
  });

  it('preserves source order and dedup in zeroResultQueries', async () => {
    // deepEqual on arrays is order sensitive, so this pins both the dedup (three
    // zzz rows collapse to one) and the first-seen ordering the fold must keep.
    const res = await getAnalytics({ searches: SEARCHES });
    assert.deepEqual(res.body.zeroResultQueries, ['zzz', 'gamma', 'alpha']);
  });

  it('returns the empty payload when there is no search history', async () => {
    const res = await getAnalytics({});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      totalSearches: 0,
      uniqueQueries: 0,
      zeroResultCount: 0,
      topQueries: [],
      zeroResultQueries: [],
      dailyVolume: [],
    });
  });

  it('responds 500 when the history cannot be loaded', async () => {
    let captured = null;
    const ctx = {
      path,
      PROJECT_ROOT,
      loadJSON() { throw new Error('boom'); },
      json(_res, status, body) { captured = { status, body }; return captured; },
    };
    const url = new URL('http://localhost/api/search/analytics');
    await routes({ method: 'GET' }, { writableEnded: false }, url, '/api/search/analytics', ctx);
    assert.equal(captured.status, 500);
    assert.deepEqual(captured.body, { error: 'Search analytics failed' });
  });
});
