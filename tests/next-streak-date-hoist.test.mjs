import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// The GET /api/streak handler derives "today" and "yesterday" from the real
// clock, so build the live-clock fixtures relative to that same clock.
// dayOffset(0) is today, dayOffset(1) is yesterday, and so on, formatted exactly
// as the handler does (UTC, YYYY-MM-DD). Consecutive offsets always land on
// consecutive UTC days, so the handler's one-day adjacency check sees them as a
// contiguous run.
function dayOffset(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// Invoke GET /api/streak against an in-memory streak store and capture the
// json() response. For this path the handler reads only loadJSON, STREAKS_FILE,
// and json from ctx (no fs, path, or PROJECT_ROOT), so the mock stays minimal,
// matching the sibling streak tests.
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

// This stream hoisted the per-entry date parse out of both streak loops: instead
// of calling new Date(entry.date) up to four times per entry, the handler now
// precomputes one epoch-ms array via Date.parse and does numeric day-diff math.
// For YYYY-MM-DD strings Date.parse(s) equals new Date(s).getTime() and Date
// subtraction uses getTime, so the whole {currentStreak, longestStreak,
// totalWords, dailyLog} payload must stay byte-identical. Each case below pins
// the entire payload with a deep-equal so any drift in the hoist is caught.
describe('GET /api/streak epoch precompute is behavior-preserving', () => {
  it('keeps a consecutive multi-day run (>=50 words each) intact', async () => {
    // Three back-to-back qualifying days, supplied out of order to also exercise
    // the ascending sort. Every step is a one-day gap, so the longest run is 3.
    const store = {
      alice: {
        dailyLog: [
          { date: '2024-04-02', words: 60 },
          { date: '2024-04-01', words: 55 },
          { date: '2024-04-03', words: 65 },
        ],
      },
    };
    const r = await getStreak(store, 'alice');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      currentStreak: 0, // fixed past dates: the untouched current-streak loop breaks at once
      longestStreak: 3,
      totalWords: 180,
      dailyLog: [
        { date: '2024-04-01', words: 55 },
        { date: '2024-04-02', words: 60 },
        { date: '2024-04-03', words: 65 },
      ],
    });
  });

  it('restarts the run at a one-day-plus gap', async () => {
    // Two adjacent qualifying days then an isolated one three days later. The gap
    // resets the running streak, so the longest is the two-day sub-run, not 3.
    const store = {
      gwen: {
        dailyLog: [
          { date: '2024-06-02', words: 50 },
          { date: '2024-06-01', words: 50 },
          { date: '2024-06-05', words: 50 },
        ],
      },
    };
    const r = await getStreak(store, 'gwen');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      currentStreak: 0,
      longestStreak: 2,
      totalWords: 150,
      dailyLog: [
        { date: '2024-06-01', words: 50 },
        { date: '2024-06-02', words: 50 },
        { date: '2024-06-05', words: 50 },
      ],
    });
  });

  it('treats a duplicate date as a zero-day gap that breaks the run', async () => {
    // A duplicate qualifying day is a zero-day gap (diffDays === 0), so the run
    // cannot extend across it. The longest run is the two-day window that the
    // duplicate splits, never the four-entry count.
    const store = {
      hank: {
        dailyLog: [
          { date: '2024-07-01', words: 60 },
          { date: '2024-07-02', words: 60 },
          { date: '2024-07-02', words: 60 },
          { date: '2024-07-03', words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'hank');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      currentStreak: 0,
      longestStreak: 2,
      totalWords: 240,
      dailyLog: [
        { date: '2024-07-01', words: 60 },
        { date: '2024-07-02', words: 60 },
        { date: '2024-07-02', words: 60 },
        { date: '2024-07-03', words: 60 },
      ],
    });
  });

  it('resets the run on a sub-50-word day and credits the longer rebuild', async () => {
    // A two-day run, then a 30-word day clears the streak and the prev-day epoch,
    // then a fresh three-day run. The reset must mirror the former
    // prevStreakDate = null exactly, so the longest is the later three-day run.
    const store = {
      ivan: {
        dailyLog: [
          { date: '2024-08-01', words: 60 },
          { date: '2024-08-02', words: 60 },
          { date: '2024-08-03', words: 30 },
          { date: '2024-08-04', words: 60 },
          { date: '2024-08-05', words: 60 },
          { date: '2024-08-06', words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'ivan');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      currentStreak: 0,
      longestStreak: 3,
      totalWords: 330,
      dailyLog: [
        { date: '2024-08-01', words: 60 },
        { date: '2024-08-02', words: 60 },
        { date: '2024-08-03', words: 30 },
        { date: '2024-08-04', words: 60 },
        { date: '2024-08-05', words: 60 },
        { date: '2024-08-06', words: 60 },
      ],
    });
  });

  it('counts a current streak that ends today', async () => {
    // Latest entry is today and the three days are consecutive, so the
    // current-streak loop walks the full run via the cached epoch diffs.
    const d2 = dayOffset(2);
    const d1 = dayOffset(1);
    const d0 = dayOffset(0);
    const store = {
      kara: {
        dailyLog: [
          { date: d2, words: 60 },
          { date: d1, words: 60 },
          { date: d0, words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'kara');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      currentStreak: 3,
      longestStreak: 3,
      totalWords: 180,
      dailyLog: [
        { date: d2, words: 60 },
        { date: d1, words: 60 },
        { date: d0, words: 60 },
      ],
    });
  });

  it('counts a current streak that ends yesterday', async () => {
    // Latest entry is yesterday (still inside the today-or-yesterday window).
    const d2 = dayOffset(2);
    const d1 = dayOffset(1);
    const store = {
      liam: {
        dailyLog: [
          { date: d2, words: 60 },
          { date: d1, words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'liam');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      currentStreak: 2,
      longestStreak: 2,
      totalWords: 120,
      dailyLog: [
        { date: d2, words: 60 },
        { date: d1, words: 60 },
      ],
    });
  });

  it('reports a zero current streak when the latest entry is older than yesterday', async () => {
    // Latest entry is three days ago, so it is neither today nor yesterday and the
    // backward loop breaks on its first iteration, leaving currentStreak at 0.
    const d5 = dayOffset(5);
    const d4 = dayOffset(4);
    const d3 = dayOffset(3);
    const store = {
      mona: {
        dailyLog: [
          { date: d5, words: 60 },
          { date: d4, words: 60 },
          { date: d3, words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'mona');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      currentStreak: 0,
      longestStreak: 3,
      totalWords: 180,
      dailyLog: [
        { date: d5, words: 60 },
        { date: d4, words: 60 },
        { date: d3, words: 60 },
      ],
    });
  });

  it('breaks the current streak at a gap even when the latest entry is today', async () => {
    // Today qualifies, but the day before it is missing, so the current-streak
    // loop stops at the gap (numeric diff !== 1) and reports 1 while the longest
    // run is the earlier two-day window.
    const d3 = dayOffset(3);
    const d2 = dayOffset(2);
    const d0 = dayOffset(0);
    const store = {
      nora: {
        dailyLog: [
          { date: d3, words: 60 },
          { date: d2, words: 60 },
          { date: d0, words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'nora');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      currentStreak: 1,
      longestStreak: 2,
      totalWords: 180,
      dailyLog: [
        { date: d3, words: 60 },
        { date: d2, words: 60 },
        { date: d0, words: 60 },
      ],
    });
  });
});
