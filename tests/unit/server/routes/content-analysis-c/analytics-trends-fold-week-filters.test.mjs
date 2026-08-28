import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// content-analysis-c.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-c.js');

const DAY = 86400000;
// A fixed epoch so the 7 and 14 day window boundaries fall on exact, repeatable
// timestamps regardless of when the suite runs.
const NOW = 1700000000000;
const iso = (ms) => new Date(ms).toISOString();

// Invoke GET /api/analytics/trends with Date.now() frozen to NOW and loadJSON
// stubbed to serve the supplied analytics and comments fixtures. Returns the
// {status, payload} the handler passed to json().
async function trends({ recent = [], comments = {} } = {}) {
  const url = new URL('http://localhost/api/analytics/trends');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    ANALYTICS_FILE: 'ANALYTICS',
    loadJSON: (file) =>
      file === 'ANALYTICS' ? { recent } : file === 'COMMENTS' ? comments : {},
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    await routes(req, res, url, '/api/analytics/trends', ctx);
  } finally {
    Date.now = realNow;
  }
  return captured;
}

describe('GET /api/analytics/trends — pageview window counting', () => {
  it('counts a representative spread across thisWeek, lastWeek, and neither', async () => {
    const r = await trends({
      recent: [
        { timestamp: iso(NOW - 1 * DAY) },   // thisWeek
        { timestamp: iso(NOW - 6 * DAY) },   // thisWeek
        { timestamp: iso(NOW - 8 * DAY) },   // lastWeek
        { timestamp: iso(NOW - 13 * DAY) },  // lastWeek
        { timestamp: iso(NOW - 20 * DAY) },  // neither (too old)
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.pageviews.thisWeek, 2);
    assert.equal(r.payload.pageviews.lastWeek, 2);
    // (2 - 2) / 2 * 100 = 0
    assert.equal(r.payload.pageviews.growth, 0);
  });

  it('counts an item exactly 7 days old as lastWeek, not thisWeek', async () => {
    // thisWeek is t > now - 7d (exclusive), lastWeek upper bound is t <= now - 7d
    // (inclusive), so the 7 day mark belongs to lastWeek.
    const r = await trends({ recent: [{ timestamp: iso(NOW - 7 * DAY) }] });
    assert.equal(r.payload.pageviews.thisWeek, 0);
    assert.equal(r.payload.pageviews.lastWeek, 1);
    // (0 - 1) / 1 * 100 = -100
    assert.equal(r.payload.pageviews.growth, -100);
  });

  it('counts an item exactly 14 days old as neither week', async () => {
    // lastWeek lower bound is t > now - 14d (exclusive), so the 14 day mark
    // falls outside both windows.
    const r = await trends({ recent: [{ timestamp: iso(NOW - 14 * DAY) }] });
    assert.equal(r.payload.pageviews.thisWeek, 0);
    assert.equal(r.payload.pageviews.lastWeek, 0);
    assert.equal(r.payload.pageviews.growth, 0);
  });

  it('skips items with missing, empty, or unparseable timestamps', async () => {
    const r = await trends({
      recent: [
        {},
        { timestamp: null },
        { timestamp: '' },
        { timestamp: 'not-a-real-date' },
        { timestamp: iso(NOW - 2 * DAY) }, // the only countable one
      ],
    });
    assert.equal(r.payload.pageviews.thisWeek, 1);
    assert.equal(r.payload.pageviews.lastWeek, 0);
  });
});

describe('GET /api/analytics/trends — pageview growth fallbacks', () => {
  it('returns 100 when the prior week is empty but this week has activity', async () => {
    const r = await trends({
      recent: [{ timestamp: iso(NOW - 1 * DAY) }, { timestamp: iso(NOW - 3 * DAY) }],
    });
    assert.equal(r.payload.pageviews.thisWeek, 2);
    assert.equal(r.payload.pageviews.lastWeek, 0);
    assert.equal(r.payload.pageviews.growth, 100);
  });

  it('returns 0 when both weeks are empty', async () => {
    const r = await trends({ recent: [] });
    assert.equal(r.payload.pageviews.thisWeek, 0);
    assert.equal(r.payload.pageviews.lastWeek, 0);
    assert.equal(r.payload.pageviews.growth, 0);
  });

  it('computes rounded percentage growth when the prior week is non-empty', async () => {
    const r = await trends({
      recent: [
        { timestamp: iso(NOW - 1 * DAY) },
        { timestamp: iso(NOW - 2 * DAY) },
        { timestamp: iso(NOW - 3 * DAY) },  // thisWeek = 3
        { timestamp: iso(NOW - 8 * DAY) },
        { timestamp: iso(NOW - 9 * DAY) },  // lastWeek = 2
      ],
    });
    // (3 - 2) / 2 * 100 = 50
    assert.equal(r.payload.pageviews.growth, 50);
  });

  it('rounds and reports negative growth when this week declined', async () => {
    const r = await trends({
      recent: [
        { timestamp: iso(NOW - 1 * DAY) },
        { timestamp: iso(NOW - 2 * DAY) },   // thisWeek = 2
        { timestamp: iso(NOW - 8 * DAY) },
        { timestamp: iso(NOW - 9 * DAY) },
        { timestamp: iso(NOW - 10 * DAY) },  // lastWeek = 3
      ],
    });
    // (2 - 3) / 3 * 100 = -33.33 -> -33
    assert.equal(r.payload.pageviews.growth, -33);
  });
});

describe('GET /api/analytics/trends — response shape', () => {
  it('returns the documented pageviews and period fields', async () => {
    const r = await trends({
      recent: [{ timestamp: iso(NOW - 1 * DAY) }],
      comments: {
        'content/a.md': [
          { createdAt: iso(NOW - 1 * DAY) },  // thisWeek
          { createdAt: iso(NOW - 8 * DAY) },  // lastWeek
        ],
        'content/b.md': [
          { createdAt: iso(NOW - 2 * DAY) },  // thisWeek
          {},                                 // no createdAt, skipped
        ],
        skip: 'not-an-array',                 // non-array value, skipped
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      pageviews: { thisWeek: 1, lastWeek: 0, growth: 100 },
      period: '7 days',
    });
  });
});
