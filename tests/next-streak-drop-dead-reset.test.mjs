import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// The GET /api/streak handler derives "today" and "yesterday" from the real
// clock, so build fixture dates relative to the same clock. dayOffset(0) is
// today, dayOffset(1) is yesterday, and so on, formatted exactly as the handler
// does (UTC, YYYY-MM-DD). Consecutive offsets always land on consecutive UTC
// days, so the handler's one-day adjacency check sees them as a contiguous run.
function dayOffset(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// Invoke GET /api/streak against an in-memory streak store and capture the
// json() response. For this path the handler reads only loadJSON, STREAKS_FILE,
// and json from ctx (no fs, path, or PROJECT_ROOT), so the mock stays minimal.
async function getStreak(store, userId) {
  const search = userId === undefined ? '' : `?userId=${encodeURIComponent(userId)}`;
  const url = new URL(`http://localhost/api/streak${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const STREAKS_FILE = '/fake/streaks.json';
  const ctx = {
    STREAKS_FILE,
    loadJSON: (file) => (file === STREAKS_FILE ? store : {}),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/streak', ctx);
  return captured;
}

describe('GET /api/streak streak computation', () => {
  it('computes an active current streak shorter than the longest run', async () => {
    // A log mixing qualifying days (50 words or more) with a sub-threshold day.
    // Ascending by date the run is 50, 50, 50, 50 (longest = 4), then a 30-word
    // day breaks it, then 80, 70, 60 ending today (current = 3). Entries are
    // supplied out of order to also exercise the handler's ascending sort.
    const store = {
      alice: {
        dailyLog: [
          { date: dayOffset(1), words: 70 },
          { date: dayOffset(7), words: 50 },
          { date: dayOffset(0), words: 60 },
          { date: dayOffset(4), words: 50 },
          { date: dayOffset(3), words: 30 },
          { date: dayOffset(5), words: 50 },
          { date: dayOffset(2), words: 80 },
          { date: dayOffset(6), words: 50 },
        ],
      },
    };
    const r = await getStreak(store, 'alice');
    assert.equal(r.status, 200);
    assert.equal(r.payload.currentStreak, 3);
    assert.equal(r.payload.longestStreak, 4);
    assert.equal(r.payload.totalWords, 440);
    // dailyLog is returned sorted ascending by date.
    const dates = r.payload.dailyLog.map((e) => e.date);
    assert.deepEqual(dates, [...dates].sort((a, b) => a.localeCompare(b)));
  });

  it('counts a current streak that ends yesterday', async () => {
    const store = {
      bob: {
        dailyLog: [
          { date: dayOffset(2), words: 50 },
          { date: dayOffset(1), words: 50 },
        ],
      },
    };
    const r = await getStreak(store, 'bob');
    assert.equal(r.status, 200);
    assert.equal(r.payload.currentStreak, 2);
    assert.equal(r.payload.longestStreak, 2);
    assert.equal(r.payload.totalWords, 100);
  });

  it('reports a zero current streak when the latest entry is stale', async () => {
    // Three qualifying days, but the most recent ends four days ago, so it is
    // neither today nor yesterday. This is the path that relies on currentStreak
    // starting at 0: the backward loop breaks on its first iteration without ever
    // incrementing, so the initializer value is exactly what reaches the payload.
    const store = {
      carol: {
        dailyLog: [
          { date: dayOffset(6), words: 60 },
          { date: dayOffset(5), words: 70 },
          { date: dayOffset(4), words: 80 },
        ],
      },
    };
    const r = await getStreak(store, 'carol');
    assert.equal(r.status, 200);
    assert.equal(r.payload.currentStreak, 0);
    assert.equal(r.payload.longestStreak, 3);
    assert.equal(r.payload.totalWords, 210);
  });

  it('breaks both the current and longest streak on a date gap', async () => {
    // The two most recent qualifying days skip a calendar day (today and two days
    // ago, with the day between missing). The backward current-streak loop enforces
    // one-day adjacency, so it stops at the gap and reports 1. The forward
    // longest-streak loop now applies the same calendar adjacency check, so the run
    // of three qualifying entries splits at the gap into a two-day run (three and
    // two days ago) followed by an isolated day today, giving a longest of 2.
    const store = {
      erin: {
        dailyLog: [
          { date: dayOffset(3), words: 60 },
          { date: dayOffset(2), words: 60 },
          { date: dayOffset(0), words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'erin');
    assert.equal(r.status, 200);
    assert.equal(r.payload.currentStreak, 1);
    assert.equal(r.payload.longestStreak, 2);
    assert.equal(r.payload.totalWords, 180);
  });

  it('returns an all-zero payload for an empty log', async () => {
    const store = { dave: { dailyLog: [] } };
    const r = await getStreak(store, 'dave');
    assert.equal(r.status, 200);
    assert.equal(r.payload.currentStreak, 0);
    assert.equal(r.payload.longestStreak, 0);
    assert.equal(r.payload.totalWords, 0);
    assert.deepEqual(r.payload.dailyLog, []);
  });

  it('treats an unknown user as an empty log', async () => {
    const r = await getStreak({}, 'nobody');
    assert.equal(r.status, 200);
    assert.equal(r.payload.currentStreak, 0);
    assert.equal(r.payload.longestStreak, 0);
    assert.equal(r.payload.totalWords, 0);
    assert.deepEqual(r.payload.dailyLog, []);
  });

  it('falls back to the default user when no userId is provided', async () => {
    const store = { default: { dailyLog: [{ date: dayOffset(0), words: 60 }] } };
    const r = await getStreak(store);
    assert.equal(r.status, 200);
    assert.equal(r.payload.currentStreak, 1);
    assert.equal(r.payload.longestStreak, 1);
    assert.equal(r.payload.totalWords, 60);
  });
});
