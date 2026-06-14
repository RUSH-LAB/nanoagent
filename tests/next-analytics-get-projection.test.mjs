import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load the REAL route module the way the sibling
// server route tests do (see tests/next-users-me-protokey-default.test.mjs and
// tests/next-analytics-pageview-post-guards.test.mjs), so these cases exercise the
// shipped GET /api/analytics handler rather than a reimplementation.
//
// The handler is a pure projection over the analytics store:
//   const analytics = loadJSON(ANALYTICS_FILE);
//   return json(res, 200, { pageviews: analytics.counts || {}, recent: analytics.recent || [] });
// No existing suite drives it: the analytics-users tests cover the presence guards,
// set-role, the pageview POST, users/me, and dedup, while endpoint-shapes.test.mjs
// asserts only a local literal. So the {pageviews, recent} projection and its
// `|| {}` / `|| []` fallbacks were at zero coverage. The goldens below were captured
// by running the real handler. The GET branch only reads loadJSON, so every case is
// deterministic and the file edits no source.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

const PATHNAME = '/api/analytics';

// Drive GET /api/analytics with a minimal mocked ctx and capture the response handed
// to json(res, status, payload). loadJSON returns the supplied store verbatim, exactly
// as the real handler consumes its loadJSON(ANALYTICS_FILE) result; the read path never
// writes, so saveJSON is unneeded.
async function invoke(store) {
  const url = new URL(`http://localhost${PATHNAME}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    ANALYTICS_FILE: '/tmp/next-analytics-get-projection-test.json',
    loadJSON: () => store,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await analyticsUsersRoutes(req, res, url, PATHNAME, ctx);
  return captured;
}

describe('analytics-users GET /api/analytics projection', () => {
  it('projects counts and recent from a populated store', async () => {
    const store = {
      counts: { '/docs/intro': 5, '/blog/launch': 2 },
      recent: [
        { path: '/docs/intro', referrer: 'https://example.com', userAgent: 'Mozilla/5.0', timestamp: '2025-01-01T00:00:00.000Z' },
        { path: '/blog/launch', referrer: null, userAgent: null, timestamp: '2025-01-02T00:00:00.000Z' },
      ],
    };
    const r = await invoke(store);
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, {
      pageviews: { '/docs/intro': 5, '/blog/launch': 2 },
      recent: [
        { path: '/docs/intro', referrer: 'https://example.com', userAgent: 'Mozilla/5.0', timestamp: '2025-01-01T00:00:00.000Z' },
        { path: '/blog/launch', referrer: null, userAgent: null, timestamp: '2025-01-02T00:00:00.000Z' },
      ],
    });
  });

  it('falls back to {} and [] for an empty or missing store', async () => {
    // loadJSON yielding {} stands in for both an empty store and a missing file, so the
    // `|| {}` and `|| []` fallbacks both fire.
    const r = await invoke({});
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, { pageviews: {}, recent: [] });
  });

  it('keeps counts but falls back to [] when recent is absent', async () => {
    const r = await invoke({ counts: { '/x': 1 } });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, { pageviews: { '/x': 1 }, recent: [] });
  });

  it('keeps recent but falls back to {} when counts is absent', async () => {
    const store = { recent: [{ path: '/y', referrer: null, userAgent: null, timestamp: '2025-01-03T00:00:00.000Z' }] };
    const r = await invoke(store);
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, {
      pageviews: {},
      recent: [{ path: '/y', referrer: null, userAgent: null, timestamp: '2025-01-03T00:00:00.000Z' }],
    });
  });
});
