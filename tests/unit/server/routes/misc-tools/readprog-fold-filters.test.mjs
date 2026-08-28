import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../src/server/routes/misc-tools.js');

// Invoke the GET /api/reading-progress handler with a mocked ctx. `stored` is the
// whole reading-progress file (keyed by userId); the handler reads it via loadJSON
// and reports per-user counts. json() records the response the handler sends.
async function invokeReadingProgress({ userId, stored }) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-readprog-fold-filters-test',
    loadJSON: () => stored,
    json: (_res, status, body) => { captured = { status, body }; return captured; },
  };
  const search = userId === undefined ? '' : `?userId=${encodeURIComponent(userId)}`;
  const url = new URL(`http://localhost/api/reading-progress${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await miscToolsRoutes(req, res, url, '/api/reading-progress', ctx);
  return captured;
}

describe('GET /api/reading-progress folds the two filter passes into one loop', () => {
  // A fixture mixing every progress category, with lastRead timestamps that
  // interleave completed and partial pages so the ordering assertion proves the
  // sort is by lastRead (descending), not by progress. The over-100 row guards
  // the `>= 100` (not `== 100`) read semantics for externally seeded data, since
  // the GET handler reads the file directly rather than only writer output.
  //   completed (>= 100): over, done-1, done-2     -> totalRead = 3
  //   partial (0 < p < 100): partial-1, partial-2  -> inProgress = 2
  //   zero (progress 0): zero                       -> counted in neither
  //   absent (no progress field): absent            -> counted in neither
  //   totalTracked = 7 (every tracked page)
  const stored = {
    reader: {
      'content/over.md':      { progress: 120, lastRead: '2026-01-07T00:00:00.000Z' },
      'content/done-1.md':    { progress: 100, lastRead: '2026-01-06T00:00:00.000Z' },
      'content/partial-1.md': { progress: 75,  lastRead: '2026-01-05T00:00:00.000Z' },
      'content/done-2.md':    { progress: 100, lastRead: '2026-01-04T00:00:00.000Z' },
      'content/zero.md':      { progress: 0,   lastRead: '2026-01-03T00:00:00.000Z' },
      'content/partial-2.md': { progress: 1,   lastRead: '2026-01-02T00:00:00.000Z' },
      'content/absent.md':    { lastRead: '2026-01-01T00:00:00.000Z' },
    },
  };

  it('counts completed and in-progress pages while preserving order and totals', async () => {
    const r = await invokeReadingProgress({ userId: 'reader', stored });
    assert.equal(r.status, 200);

    // Completed pages (progress >= 100, including the over-100 row); the
    // progress-0 and absent pages, and the in-progress pages, are excluded.
    assert.equal(r.body.totalRead, 3, 'the two progress-100 pages and the over-100 page count as read');
    // In-progress pages (0 < progress < 100); progress 1 is the lower boundary,
    // progress 0 and absent are excluded.
    assert.equal(r.body.inProgress, 2, 'only the two partial pages count as in progress');
    // Every tracked page is counted regardless of progress value.
    assert.equal(r.body.totalTracked, 7, 'every tracked page is counted');

    // Pages are returned newest-first by lastRead, with completed and partial
    // pages interleaved (a count-grouped order would not produce this sequence).
    assert.deepEqual(
      r.body.pages.map(p => p.pagePath),
      [
        'content/over.md',
        'content/done-1.md',
        'content/partial-1.md',
        'content/done-2.md',
        'content/zero.md',
        'content/partial-2.md',
        'content/absent.md',
      ],
      'pages ordered by lastRead descending',
    );

    // The page objects carry pagePath plus the stored fields unchanged; the
    // absent-progress page has no progress key.
    assert.deepEqual(r.body.pages, [
      { pagePath: 'content/over.md',      progress: 120, lastRead: '2026-01-07T00:00:00.000Z' },
      { pagePath: 'content/done-1.md',    progress: 100, lastRead: '2026-01-06T00:00:00.000Z' },
      { pagePath: 'content/partial-1.md', progress: 75,  lastRead: '2026-01-05T00:00:00.000Z' },
      { pagePath: 'content/done-2.md',    progress: 100, lastRead: '2026-01-04T00:00:00.000Z' },
      { pagePath: 'content/zero.md',      progress: 0,   lastRead: '2026-01-03T00:00:00.000Z' },
      { pagePath: 'content/partial-2.md', progress: 1,   lastRead: '2026-01-02T00:00:00.000Z' },
      { pagePath: 'content/absent.md',    lastRead: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('reports zeroes for a user with no tracked pages', async () => {
    const r = await invokeReadingProgress({ userId: 'stranger', stored });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { pages: [], totalRead: 0, inProgress: 0, totalTracked: 0 });
  });

  it('rejects a request with no userId', async () => {
    const r = await invokeReadingProgress({ stored });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'Missing userId' });
  });
});
