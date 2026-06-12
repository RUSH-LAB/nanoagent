import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

// Invoke GET /api/sessions with a mocked ctx and capture the json() response.
// loadJSON returns the whole sessions store; the handler picks userId out of it,
// slices to the limit, reverses, and folds the per-session totals in one pass.
async function getSessions({ store, search = '' }) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-sessions-single-pass-summary-test',
    loadJSON: () => store,
    json: (_res, status, body) => { captured = { status, body }; return captured; },
  };
  const url = new URL(`http://localhost/api/sessions${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await feedsRoutes(req, res, url, '/api/sessions', ctx);
  return captured;
}

describe('GET /api/sessions single-pass summary', () => {
  it('sums duration and wordsWritten across the page and returns the exact shape', async () => {
    const store = {
      u: [
        { duration: 30, wordsWritten: 100 },
        { duration: 45, wordsWritten: 250 },
        { duration: 15, wordsWritten: 50 },
      ],
    };
    const r = await getSessions({ store, search: '?userId=u' });
    assert.equal(r.status, 200);
    // Pin the full response shape so the loop fusion cannot drift the contract.
    assert.deepEqual(Object.keys(r.body), ['sessions', 'summary']);
    assert.deepEqual(Object.keys(r.body.summary), ['totalSessions', 'totalMinutes', 'totalWords']);
    assert.deepEqual(r.body.summary, {
      totalSessions: 3,
      totalMinutes: 30 + 45 + 15,
      totalWords: 100 + 250 + 50,
    });
    // sessions are returned newest-first (slice(-limit).reverse()).
    assert.equal(r.body.sessions.length, 3);
    assert.equal(r.body.sessions[0].wordsWritten, 50);
  });

  it('applies the || 0 fallback when duration or wordsWritten is missing', async () => {
    const store = {
      u: [
        { duration: 20, wordsWritten: 80 },
        { wordsWritten: 50 }, // missing duration -> contributes 0 minutes
        { duration: 15 },     // missing wordsWritten -> contributes 0 words
        {},                   // missing both -> contributes 0, 0
      ],
    };
    const r = await getSessions({ store, search: '?userId=u' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.summary, {
      totalSessions: 4,
      totalMinutes: 20 + 0 + 15 + 0,
      totalWords: 80 + 50 + 0 + 0,
    });
  });

  it('treats falsy duration / wordsWritten (0, undefined) as 0 without NaN', async () => {
    const store = {
      u: [
        { duration: 0, wordsWritten: 0 },
        { duration: undefined, wordsWritten: undefined },
        { duration: 10, wordsWritten: 5 },
      ],
    };
    const r = await getSessions({ store, search: '?userId=u' });
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.totalMinutes, 10);
    assert.equal(r.body.summary.totalWords, 5);
    assert.ok(!Number.isNaN(r.body.summary.totalMinutes), 'totalMinutes is never NaN');
    assert.ok(!Number.isNaN(r.body.summary.totalWords), 'totalWords is never NaN');
  });

  it('summarizes only the limited page, not the whole history', async () => {
    const store = {
      u: [
        { duration: 1, wordsWritten: 1 },
        { duration: 2, wordsWritten: 2 },
        { duration: 3, wordsWritten: 3 },
        { duration: 4, wordsWritten: 4 },
      ],
    };
    // limit=2 keeps the last two (duration 3 and 4), reversed to [4, 3].
    const r = await getSessions({ store, search: '?userId=u&limit=2' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.summary, {
      totalSessions: 2,
      totalMinutes: 3 + 4,
      totalWords: 3 + 4,
    });
    assert.deepEqual(r.body.sessions.map(s => s.duration), [4, 3]);
  });

  it('returns all-zero totals for an absent user', async () => {
    const r = await getSessions({ store: {}, search: '?userId=ghost' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      sessions: [],
      summary: { totalSessions: 0, totalMinutes: 0, totalWords: 0 },
    });
  });
});
