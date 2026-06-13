import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load the REAL module the way the sibling streak
// tests do, so these characterization assertions run against production code.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// Drive POST /api/streak over a fully mocked ctx and report the captured json()
// response together with how often the body reader and the persistence helpers
// ran. Every guard exercised below returns inside the handler's first few lines,
// ahead of `new Date()`, `loadJSON(STREAKS_FILE)`, and any `saveJSON` write, so a
// correct reject leaves loadCalls and saveCalls at 0. On this path the handler
// reads only rateLimit, readBody, sanitizeText, loadJSON, saveJSON, STREAKS_FILE,
// and json from ctx. `rateLimitOk` toggles the rate-limit gate so the 429 branch
// can be reached on demand.
async function postStreak(body, { rateLimitOk = true } = {}) {
  const url = new URL('http://localhost/api/streak');
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const STREAKS_FILE = '/fake/streaks.json';
  let captured = null;
  let readCalls = 0;
  let loadCalls = 0;
  let saveCalls = 0;
  const ctx = {
    STREAKS_FILE,
    rateLimit: () => rateLimitOk,
    readBody: async () => { readCalls++; return body; },
    sanitizeText: (s) => s,
    loadJSON: () => { loadCalls++; return {}; },
    saveJSON: () => { saveCalls++; },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/streak', ctx);
  return { captured, readCalls, loadCalls, saveCalls };
}

describe('POST /api/streak input-validation guards', () => {
  it('returns 429 when rate limited, before the body is read or the store is touched', async () => {
    const { captured, readCalls, loadCalls, saveCalls } =
      await postStreak({ userId: 'alice', wordsWritten: 100 }, { rateLimitOk: false });
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.error, 'Too many requests. Try again in a minute.');
    // The 429 returns ahead of readBody, so the body is never consumed, and the
    // persistence helpers stay untouched.
    assert.equal(readCalls, 0);
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  // A present-but-non-string userId is rejected at the first body guard. The body
  // is read once, then the handler returns before reaching the store.
  it('rejects a number userId with 400 "userId must be a string"', async () => {
    const { captured, readCalls, loadCalls, saveCalls } =
      await postStreak({ userId: 123, wordsWritten: 100 });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'userId must be a string');
    assert.equal(readCalls, 1);
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('rejects a boolean userId with 400 "userId must be a string"', async () => {
    const { captured, loadCalls, saveCalls } =
      await postStreak({ userId: true, wordsWritten: 100 });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'userId must be a string');
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('rejects an object userId with 400 "userId must be a string"', async () => {
    const { captured, loadCalls, saveCalls } =
      await postStreak({ userId: {}, wordsWritten: 100 });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'userId must be a string');
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('rejects a userId longer than 200 characters with 400', async () => {
    const { captured, loadCalls, saveCalls } =
      await postStreak({ userId: 'x'.repeat(201), wordsWritten: 100 });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'userId must be 200 characters or fewer');
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  // The prototype-pollution guard rejects each reserved key name. Every value is a
  // short, valid string, so it clears the type and length guards and trips only the
  // PROTO_KEYS membership check.
  for (const userId of ['__proto__', 'constructor', 'prototype']) {
    it(`rejects the reserved userId "${userId}" with 400 "Invalid userId"`, async () => {
      const { captured, loadCalls, saveCalls } =
        await postStreak({ userId, wordsWritten: 100 });
      assert.equal(captured.status, 400);
      assert.equal(captured.payload.error, 'Invalid userId');
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    });
  }

  // wordsWritten range guards. A genuine numeric value is required to trip these: a
  // non-number wordsWritten (string, boolean, object) is coerced to 0 at the
  // `typeof ... === 'number'` line, clears both range checks, and would continue to
  // the persistence path. These two cases therefore pass real numbers by design.
  it('rejects a negative wordsWritten with 400 before the store is touched', async () => {
    const { captured, loadCalls, saveCalls } = await postStreak({ wordsWritten: -5 });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'wordsWritten must be non-negative');
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('rejects a wordsWritten above the maximum with 400 before the store is touched', async () => {
    const { captured, loadCalls, saveCalls } = await postStreak({ wordsWritten: 1000001 });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'wordsWritten exceeds maximum');
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});
