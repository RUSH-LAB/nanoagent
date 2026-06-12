import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// Today's date formatted exactly as the POST/GET streak handlers format it
// (UTC, YYYY-MM-DD). Captured once per test to avoid a midnight-boundary mismatch
// between the value the handler records and the value the assertions expect.
function today() {
  return new Date().toISOString().slice(0, 10);
}

// POST /api/streak against an in-memory streak store, capturing the json()
// response and the saveJSON call count. The handler reads rateLimit, readBody,
// sanitizeText, loadJSON, saveJSON, STREAKS_FILE, and json from ctx. loadJSON
// returns the supplied store verbatim (a plain object literal), so inherited names
// like toString, valueOf, and hasOwnProperty resolve to truthy inherited functions
// exactly as they would on the real loadJSON result. `Object` is never injected
// into ctx, so the own-property guard exercises the real global Object.hasOwn.
async function postStreak(store, body) {
  const url = new URL('http://localhost/api/streak');
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const STREAKS_FILE = '/fake/streaks.json';
  let captured = null;
  let saveCalls = 0;
  const ctx = {
    STREAKS_FILE,
    rateLimit: () => true,
    readBody: async () => body,
    sanitizeText: (s) => s,
    loadJSON: (file) => (file === STREAKS_FILE ? store : {}),
    saveJSON: () => { saveCalls++; },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/streak', ctx);
  return { captured, saveCalls };
}

// GET /api/streak against the same store, used to read a write back out. This path
// reads only loadJSON, STREAKS_FILE, and json from ctx (no fs/path/PROJECT_ROOT).
async function getStreak(store, userId) {
  const search = userId === undefined ? '' : `?userId=${encodeURIComponent(userId)}`;
  const url = new URL(`http://localhost/api/streak${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const STREAKS_FILE = '/fake/streaks.json';
  let captured = null;
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

// Inherited Object.prototype member names. On a plain object literal each resolves
// to a truthy inherited function, so the pre-fix bare `if (!data[userId])` truthiness
// test skipped the per-user init and let the following `data[userId].dailyLog` /
// `.find` throw a TypeError that the try/catch turned into a misleading 400.
const INHERITED = ['toString', 'valueOf', 'hasOwnProperty'];

describe('POST /api/streak own-property userId guard', () => {
  // Anti-tautology: against the reverted `if (!data[userId])` form each of these
  // cases is a swallowed 400 (the inherited function value is truthy, so the init
  // is skipped and `.dailyLog`/`.find` throws). The own-property guard creates
  // data[userId] under the requested key, so the day is recorded and reads back.
  for (const userId of INHERITED) {
    it(`records under the inherited userId "${userId}" and reads it back (200, own key)`, async () => {
      const t = today();
      const store = {};
      const { captured, saveCalls } = await postStreak(store, { userId, wordsWritten: 100 });
      assert.equal(captured.status, 200);
      assert.equal(captured.payload.success, true);
      assert.equal(captured.payload.date, t);
      assert.equal(captured.payload.words, 100);
      assert.equal(saveCalls, 1);
      // The entry landed under the requested OWN key, shadowing the inherited member.
      assert.ok(Object.hasOwn(store, userId));
      assert.deepEqual(store[userId].dailyLog, [{ date: t, words: 100 }]);
      // ...and a GET round-trips the same store back out.
      const r = await getStreak(store, userId);
      assert.equal(r.status, 200);
      assert.equal(r.payload.currentStreak, 1);
      assert.equal(r.payload.totalWords, 100);
      assert.deepEqual(r.payload.dailyLog, [{ date: t, words: 100 }]);
    });
  }

  it('round-trips a normal userId through POST then GET (200)', async () => {
    const t = today();
    const store = {};
    const { captured, saveCalls } = await postStreak(store, { userId: 'alice', wordsWritten: 80 });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(captured.payload.date, t);
    assert.equal(captured.payload.words, 80);
    assert.equal(saveCalls, 1);
    assert.deepEqual(store.alice.dailyLog, [{ date: t, words: 80 }]);
    const r = await getStreak(store, 'alice');
    assert.equal(r.status, 200);
    assert.equal(r.payload.currentStreak, 1);
    assert.equal(r.payload.totalWords, 80);
    assert.deepEqual(r.payload.dailyLog, [{ date: t, words: 80 }]);
  });

  it('records under the default user when no userId is supplied (200)', async () => {
    const t = today();
    const store = {};
    const { captured, saveCalls } = await postStreak(store, { wordsWritten: 60 });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(saveCalls, 1);
    assert.deepEqual(store.default.dailyLog, [{ date: t, words: 60 }]);
  });

  it("updates today's entry in place for an existing own-key user (200, no duplicate)", async () => {
    const t = today();
    const store = { alice: { dailyLog: [{ date: t, words: 10 }] } };
    const { captured, saveCalls } = await postStreak(store, { userId: 'alice', wordsWritten: 250 });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.words, 250);
    assert.equal(saveCalls, 1);
    // Same-day entry updated in place, not appended.
    assert.equal(store.alice.dailyLog.length, 1);
    assert.deepEqual(store.alice.dailyLog[0], { date: t, words: 250 });
  });
});
