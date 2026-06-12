import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

const DAY = 86400000;
// A fixed clock so the 7 and 30 day cutoffs land on repeatable dates no matter
// when the suite runs. Date.now() drives the window math in the handler; the
// no-arg `new Date()` calls (today, generatedAt) read the real clock and never
// touch the streak object under test.
const NOW = 1700000000000;
// Date string `days` before NOW, matching the handler's
// `new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)` form.
const dayStr = (days) => new Date(NOW - days * DAY).toISOString().slice(0, 10);

// Independent oracle: the original multi-pass computation copied verbatim from
// the pre-fold handler. A byte-identical match proves the single-loop fold
// preserves behavior. It runs under the same frozen Date.now() as the handler.
function oracle(userLog) {
  const sorted = [...userLog].sort((a, b) => a.date.localeCompare(b.date));
  const last7Days = sorted.filter(e => e.date >= new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const last30Days = sorted.filter(e => e.date >= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const totalWordsLast7 = last7Days.reduce((s, e) => s + e.words, 0);
  const totalWordsLast30 = last30Days.reduce((s, e) => s + e.words, 0);
  const avgWordsPerDay7 = last7Days.length > 0 ? Math.round(totalWordsLast7 / 7) : 0;
  const avgWordsPerDay30 = last30Days.length > 0 ? Math.round(totalWordsLast30 / 30) : 0;
  return {
    activeDaysLast7: last7Days.filter(e => e.words >= 50).length,
    activeDaysLast30: last30Days.filter(e => e.words >= 50).length,
    totalWordsLast7,
    totalWordsLast30,
    avgWordsPerDay7,
    avgWordsPerDay30,
  };
}

// Drive the real GET /api/productivity-report handler over a fully mocked ctx,
// fully in process (no network, no disk). loadJSON keyed by path serves the
// streaks fixture and an empty analytics object; cached runs its producer
// inline; fs.statSync throws so loadReferencesCached returns {} (references: 0);
// fs.readdirSync returns [] so the content walk counts nothing. Date.now() is
// frozen to NOW by the surrounding beforeEach, so the handler and the oracle
// share one clock.
async function report(dailyLog) {
  const STREAKS_FILE = 'STREAKS';
  const ANALYTICS_FILE = 'ANALYTICS';
  // `undefined` means the user has no streak record at all (streakData = {});
  // anything else is wrapped as that user's dailyLog.
  const streakData = dailyLog === undefined ? {} : { default: { dailyLog } };
  const url = new URL('http://localhost/api/productivity-report');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    STREAKS_FILE,
    ANALYTICS_FILE,
    PROJECT_ROOT: '/fake/root',
    path,
    ALLOWED_EXTS: ['.md', '.mdx'],
    loadJSON: (file) =>
      file === STREAKS_FILE ? streakData : file === ANALYTICS_FILE ? {} : {},
    cached: (_key, _ttl, fn) => fn(),
    fs: {
      statSync() { throw new Error('ENOENT'); }, // -> loadReferencesCached() returns {}
      readdirSync() { return []; },              // -> content walk counts nothing
    },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/productivity-report', ctx);
  return captured;
}

// Freeze Date.now to NOW for each test so the handler's window cutoffs and the
// oracle's are computed against the same clock, then restore the real clock
// afterward. Also reset the module-scope references memo so the throwing
// statSync path is what resolves loadReferencesCached to {} every time.
const realNow = Date.now;
beforeEach(() => {
  routes._clearReferencesCache();
  Date.now = () => NOW;
});
afterEach(() => {
  Date.now = realNow;
});

describe('GET /api/productivity-report — 7 and 30 day window fold', () => {
  it('matches the original multi-pass oracle for a log straddling both windows', async () => {
    // Offsets straddle the 7 and 30 day cutoffs, with a mix of word counts above
    // and below the 50-word active-day threshold (including the exact boundary).
    const log = [
      { date: dayStr(1), words: 100 },  // in 7 & 30, active
      { date: dayStr(2), words: 49 },   // in 7 & 30, below threshold
      { date: dayStr(3), words: 50 },   // in 7 & 30, exactly at the threshold -> active
      { date: dayStr(8), words: 75 },   // in 30 only, active
      { date: dayStr(10), words: 30 },  // in 30 only, below threshold
      { date: dayStr(31), words: 500 }, // in neither window
    ];
    const r = await report(log);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.streak, oracle(log));
    // Spell out the expectation independently so a regression in the oracle
    // itself would also be caught.
    assert.deepEqual(r.payload.streak, {
      activeDaysLast7: 2,
      activeDaysLast30: 3,
      totalWordsLast7: 199,   // 100 + 49 + 50
      totalWordsLast30: 304,  // 100 + 49 + 50 + 75 + 30
      avgWordsPerDay7: 28,    // round(199 / 7)
      avgWordsPerDay30: 10,   // round(304 / 30)
    });
  });

  it('is order independent: an unsorted log yields the same streak', async () => {
    const log = [
      { date: dayStr(31), words: 500 },
      { date: dayStr(2), words: 49 },
      { date: dayStr(8), words: 75 },
      { date: dayStr(1), words: 100 },
      { date: dayStr(10), words: 30 },
      { date: dayStr(3), words: 50 },
    ];
    const r = await report(log);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.streak, oracle(log));
  });

  it('preserves NaN/undefined word handling (no added || 0)', async () => {
    const log = [
      { date: dayStr(1), words: 100 },
      { date: dayStr(2) },             // words undefined -> NaN totals, ignored by active count
      { date: dayStr(8), words: 60 },
    ];
    const r = await report(log);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.streak, oracle(log));
    // The undefined entry turns both word totals (and their averages) into NaN.
    assert.ok(Number.isNaN(r.payload.streak.totalWordsLast7));
    assert.ok(Number.isNaN(r.payload.streak.totalWordsLast30));
    assert.ok(Number.isNaN(r.payload.streak.avgWordsPerDay7));
    assert.ok(Number.isNaN(r.payload.streak.avgWordsPerDay30));
    // Active-day counts ignore the NaN entry, since NaN >= 50 is false.
    assert.equal(r.payload.streak.activeDaysLast7, 1);
    assert.equal(r.payload.streak.activeDaysLast30, 2);
  });

  it('returns all six streak fields as 0 for an empty log', async () => {
    const r = await report([]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.streak, {
      activeDaysLast7: 0,
      activeDaysLast30: 0,
      totalWordsLast7: 0,
      totalWordsLast30: 0,
      avgWordsPerDay7: 0,
      avgWordsPerDay30: 0,
    });
    assert.deepEqual(r.payload.streak, oracle([]));
  });

  it('returns all six streak fields as 0 when the user has no streak record', async () => {
    const r = await report(undefined); // streakData = {}, so userLog falls back to []
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.streak, oracle([]));
  });
});
