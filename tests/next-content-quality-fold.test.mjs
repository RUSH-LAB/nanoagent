import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// content-analysis-c.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-c.js');

// Drive the real GET /api/content-quality handler over a minimal mocked ctx.
// `cached` is stubbed to return the supplied scores fixture so the fs scan is
// never touched, and `json` captures the {status, payload} the handler emits.
// This exercises the folded single pass that derives `averageScore` and the
// bucket `distribution` from one walk of `scores`.
async function contentQuality(scores) {
  const url = new URL('http://localhost/api/content-quality');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    cached: () => scores,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/content-quality', ctx);
  return captured;
}

// Build score records shaped like the real scan output ({path, title, score});
// only `score` drives the average and the distribution buckets.
const recs = (...nums) =>
  nums.map((score, i) => ({ path: `content/p${i}.md`, title: `P${i}`, score }));

describe('GET /api/content-quality — folded average and distribution', () => {
  it('buckets all five tiers and averages in a single pass', async () => {
    // One score on each side of every boundary (80, 60, 40, 20) plus the floor,
    // so each bucket lands exactly two entries.
    const r = await contentQuality(recs(100, 80, 79, 60, 59, 40, 39, 20, 19, 0));
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.distribution, {
      excellent: 2,
      good: 2,
      adequate: 2,
      needsImprovement: 2,
      minimal: 2,
    });
    // Sum 496 over 10 files -> 49.6, identical to the prior reduce-based average.
    assert.equal(r.payload.averageScore, 49.6);
    assert.equal(r.payload.totalFiles, 10);
  });

  it('returns zeros for an empty score set without dividing by zero', async () => {
    const r = await contentQuality([]);
    assert.equal(r.status, 200);
    assert.equal(r.payload.averageScore, 0);
    assert.equal(r.payload.totalFiles, 0);
    assert.deepEqual(r.payload.distribution, {
      excellent: 0,
      good: 0,
      adequate: 0,
      needsImprovement: 0,
      minimal: 0,
    });
  });

  it('rounds the average to one decimal the same way the reduce form did', async () => {
    const r = await contentQuality(recs(10, 10, 11));
    // Math.round(31 / 3 * 10) / 10 === 10.3
    assert.equal(r.payload.averageScore, Math.round((31 / 3) * 10) / 10);
    assert.equal(r.payload.averageScore, 10.3);
    // All three fall below 20, so they land in the minimal bucket.
    assert.deepEqual(r.payload.distribution, {
      excellent: 0,
      good: 0,
      adequate: 0,
      needsImprovement: 0,
      minimal: 3,
    });
  });
});
