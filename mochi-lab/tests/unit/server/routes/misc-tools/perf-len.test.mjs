import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// misc-tools.js is CommonJS; load it via createRequire the way the sibling route
// suites do (e.g. next-filehealth-fmbody.test.mjs). This suite pins the output of
// GET /api/perf after the handler hoists `const len = sorted.length;` once and
// reuses it for the avgMs divisor, the maxMs index, the p95Idx clamp, and the
// returned count. The fixtures separate p95 from max (a 20-sample endpoint where
// p95Idx lands one slot below the last) and exercise the 2-decimal avg rounding,
// so a mistyped reuse that crossed one read into another would change a value and
// fail this suite.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

// Drive GET /api/perf with a mocked ctx carrying only what this branch reads:
// the perfMetrics store and the json(res, status, payload) capture. Every other
// ctx helper is undefined, which is fine because the handler reaches the perf
// branch through an exact `pathname === '/api/perf'` match without touching them.
async function perfOf(perfMetrics) {
  const url = new URL('http://localhost/api/perf');
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    perfMetrics,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/perf', ctx);
  return captured;
}

// ── Fixtures ──
//
// `big`   : 20 samples (shuffled 1..20). sorted sum = 210, len = 20.
//           avgMs   = round((210 / 20) * 100) / 100 = 10.5
//           maxMs   = sorted[19] = 20
//           p95Idx  = min(ceil(20 * 0.95) - 1, 19) = min(18, 19) = 18 -> p95Ms = 19
//           This is the smallest n where p95Idx (18) separates from the max index
//           (19), so it proves the four len reads are not interchangeable indices.
// `small` : [9, 3, 6]. sorted sum = 18, len = 3. avgMs = 6, maxMs = 9, p95Ms = 9.
// `round` : [2, 1, 2]. sorted sum = 5, len = 3.
//           avgMs   = round((5 / 3) * 100) / 100 = round(166.666...) / 100 = 1.67
//           Exercises the 2-decimal rounding on the sum / len divisor.
// `idle`  : [] -> dropped by `.filter(([, times]) => times.length > 0)`.
//
// The outer `.sort((a, b) => b.avgMs - a.avgMs)` then orders big > small > round.
const PERF_FIXTURE = {
  '/api/big': [20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10],
  '/api/small': [9, 3, 6],
  '/api/round': [2, 1, 2],
  '/api/idle': [],
};

const EXPECTED = {
  endpoints: [
    { path: '/api/big', avgMs: 10.5, maxMs: 20, count: 20, p95Ms: 19 },
    { path: '/api/small', avgMs: 6, maxMs: 9, count: 3, p95Ms: 9 },
    { path: '/api/round', avgMs: 1.67, maxMs: 2, count: 3, p95Ms: 2 },
  ],
};

describe('GET /api/perf reuses the hoisted len for avg, max, p95, and count', () => {
  it('returns the per-endpoint metrics sorted by avgMs descending', async () => {
    const r = await perfOf(PERF_FIXTURE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED);
    // Stronger pin: exact key order and value formatting, not just deep equality.
    assert.equal(JSON.stringify(r.payload), JSON.stringify(EXPECTED));
  });

  it('drops endpoints with no recorded samples', async () => {
    const r = await perfOf(PERF_FIXTURE);
    assert.equal(r.payload.endpoints.length, 3);
    assert.ok(!r.payload.endpoints.some(e => e.path === '/api/idle'));
  });

  it('keeps p95Ms distinct from maxMs when p95Idx lands below the last sample', async () => {
    const r = await perfOf(PERF_FIXTURE);
    const big = r.payload.endpoints.find(e => e.path === '/api/big');
    assert.equal(big.count, 20);
    assert.equal(big.maxMs, 20);
    assert.equal(big.p95Ms, 19);
    assert.notEqual(big.p95Ms, big.maxMs);
  });

  it('returns an empty endpoints list when no metrics are recorded', async () => {
    const r = await perfOf({});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { endpoints: [] });
  });
});
