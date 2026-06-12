import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

// Invoke the GET /api/schedule handler with a mocked ctx. `stored` is the whole
// schedule file; the handler reads it via loadJSON, promotes any scheduled item
// whose publishAt has already passed to `due`, then tallies the `upcoming` and
// `due` buckets in one pass. json() records the response. No network, no files.
async function invokeSchedule(stored) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-feeds-fold-schedule-test',
    loadJSON: () => stored,
    json: (_res, status, body) => { captured = { status, body }; return captured; },
  };
  const url = new URL('http://localhost/api/schedule');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await feedsRoutes(req, res, url, '/api/schedule', ctx);
  return captured;
}

describe('GET /api/schedule folds the two status-count filters into one pass', () => {
  // A fixture mixing every status path the count loop can take. Far-future and
  // far-past publishAt values keep the promotion deterministic regardless of the
  // wall clock:
  //   scheduled + future publishAt   -> stays scheduled -> upcoming : future-1, future-2
  //   scheduled + past publishAt     -> promoted to due  -> due      : past-due
  //   due (already)                  -> stays due        -> due      : already-due
  //   published / draft / archived   -> counted in neither          : published, draft, archived
  // The archived row carries an arbitrary status outside {scheduled, due}, so it
  // locks in that the else-if tallies those two buckets and ignores all others.
  // Expected: upcoming = 2, due = 2, with all 7 items returned.
  const makeItems = () => [
    { id: 's1', path: 'content/future-1.md',    publishAt: '2999-01-01T00:00:00.000Z', status: 'scheduled' },
    { id: 's2', path: 'content/future-2.md',    publishAt: '2999-02-01T00:00:00.000Z', status: 'scheduled' },
    { id: 's3', path: 'content/past-due.md',    publishAt: '2000-01-01T00:00:00.000Z', status: 'scheduled' },
    { id: 'd1', path: 'content/already-due.md', publishAt: '2000-02-01T00:00:00.000Z', status: 'due' },
    { id: 'p1', path: 'content/published.md',   publishAt: '2000-03-01T00:00:00.000Z', status: 'published' },
    { id: 'r1', path: 'content/draft.md',       publishAt: '2999-03-01T00:00:00.000Z', status: 'draft' },
    { id: 'a1', path: 'content/archived.md',    publishAt: '2999-04-01T00:00:00.000Z', status: 'archived' },
  ];

  it('counts upcoming and due to the known totals, ignoring other statuses', async () => {
    const r = await invokeSchedule({ items: makeItems() });
    assert.equal(r.status, 200);

    // The two folded counts equal the known bucket sizes: two future-dated
    // scheduled items stay upcoming; the promoted past item plus the already due
    // item make two due. The published, draft, and archived items count in neither.
    assert.equal(r.body.upcoming, 2, 'two future-dated scheduled items are upcoming');
    assert.equal(r.body.due, 2, 'one promoted item plus one already-due item are due');

    // Response shape is exactly the prior {items, upcoming, due}, with every
    // item preserved (none dropped by the fold).
    assert.deepEqual(Object.keys(r.body).sort(), ['due', 'items', 'upcoming']);
    assert.equal(r.body.items.length, 7, 'all items returned, none dropped');

    // The promotion still flips the past-dated scheduled item to due while the
    // other statuses are left untouched; items come back sorted by publishAt.
    assert.deepEqual(
      r.body.items.map(i => [i.path, i.status]),
      [
        ['content/past-due.md', 'due'],
        ['content/already-due.md', 'due'],
        ['content/published.md', 'published'],
        ['content/future-1.md', 'scheduled'],
        ['content/future-2.md', 'scheduled'],
        ['content/draft.md', 'draft'],
        ['content/archived.md', 'archived'],
      ],
      'past-dated scheduled item promoted to due; others unchanged; sorted by publishAt',
    );
  });

  it('reports zero upcoming and due when the items list is empty', async () => {
    const r = await invokeSchedule({ items: [] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { items: [], upcoming: 0, due: 0 });
  });

  it('treats a schedule file with no items key as an empty list', async () => {
    const r = await invokeSchedule({});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { items: [], upcoming: 0, due: 0 });
  });
});
