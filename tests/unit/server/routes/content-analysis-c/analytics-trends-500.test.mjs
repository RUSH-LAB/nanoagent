import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// content-analysis-c.js is CommonJS; load the real module the way the sibling
// route tests (next-analytics-export-csv, next-analytics-trends-fold-week-filters)
// do, so this characterization test drives the genuine GET /api/analytics/trends
// handler rather than a reimplementation.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-c.js');

// The trends handler reads loadJSON, ANALYTICS_FILE, and json from
// ctx. loadJSON is stubbed so no real filesystem is touched, and every call is
// recorded so a test can prove which reads run before the outer catch fires.
// Distinctive sentinel paths prove each stubbed read is keyed on the right ctx
// field.
const ANALYTICS_FILE = '/fake/root/data/analytics.json';

function makeCtx({ analytics = {}, comments = {}, throwOnLoad = false } = {}) {
  const calls = { loadJSON: [] };
  const ctx = {
    ANALYTICS_FILE,
    loadJSON(file) {
      calls.loadJSON.push(file);
      // The ANALYTICS_FILE read at content-analysis-c.js:516 is the first
      // statement inside the try, so throwing on this first call lands directly
      // in the outer catch before any later step is reached.
      if (throwOnLoad) throw new Error('analytics store unreadable');
      return file === ANALYTICS_FILE ? analytics
        : {};
    },
  };
  return { ctx, calls };
}

// Invoke the trends handler with a mocked ctx, capturing EVERY json(res, status,
// payload) reply it emits (the handler answers both success and failure through
// the json envelope, never a raw stream). Fully in process: no network, no
// server, no disk.
async function invoke(ctx) {
  const pathname = '/api/analytics/trends';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const replies = [];
  const res = { writableEnded: false };
  const fullCtx = {
    json(_res, status, payload) {
      replies.push({ status, payload });
      res.writableEnded = true;
      return replies[replies.length - 1];
    },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return { replies, res };
}

describe('GET /api/analytics/trends: outer-catch 500', () => {
  it('returns the 500 Trends calculation failed golden when the ANALYTICS_FILE read throws', async () => {
    const { ctx, calls } = makeCtx({ throwOnLoad: true });
    const { replies, res } = await invoke(ctx);

    // The exact golden the outer catch (content-analysis-c.js:547) emits.
    assert.deepStrictEqual(replies, [
      { status: 500, payload: { error: 'Trends calculation failed' } },
    ]);
    assert.equal(res.writableEnded, true, 'the catch sent its json reply');

    // The throw aborts at the first loadJSON (ANALYTICS_FILE, line 516); the
    // Every later step is never reached.
    assert.deepStrictEqual(calls.loadJSON, [ANALYTICS_FILE]);
  });

  it('never emits the success 200 projection on the failure path', async () => {
    const { ctx } = makeCtx({ throwOnLoad: true });
    const { replies } = await invoke(ctx);

    // The never-reached proof: no captured reply carries status 200, so the
    // {pageviews, comments, period} projection is fully suppressed by the catch.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.filter((r) => r.status === 200).length, 0);
  });
});

describe('GET /api/analytics/trends: success reachability anchor', () => {
  it('does emit the documented 200 projection when loadJSON returns data', async () => {
    // Empty fixtures make the projection independent of the wall clock (no
    // timestamps are counted), so this 200 is deterministic without freezing
    // Date.now(). It makes the never-reached proof above meaningful: the same
    // ctx shape, fed real data, genuinely reaches the 200 branch.
    const { ctx, calls } = makeCtx({ analytics: { recent: [] }, comments: {} });
    const { replies } = await invoke(ctx);

    assert.deepStrictEqual(replies, [
      {
        status: 200,
        payload: {
          pageviews: { thisWeek: 0, lastWeek: 0, growth: 0 },
          period: '7 days',
        },
      },
    ]);
    // The success path reads its single store.
    assert.deepStrictEqual(calls.loadJSON, [ANALYTICS_FILE]);
  });
});
