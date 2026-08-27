import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// content-analysis-c.js is CommonJS; load it via createRequire the way the sibling
// route suites do (next-filehealth-fmbody / next-citgraph-refkey). This suite pins
// the per-page engagement scoring of GET /api/content-engagement after the handler
// binds each loop's path once (`const bp = b.path` in the bookmark loop, `const ip =
// item.path` in the reading-list inner loop) and reuses that binding for the key
// check, the lazy entry creation, and the counter bump. The fixtures repeat paths
// across the bookmark and reading-list loops and introduce paths that first appear
// inside each loop, so a crossed reuse (bp vs ip) or an object hoist past the
// `if (!pageScores[key])` guard would change a count and fail.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

// The handler resolves its four inputs through ctx.loadJSON keyed by these file
// constants, so the mock dispatches on the constant rather than touching fs.
const ANALYTICS_FILE = 'analytics.json';
const COMMENTS_FILE = 'comments.json';
const BOOKMARKS_FILE = 'bookmarks.json';
const READING_LISTS_FILE = 'reading-lists.json';

// Drive the real GET /api/content-engagement handler over a mocked ctx and capture
// what json(res, status, payload) writes. loadJSON serves the fixture for a known
// file constant and {} otherwise, mirroring loadJSON's missing-file fallback so the
// `analytics.counts || {}`, `bookmarks.bookmarks || []`, and `readingLists.lists ||
// []` guards are exercised. cached is a pass-through (this route keeps no result
// memo, but the sibling suites pass one for parity).
async function engagementOf(data) {
  const store = new Map(Object.entries(data));
  let captured = null;
  const ctx = {
    json(_res, status, payload) { captured = { status, payload }; return captured; },
    loadJSON: (file) => (store.has(file) ? store.get(file) : {}),
    cached: (_key, _ttl, fn) => fn(),
    ANALYTICS_FILE, COMMENTS_FILE, BOOKMARKS_FILE, READING_LISTS_FILE,
  };
  const pathname = '/api/content-engagement';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// ── Fixtures ──
//
// `/page-a` appears in all four sources, is bookmarked twice, and is listed in two
// reading lists, so its bookmarks (2) and readingLists (2) counts only stay correct
// if each loop iteration reads its path once and bumps the right counter. `/page-b`
// is viewed and listed once. `/page-c` is comment only. `/page-d` first appears in
// the bookmark loop and `/page-e` first appears in the reading-list loop, so each
// exercises the lazy `if (!pageScores[key])` entry creation inside its loop.
//
// Score = views * 1 + comments * 5 + bookmarks * 10 + readingLists * 3:
//   /page-a 100 + 2*5 + 2*10 + 2*3 = 136
//   /page-b  50 + 0   + 0    + 1*3 = 53
//   /page-d   0 + 0   + 1*10 + 0   = 10
//   /page-c   0 + 1*5 + 0    + 0   = 5
//   /page-e   0 + 0   + 0    + 1*3 = 3
// and the response is sorted by engagementScore descending.
const FULL = {
  [ANALYTICS_FILE]: { counts: { '/page-a': 100, '/page-b': 50 } },
  [COMMENTS_FILE]: { '/page-a': [{}, {}], '/page-c': [{}] },
  [BOOKMARKS_FILE]: { bookmarks: [{ path: '/page-a' }, { path: '/page-a' }, { path: '/page-d' }] },
  [READING_LISTS_FILE]: {
    lists: [
      { items: [{ path: '/page-a' }, { path: '/page-b' }] },
      { items: [{ path: '/page-a' }, { path: '/page-e' }] },
    ],
  },
};
const FULL_EXPECTED = {
  pages: [
    { page: '/page-a', views: 100, comments: 2, bookmarks: 2, readingLists: 2, engagementScore: 136 },
    { page: '/page-b', views: 50, comments: 0, bookmarks: 0, readingLists: 1, engagementScore: 53 },
    { page: '/page-d', views: 0, comments: 0, bookmarks: 1, readingLists: 0, engagementScore: 10 },
    { page: '/page-c', views: 0, comments: 1, bookmarks: 0, readingLists: 0, engagementScore: 5 },
    { page: '/page-e', views: 0, comments: 0, bookmarks: 0, readingLists: 1, engagementScore: 3 },
  ],
  total: 5,
};

describe('GET /api/content-engagement scores reuse the bound bp / ip path keys', () => {
  it('aggregates views, comments, bookmarks, and reading-list memberships across overlapping paths', async () => {
    const r = await engagementOf(FULL);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, FULL_EXPECTED);
    // Pin field order too: the response objects are `{page, ...data, engagementScore}`.
    assert.equal(JSON.stringify(r.payload), JSON.stringify(FULL_EXPECTED));
  });

  it('counts the same path bookmarked twice and listed in two reading lists', async () => {
    const r = await engagementOf(FULL);
    const a = r.payload.pages.find((p) => p.page === '/page-a');
    assert.deepEqual(a, { page: '/page-a', views: 100, comments: 2, bookmarks: 2, readingLists: 2, engagementScore: 136 });
  });

  it('creates a fresh entry for a path first seen in the bookmark loop', async () => {
    // No analytics or comments seed this path, so the entry must be created inside
    // the bookmark loop. A premature `pageScores[bp]` bind before the guard would
    // capture undefined and throw on `.bookmarks++`.
    const r = await engagementOf({ [BOOKMARKS_FILE]: { bookmarks: [{ path: '/fresh-bm' }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      pages: [{ page: '/fresh-bm', views: 0, comments: 0, bookmarks: 1, readingLists: 0, engagementScore: 10 }],
      total: 1,
    });
  });

  it('creates a fresh entry for a path first seen in the reading-list loop', async () => {
    const r = await engagementOf({ [READING_LISTS_FILE]: { lists: [{ items: [{ path: '/fresh-rl' }] }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      pages: [{ page: '/fresh-rl', views: 0, comments: 0, bookmarks: 0, readingLists: 1, engagementScore: 3 }],
      total: 1,
    });
  });

  it('returns an empty ranking when every data file is missing', async () => {
    const r = await engagementOf({});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { pages: [], total: 0 });
  });
});
