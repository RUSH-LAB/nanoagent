import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// Build a date offset from the real clock the way the handler does (UTC,
// YYYY-MM-DD). dayOffset(0) is today, dayOffset(1) is yesterday, and so on.
// Used only by the case that exercises the live currentStreak path.
function dayOffset(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// Invoke GET /api/streak against an in-memory streak store and capture the
// json() response. For this path the handler reads only loadJSON, STREAKS_FILE,
// and json from ctx, so the mock stays minimal (matching the sibling streak test).
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

// longestStreak counts the longest run of consecutive calendar DAYS with at
// least 50 words, not the longest run of consecutive qualifying ENTRIES. The
// fixed-date fixtures below sit in the past, so the untouched currentStreak loop
// reports 0 for them; asserting that 0 confirms the fix left currentStreak alone.
describe('GET /api/streak longestStreak counts consecutive dates', () => {
  it('keeps the full run length when qualifying days are consecutive', async () => {
    // Three back-to-back days, all qualifying. This is the behavior-preserving
    // case: every step has a one-day gap, so the run is the entry count, 3.
    // Entries are supplied out of order to also exercise the ascending sort.
    const store = {
      alice: {
        dailyLog: [
          { date: '2024-03-03', words: 60 },
          { date: '2024-03-01', words: 60 },
          { date: '2024-03-02', words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'alice');
    assert.equal(r.status, 200);
    assert.equal(r.payload.longestStreak, 3);
    // Unchanged fields (produced by untouched code paths).
    assert.equal(r.payload.currentStreak, 0);
    assert.equal(r.payload.totalWords, 180);
    assert.deepEqual(r.payload.dailyLog, [
      { date: '2024-03-01', words: 60 },
      { date: '2024-03-02', words: 60 },
      { date: '2024-03-03', words: 60 },
    ]);
  });

  it('reports a longest streak of 1 when every qualifying day is isolated', async () => {
    // Dates several days apart, all qualifying. No two are adjacent, so the
    // correct longest run is 1. The old entry-counting loop reported 3 here.
    const store = {
      bob: {
        dailyLog: [
          { date: '2024-01-10', words: 60 },
          { date: '2024-01-01', words: 60 },
          { date: '2024-01-05', words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'bob');
    assert.equal(r.status, 200);
    assert.equal(r.payload.longestStreak, 1);
    // Unchanged fields (produced by untouched code paths).
    assert.equal(r.payload.currentStreak, 0);
    assert.equal(r.payload.totalWords, 180);
    assert.deepEqual(r.payload.dailyLog, [
      { date: '2024-01-01', words: 60 },
      { date: '2024-01-05', words: 60 },
      { date: '2024-01-10', words: 60 },
    ]);
  });

  it('credits the longest consecutive sub-run, not just 1, when a gap follows a run', async () => {
    // A two-day run (Feb 1 and Feb 2) then an isolated qualifying day (Feb 10).
    // The fix resets the running streak to 1 at the gap rather than to a fixed 1
    // everywhere, so the longest is the 2-day sub-run, not the entry count (3).
    const store = {
      carol: {
        dailyLog: [
          { date: '2024-02-01', words: 60 },
          { date: '2024-02-02', words: 60 },
          { date: '2024-02-10', words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'carol');
    assert.equal(r.status, 200);
    assert.equal(r.payload.longestStreak, 2);
    assert.equal(r.payload.currentStreak, 0);
    assert.equal(r.payload.totalWords, 180);
  });

  it('treats duplicate qualifying dates as a broken run', async () => {
    // Two entries on the same date are a zero-day gap, so the run cannot extend
    // past 1. currentStreak already treats duplicate dates as breaking.
    const store = {
      dave: {
        dailyLog: [
          { date: '2024-05-01', words: 60 },
          { date: '2024-05-01', words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'dave');
    assert.equal(r.status, 200);
    assert.equal(r.payload.longestStreak, 1);
    assert.equal(r.payload.currentStreak, 0);
    assert.equal(r.payload.totalWords, 120);
  });

  it('drops longestStreak on a gap while currentStreak is unchanged', async () => {
    // A qualifying day today and another two days ago, with the day between
    // missing. currentStreak (untouched loop) still counts only today, 1. The
    // longest run was 2 under the old entry counter and is 1 once gaps break it.
    const store = {
      erin: {
        dailyLog: [
          { date: dayOffset(2), words: 60 },
          { date: dayOffset(0), words: 60 },
        ],
      },
    };
    const r = await getStreak(store, 'erin');
    assert.equal(r.status, 200);
    assert.equal(r.payload.currentStreak, 1);
    assert.equal(r.payload.longestStreak, 1);
    assert.equal(r.payload.totalWords, 120);
  });
});
