import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-a.js');

// Invoke a content-analysis-a route handler with a minimal mocked ctx and
// capture the response the handler hands to `json(res, status, payload)`.
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

describe('GET /api/activity-feed negative limit clamp', () => {
  // Five comment events and nothing else, so the merged feed has a known,
  // non-empty count. The feed builds `events.slice(0, limit)`, so a negative
  // limit must be lower-clamped to 0 (an empty page). Without the clamp,
  // `events.slice(0, -2)` would drop the last two events and return the first
  // three, while `total` still reported the full count.
  const EVENT_COUNT = 5;
  const comments = {
    page1: Array.from({ length: EVENT_COUNT }, (_, i) => ({
      author: 'a',
      text: 'hello',
      createdAt: `2024-01-01T00:00:0${i}.000Z`,
    })),
  };
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/activity-feed-neg-test',
    COMMENTS_FILE: 'comments',
    ANNOTATIONS_FILE: 'annotations',
    loadJSON(file) {
      if (file === 'comments') return comments;
      if (file === 'annotations') return {};
      return { reviews: [] }; // computed data/reviews.json path
    },
  };
  const callFeed = search => invoke({ pathname: '/api/activity-feed', search, ctx });

  it('negative limit yields an empty page, total still the full count', async () => {
    const r = await callFeed('?limit=-2');
    assert.equal(r.status, 200);
    assert.equal(r.payload.events.length, 0, 'clamped to 0, not a slice(0, -2) tail-drop');
    assert.equal(r.payload.total, EVENT_COUNT, 'total reports the full feed, unchanged');
  });

  it('valid positive limit is honored', async () => {
    const r = await callFeed('?limit=3');
    assert.equal(r.status, 200);
    assert.equal(r.payload.events.length, 3);
    assert.equal(r.payload.total, EVENT_COUNT);
  });

  it('absent limit returns the whole sub-default feed', async () => {
    const r = await callFeed('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.events.length, EVENT_COUNT);
    assert.equal(r.payload.total, EVENT_COUNT);
  });

  it('over-cap limit clamps to the cap and returns the whole feed', async () => {
    const r = await callFeed('?limit=200');
    assert.equal(r.status, 200);
    assert.equal(r.payload.events.length, EVENT_COUNT);
    assert.equal(r.payload.total, EVENT_COUNT);
  });
});
