import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-c.js');
const { numericParam } = routes;

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

describe('numericParam helper', () => {
  it('is exported alongside the route handler', () => {
    assert.equal(typeof routes, 'function', 'default export is the route handler');
    assert.equal(typeof numericParam, 'function', 'numericParam is exported');
  });

  // ── backlink-ranking call site: numericParam(raw, 30, 200) ──
  it('returns the default for absent values (null / empty string)', () => {
    assert.equal(numericParam(null, 30, 200), 30);
    assert.equal(numericParam('', 30, 200), 30);
  });

  it('passes valid numeric values through unchanged', () => {
    assert.equal(numericParam('5', 30, 200), 5);
    assert.equal(numericParam('0', 30, 200), 0);
  });

  it('clamps valid numeric values above the cap', () => {
    assert.equal(numericParam('500', 30, 200), 200);
  });

  it('returns the default for non-numeric values and never yields NaN', () => {
    assert.equal(numericParam('abc', 30, 200), 30);
    assert.ok(!Number.isNaN(numericParam('abc', 30, 200)), 'limit guard never NaN');
  });
});

describe('GET /api/content-backlink-ranking limit guard', () => {
  // 250 pre-ranked pages so the default (30), the clamp (200), and the broken
  // NaN path (slice(0, NaN) === empty) are all distinguishable. The handler wraps
  // the directory scan in cached(); stub it to return the fixed ranking so the
  // test exercises only the limit-guard slicing.
  const ranking = Array.from({ length: 250 }, (_, i) => ({
    id: `page-${i}`,
    path: `content/page-${i}.md`,
    title: `Page ${i}`,
    incomingLinks: 250 - i,
  }));
  const ctx = { cached: () => ranking };
  const callRanking = search => invoke({ pathname: '/api/content-backlink-ranking', search, ctx });

  it('absent limit returns the default-sized page (30)', async () => {
    const r = await callRanking('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.pages.length, 30);
    assert.equal(r.payload.totalPages, 250);
  });

  it('valid limit is honored', async () => {
    const r = await callRanking('?limit=5');
    assert.equal(r.status, 200);
    assert.equal(r.payload.pages.length, 5);
  });

  it('valid limit above the cap clamps to 200', async () => {
    const r = await callRanking('?limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.payload.pages.length, 200);
  });

  it('non-numeric limit yields the default-bounded page, not an empty one', async () => {
    const r = await callRanking('?limit=abc');
    assert.equal(r.status, 200);
    assert.equal(r.payload.pages.length, 30, 'guarded to default, not slice(0, NaN) === []');
    assert.notEqual(r.payload.pages.length, 0, 'page is not collapsed to empty');
  });
});
