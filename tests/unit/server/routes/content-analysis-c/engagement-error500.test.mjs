import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// content-analysis-c.js is CommonJS; load the real module via createRequire the way
// the sibling route suites do (next-engagement-pathkey / next-analytics-export-csv),
// so this characterization test drives the genuine handler instead of a stand-in.
//
// It pins the GET /api/content-engagement OUTER CATCH. The whole per-page scoring
// body runs inside a single try (handler at content-analysis-c.js:552, try opens at
// :553); any throw lands in the catch at :584-585, which returns
// json(res, 500, {error: 'Engagement scoring failed'}). The try's first failable step
// is `const analytics = loadJSON(ANALYTICS_FILE)` at :554, so a loadJSON that throws
// on its first call short-circuits the entire handler straight into that 500, and the
// success 200 `{pages, total}` projection at :583 is never emitted.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-c.js');

// The handler resolves its four data inputs through ctx.loadJSON keyed by these file
// constants. The mock dispatches on the constant; the throwing variant ignores it.
const ANALYTICS_FILE = 'analytics.json';
const BOOKMARKS_FILE = 'bookmarks.json';
const READING_LISTS_FILE = 'reading-lists.json';

// Drive the real GET /api/content-engagement handler over a mocked ctx. loadJSON is
// rigged to throw on its Nth call (1-based); every call is recorded so a test can
// prove exactly how far the try advanced before the throw. Every json(res, status,
// payload) write is captured in an array so a test can assert the 500 is the ONLY
// reply and the success projection never fired. `cached` is a pass-through for parity
// with the sibling suites (this route keeps no result memo and never reaches it once
// the load throws).
async function engagement({ throwOnCall = 1 } = {}) {
  const loadCalls = [];
  const replies = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    loadJSON(file) {
      loadCalls.push(file);
      if (loadCalls.length === throwOnCall) throw new Error('data store unreadable');
      return {};
    },
    cached: (_key, _ttl, fn) => fn(),
    ANALYTICS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE,
  };
  const pathname = '/api/content-engagement';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { loadCalls, replies };
}

describe('GET /api/content-engagement outer catch returns 500 Engagement scoring failed', () => {
  it('maps a throw from the first loadJSON straight into the 500 reply', async () => {
    const { replies } = await engagement({ throwOnCall: 1 });
    // The single reply is the catch's 500; deepEqual pins both the status and the
    // exact `{error: 'Engagement scoring failed'}` body shape.
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0], { status: 500, body: { error: 'Engagement scoring failed' } });
  });

  it('throws on the very first load (ANALYTICS_FILE), short-circuiting the other three loads', async () => {
    // Proves the first failable step is the ANALYTICS_FILE load: it is the only file
    // requested, so the COMMENTS / BOOKMARKS / READING_LISTS loads never run.
    const { loadCalls } = await engagement({ throwOnCall: 1 });
    assert.deepEqual(loadCalls, [ANALYTICS_FILE]);
  });

  it('never emits the success 200 {pages, total} projection', async () => {
    // The never-reached proof: no reply carries a 200 status or the success body
    // keys, so the scoring projection at :583 was bypassed by the throw.
    const { replies } = await engagement({ throwOnCall: 1 });
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.body && ('pages' in r.body || 'total' in r.body)), false);
  });

  it('still returns the same 500 when a later load (bookmarks, the 2nd call) throws mid-try', async () => {
    // analytics + comments load fine (`{}`), then bookmarks throws on the 3rd call.
    // The SAME outer catch wraps the whole body, so the reply is still the lone 500
    // and the success projection is still never reached.
    const { loadCalls, replies } = await engagement({ throwOnCall: 2 });
    assert.deepEqual(loadCalls, [ANALYTICS_FILE, BOOKMARKS_FILE]);
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0], { status: 500, body: { error: 'Engagement scoring failed' } });
    assert.equal(replies.some((r) => r.status === 200), false);
  });
});
