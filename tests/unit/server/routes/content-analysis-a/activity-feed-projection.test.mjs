import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module the way the sibling
// server route tests do. numericParam is required at the module top from
// ../server-utils, so it is part of the real module and is never stubbed here.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';
// The handler computes the reviews source path internally as
// path.join(PROJECT_ROOT, 'var', 'data', 'reviews.json'), so the loadJSON dispatcher
// keys the reviews fixture off this exact resolved path.
const REVIEWS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'reviews.json');

// Reviews are the feed's only source. Anything else loadJSON is asked for falls
// back to an empty object, matching the handler's `reviewData.reviews || []`
// guard.
function makeCtx(reviews = {}) {
  return {
    path,
    PROJECT_ROOT,
    loadJSON: (file) => (file === REVIEWS_FILE ? reviews : {}),
  };
}

// Drive GET /api/activity-feed with no ?limit= (default 30, so events.slice(0, 30)
// is a no-op for these small fixtures) and capture json(res, status, payload). The
// default and negative-limit clamps are owned by the guard and negative-limit-clamp
// suites; this file pins only the projection shape and the sort.
async function feed(reviews) {
  const url = new URL('http://localhost/api/activity-feed');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    ...makeCtx(reviews),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/activity-feed', ctx);
  return captured;
}

describe('GET /api/activity-feed projection', () => {
  it('projects review events and descending-sorts them', async () => {
    // Fixture order is ascending so a correct sort has to reverse it.
    const r = await feed({
      reviews: [
        { path: 'guide/old.md', requestedBy: 'bob', status: 'done', createdAt: '2024-05-01T09:00:00.000Z' },
        { path: 'guide/intro.md', requestedBy: 'erin', status: 'pending', createdAt: '2024-05-05T08:00:00.000Z' },
      ],
    });
    assert.equal(r.status, 200);
    // A review event carries path and status, and takes its author from
    // requestedBy. It has no preview field.
    assert.deepStrictEqual(r.payload, {
      events: [
        { type: 'review', path: 'guide/intro.md', author: 'erin', status: 'pending', timestamp: '2024-05-05T08:00:00.000Z' },
        { type: 'review', path: 'guide/old.md', author: 'bob', status: 'done', timestamp: '2024-05-01T09:00:00.000Z' },
      ],
      total: 2,
    });
  });

  it('sorts a missing-timestamp event last via the (timestamp || empty) fallback', async () => {
    const r = await feed({
      reviews: [
        { path: 'a.md', requestedBy: 'pat', status: 'pending' }, // no createdAt
        { path: 'b.md', requestedBy: 'sam', status: 'done', createdAt: '2024-07-02T00:00:00.000Z' },
      ],
    });
    assert.equal(r.status, 200);
    // The timestamp key is present with value undefined, exactly as the handler
    // projects r.createdAt.
    assert.deepStrictEqual(r.payload, {
      events: [
        { type: 'review', path: 'b.md', author: 'sam', status: 'done', timestamp: '2024-07-02T00:00:00.000Z' },
        { type: 'review', path: 'a.md', author: 'pat', status: 'pending', timestamp: undefined },
      ],
      total: 2,
    });
  });

  it('returns an empty feed when the reviews key is missing', async () => {
    const r = await feed({});
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, { events: [], total: 0 });
  });

  it('returns an empty feed when the reviews list is empty', async () => {
    const r = await feed({ reviews: [] });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, { events: [], total: 0 });
  });
});
