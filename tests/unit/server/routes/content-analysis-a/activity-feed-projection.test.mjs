import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module the way the sibling
// server route tests do. numericParam is required at the module top from
// ../server-utils, so it is part of the real module and is never stubbed here.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';
const COMMENTS_FILE = 'comments';
const ANNOTATIONS_FILE = 'annotations';
// The handler computes the reviews source path internally as
// path.join(PROJECT_ROOT, 'var', 'data', 'reviews.json'), so the loadJSON dispatcher
// keys the reviews fixture off this exact resolved path.
const REVIEWS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'reviews.json');

// Build a ctx whose loadJSON dispatches on the file token for the two stub
// paths and on the computed reviews path for the reviews source. Any source the
// caller omits falls back to an empty object, matching the handler's own
// `Object.entries(...)` and `reviewData.reviews || []` guards.
function makeCtx({ comments = {}, annotations = {}, reviews = {} } = {}) {
  return {
    path,
    PROJECT_ROOT,
    COMMENTS_FILE,
    ANNOTATIONS_FILE,
    loadJSON(file) {
      if (file === COMMENTS_FILE) return comments;
      if (file === ANNOTATIONS_FILE) return annotations;
      if (file === REVIEWS_FILE) return reviews;
      return {};
    },
  };
}

// Drive GET /api/activity-feed with no ?limit= (default 30, so events.slice(0, 30)
// is a no-op for these small fixtures) and capture json(res, status, payload). The
// default and negative-limit clamps are owned by the guard and negative-limit-clamp
// suites; this file pins only the projection shape and the cross-source sort.
async function feed(sources) {
  const url = new URL('http://localhost/api/activity-feed');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    ...makeCtx(sources),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/activity-feed', ctx);
  return captured;
}

describe('GET /api/activity-feed unified projection', () => {
  it('projects all three sources and descending-sorts them into one alternating golden feed', async () => {
    // Timestamps are chosen so the correct descending order alternates across the
    // three sources (review, comment, annotation, comment) and genuinely reorders
    // the handler's source-by-source insertion order.
    const r = await feed({
      comments: {
        'guide/intro.md': [
          { author: 'alice', text: 'First comment body', createdAt: '2024-05-04T10:00:00.000Z' },
          { author: 'bob', text: 'Older comment', createdAt: '2024-05-01T09:00:00.000Z' },
        ],
      },
      annotations: {
        'guide/intro.md': [
          { author: 'dave', text: 'An annotation', createdAt: '2024-05-02T12:00:00.000Z' },
        ],
      },
      reviews: {
        reviews: [
          { path: 'guide/intro.md', requestedBy: 'erin', status: 'pending', createdAt: '2024-05-05T08:00:00.000Z' },
        ],
      },
    });
    assert.equal(r.status, 200);
    // The review event carries path/status and author from r.requestedBy with no
    // preview; comment and annotation events carry preview and no status.
    assert.deepStrictEqual(r.payload, {
      events: [
        { type: 'review', path: 'guide/intro.md', author: 'erin', status: 'pending', timestamp: '2024-05-05T08:00:00.000Z' },
        { type: 'comment', page: 'guide/intro.md', author: 'alice', preview: 'First comment body', timestamp: '2024-05-04T10:00:00.000Z' },
        { type: 'annotation', page: 'guide/intro.md', author: 'dave', preview: 'An annotation', timestamp: '2024-05-02T12:00:00.000Z' },
        { type: 'comment', page: 'guide/intro.md', author: 'bob', preview: 'Older comment', timestamp: '2024-05-01T09:00:00.000Z' },
      ],
      total: 4,
    });
  });

  it('truncates a long preview to the first 80 characters while short text passes through whole', async () => {
    const longText =
      'This is a deliberately long comment body that runs well past the eighty character preview boundary and so it must be cut';
    const r = await feed({
      comments: {
        'notes.md': [
          { author: 'amy', text: longText, createdAt: '2024-06-02T00:00:00.000Z' },
          { author: 'amy', text: 'short note', createdAt: '2024-06-01T00:00:00.000Z' },
        ],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.events[0].preview.length, 80, 'long preview is cut to exactly 80 chars');
    assert.deepStrictEqual(r.payload, {
      events: [
        { type: 'comment', page: 'notes.md', author: 'amy', preview: longText.slice(0, 80), timestamp: '2024-06-02T00:00:00.000Z' },
        { type: 'comment', page: 'notes.md', author: 'amy', preview: 'short note', timestamp: '2024-06-01T00:00:00.000Z' },
      ],
      total: 2,
    });
  });

  it('skips non-array pages and a missing reviews key, and sorts a missing-timestamp event last', async () => {
    const r = await feed({
      comments: {
        'good.md': [
          { author: 'pat', text: 'has timestamp', createdAt: '2024-07-02T00:00:00.000Z' },
          { author: 'sam', text: 'no timestamp here' }, // missing createdAt -> timestamp: undefined
        ],
        'broken.md': 'not-an-array', // non-array page value contributes nothing
      },
      annotations: {
        'good.md': [
          { author: 'lee', text: 'annotation with ts', createdAt: '2024-07-03T00:00:00.000Z' },
        ],
      },
      reviews: {}, // no reviews key, so reviewData.reviews || [] contributes nothing
    });
    assert.equal(r.status, 200);
    // The missing-timestamp comment sorts last via (timestamp || ''); its timestamp
    // key is present with value undefined, exactly as the handler projects c.createdAt.
    assert.deepStrictEqual(r.payload, {
      events: [
        { type: 'annotation', page: 'good.md', author: 'lee', preview: 'annotation with ts', timestamp: '2024-07-03T00:00:00.000Z' },
        { type: 'comment', page: 'good.md', author: 'pat', preview: 'has timestamp', timestamp: '2024-07-02T00:00:00.000Z' },
        { type: 'comment', page: 'good.md', author: 'sam', preview: 'no timestamp here', timestamp: undefined },
      ],
      total: 3,
    });
  });

  it('returns an empty feed when every source is empty or its key is missing', async () => {
    const r = await feed({
      comments: {},
      annotations: {},
      reviews: { reviews: [] },
    });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, { events: [], total: 0 });
  });
});
