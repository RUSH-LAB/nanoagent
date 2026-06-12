import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

// Invoke GET /api/sessions with a mocked ctx and capture the json() response.
// loadJSON returns the supplied store verbatim: a plain object literal, so
// inherited keys like constructor and toString resolve to truthy values exactly
// as they would on the real loadJSON result. The read path never writes, so
// saveJSON is unneeded.
async function getSessions({ store, search = '' }) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-sessions-protokey-guard-test',
    loadJSON: () => store,
    json: (_res, status, body) => { captured = { status, body }; return captured; },
  };
  const url = new URL(`http://localhost/api/sessions${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await feedsRoutes(req, res, url, '/api/sessions', ctx);
  return captured;
}

// A two-session history for a real own-key user, oldest-first, with distinct ids
// so we can assert exactly which sessions (and in which order) come back.
function realStore() {
  return {
    alice: [
      { id: 's1', duration: 10, wordsWritten: 100 },
      { id: 's2', duration: 20, wordsWritten: 200 },
    ],
  };
}

const ZERO_SUMMARY = { totalSessions: 0, totalMinutes: 0, totalWords: 0 };

describe('GET /api/sessions own-property guard on userId', () => {
  // `__proto__`, `constructor`, and `toString` all resolve to truthy inherited
  // values on a plain object literal. Without the Object.hasOwn guard,
  // `(sessions[userId] || [])` skips the `[]` fallback and calls `.slice` on a
  // function, throwing an unhandled TypeError that hangs the request until the
  // socket timeout. The guard returns the empty default instead.
  for (const userId of ['__proto__', 'constructor', 'toString']) {
    it(`returns 200 with an empty list and zeroed summary for inherited key "${userId}"`, async () => {
      const r = await getSessions({ store: realStore(), search: `?userId=${encodeURIComponent(userId)}` });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.sessions, []);
      assert.deepEqual(r.body.summary, ZERO_SUMMARY);
    });
  }

  it('returns the sessions and summary totals for a real own-key user', async () => {
    // Own key -> Object.hasOwn is true, so the lookup is byte-identical to before:
    // both sessions come back newest-first with their totals summed.
    const r = await getSessions({ store: realStore(), search: '?userId=alice' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sessions.map(s => s.id), ['s2', 's1']);
    assert.deepEqual(r.body.summary, {
      totalSessions: 2,
      totalMinutes: 30,
      totalWords: 300,
    });
  });

  it('returns an empty list and zeroed summary for an absent ordinary id', async () => {
    // A non-own ordinary key keeps the same empty default it returned before.
    const r = await getSessions({ store: realStore(), search: '?userId=nobody' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sessions, []);
    assert.deepEqual(r.body.summary, ZERO_SUMMARY);
  });
});
