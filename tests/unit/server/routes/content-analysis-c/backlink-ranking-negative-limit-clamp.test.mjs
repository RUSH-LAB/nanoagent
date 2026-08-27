import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// content-analysis-c.js is CommonJS; load it the way the sibling guard suite
// (next-content-analysis-c-guard.test.mjs) does and reuse its ctx-mocking shape.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

// Invoke a content-analysis-c route handler with a minimal mocked ctx and
// capture the response that the handler hands to `json(res, status, payload)`.
async function invoke({ method = 'GET', pathname, search = '', ctx = {} }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('GET /api/content-backlink-ranking negative-limit clamp', () => {
  // 250 pre-ranked pages so the default (30), the cap clamp (200), and the
  // negative-limit case are all distinguishable. Link counts descend, and the
  // final 10 pages sit at 0 so `leastLinked` (filter incomingLinks === 0,
  // slice 0..10) has a stable, non-empty value to pin. The handler wraps the
  // directory scan in cached(); stub it to return this fixed ranking so the
  // test exercises only the limit-guard slicing.
  const TOTAL = 250;
  const ranking = Array.from({ length: TOTAL }, (_, i) => ({
    id: `page-${i}`,
    path: `content/page-${i}.md`,
    title: `Page ${i}`,
    incomingLinks: Math.max(TOTAL - 10 - i, 0),
  }));
  const ctx = { cached: () => ranking };
  const callRanking = search => invoke({ pathname: '/api/content-backlink-ranking', search, ctx });

  // The same `mostLinked` / `leastLinked` slices the handler returns; the limit
  // clamp must never disturb either.
  const expectedMostLinked = ranking.slice(0, 5);
  const expectedLeastLinked = ranking.filter(p => p.incomingLinks === 0).slice(0, 10);

  it('negative limit yields an empty page, not a count-from-the-end tail', async () => {
    const r = await callRanking('?limit=-5');
    assert.equal(r.status, 200);
    // Math.max(numericParam(...), 0) clamps the negative limit to 0, so
    // ranking.slice(0, 0) === []. Without the clamp, slice(0, -5) would drop
    // the last 5 pages and report 245 entries here instead.
    assert.deepEqual(r.payload.pages, []);
    assert.equal(r.payload.pages.length, 0);
    // totalPages still reports the full count, unaffected by the page clamp.
    assert.equal(r.payload.totalPages, TOTAL);
    // mostLinked and leastLinked are untouched by the negative limit.
    assert.deepEqual(r.payload.mostLinked, expectedMostLinked);
    assert.deepEqual(r.payload.leastLinked, expectedLeastLinked);
  });

  it('absent limit returns the default-sized page (30)', async () => {
    const r = await callRanking('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.pages.length, 30);
    assert.deepEqual(r.payload.pages, ranking.slice(0, 30));
    assert.equal(r.payload.totalPages, TOTAL);
    assert.deepEqual(r.payload.mostLinked, expectedMostLinked);
    assert.deepEqual(r.payload.leastLinked, expectedLeastLinked);
  });

  it('valid positive limit is honored unchanged', async () => {
    const r = await callRanking('?limit=5');
    assert.equal(r.status, 200);
    assert.equal(r.payload.pages.length, 5);
    assert.deepEqual(r.payload.pages, ranking.slice(0, 5));
    assert.equal(r.payload.totalPages, TOTAL);
  });

  it('limit above the cap clamps to 200', async () => {
    const r = await callRanking('?limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.payload.pages.length, 200);
    assert.deepEqual(r.payload.pages, ranking.slice(0, 200));
    assert.equal(r.payload.totalPages, TOTAL);
  });

  it('zero limit returns an empty page (Math.max(0, 0) === 0)', async () => {
    const r = await callRanking('?limit=0');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.pages, []);
    assert.equal(r.payload.totalPages, TOTAL);
    // The zero-limit page is empty, yet the summary slices stay intact.
    assert.deepEqual(r.payload.mostLinked, expectedMostLinked);
    assert.deepEqual(r.payload.leastLinked, expectedLeastLinked);
  });
});
