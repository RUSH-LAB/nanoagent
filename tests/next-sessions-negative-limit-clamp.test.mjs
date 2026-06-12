import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

// Invoke GET /api/sessions with a mocked ctx and capture the json() response.
// The handler picks userId out of the store, lower- and upper-clamps the limit,
// slices to the most-recent window, and reverses it newest-first.
async function getSessions({ store, search = '' }) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-sessions-negative-limit-clamp-test',
    loadJSON: () => store,
    json: (_res, status, body) => { captured = { status, body }; return captured; },
  };
  const url = new URL(`http://localhost/api/sessions${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await feedsRoutes(req, res, url, '/api/sessions', ctx);
  return captured;
}

// A six-session history, oldest-first, with distinct ids so we can assert exactly
// which sessions (and in which order) the handler returns.
function sixSessions() {
  return {
    u: [
      { id: 's1', duration: 1, wordsWritten: 1 },
      { id: 's2', duration: 2, wordsWritten: 2 },
      { id: 's3', duration: 3, wordsWritten: 3 },
      { id: 's4', duration: 4, wordsWritten: 4 },
      { id: 's5', duration: 5, wordsWritten: 5 },
      { id: 's6', duration: 6, wordsWritten: 6 },
    ],
  };
}

describe('GET /api/sessions negative-limit lower clamp', () => {
  it('clamps a negative limit to the most-recent single session, reversed', async () => {
    // Before the clamp, limit=-2 made slice(-(-2)) === slice(2), which dropped the
    // first two sessions and returned [s6, s5, s4, s3] — a skipped, over-broad
    // window. The lower clamp turns any negative limit into 1.
    const r = await getSessions({ store: sixSessions(), search: '?userId=u&limit=-2' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sessions.map(s => s.id), ['s6']);
    assert.deepEqual(r.body.summary, {
      totalSessions: 1,
      totalMinutes: 6,
      totalWords: 6,
    });
  });

  it('clamps every negative magnitude to the same single most-recent session', async () => {
    for (const limit of [-1, -5, -100, -999]) {
      const r = await getSessions({ store: sixSessions(), search: `?userId=u&limit=${limit}` });
      assert.equal(r.status, 200, `limit=${limit} status`);
      // The magnitude no longer leaks into the slice: all collapse to the tail of one.
      assert.deepEqual(r.body.sessions.map(s => s.id), ['s6'], `limit=${limit} sessions`);
      assert.equal(r.body.summary.totalSessions, 1, `limit=${limit} totalSessions`);
    }
  });

  it('leaves a valid positive limit exactly as it is today', async () => {
    // limit=2 keeps the last two sessions (s5, s6), reversed newest-first.
    const r = await getSessions({ store: sixSessions(), search: '?userId=u&limit=2' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sessions.map(s => s.id), ['s6', 's5']);
    assert.deepEqual(r.body.summary, {
      totalSessions: 2,
      totalMinutes: 6 + 5,
      totalWords: 6 + 5,
    });
  });

  it('leaves the default (absent) limit exactly as it is today', async () => {
    // No limit param -> numericParam falls back to 20; the six-session history is
    // shorter than 20, so all six come back newest-first, unchanged by the clamp.
    const r = await getSessions({ store: sixSessions(), search: '?userId=u' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sessions.map(s => s.id), ['s6', 's5', 's4', 's3', 's2', 's1']);
    assert.deepEqual(r.body.summary, {
      totalSessions: 6,
      totalMinutes: 21,
      totalWords: 21,
    });
  });
});
