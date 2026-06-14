import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load the REAL route module the way the sibling
// route tests do (see tests/next-analytics-pageview-post-guards.test.mjs and
// tests/next-analyticsusers-dedup-protokeys.test.mjs), so these cases exercise the
// shipped POST /api/analytics/pageview handler rather than a reimplementation.
//
// The sibling guards suite only ever RESOLVES readBody to a valid object, so the
// handler's OUTER catch stays 0-hit. This file pins that catch. The try opens with
// `const body = await readBody(req)` and then `const {path, referrer, userAgent} =
// body`, and a single catch returns a FIXED 400 {error: 'Invalid request'} before any
// store IO (loadJSON is the first IO and runs only AFTER the destructure). Two inputs
// reach the catch:
//   1. readBody REJECTS: the awaited rejection lands directly in the catch.
//   2. readBody RESOLVES null: the `const {path, referrer, userAgent} = body`
//      destructure throws a TypeError into the SAME catch. That destructure runs
//      before the first inner guard ('Missing path'), so the fixed 400 proves the
//      outer catch wins over that guard rather than the 'Missing path' 400 winning.
// Both return before loadJSON, saveJSON, and new Date(), so the cases are deterministic
// and this file edits no source.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

const PATH = '/api/analytics/pageview';

// Drive the POST /api/analytics/pageview handler with a minimal mocked ctx. `readBody`
// is supplied per case so each call decides whether the await rejects or resolves; the
// ctx wrapper counts the call so we can assert control reached the try. The json
// capturer records {status, body} for an exact deepEqual; rateLimit returns true and
// records its args so we can confirm the pageview rate-limit guard (which sits BEFORE
// the try) ran first; loadJSON and saveJSON are zero-call tripwires that count a hit and
// throw on contact, so a counter above zero would prove a guard fell through to store IO
// the catch path must never do.
async function invoke({ readBody, remoteAddress = '127.0.0.1' } = {}) {
  const url = new URL(`http://localhost${PATH}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };
  let captured = null;
  let readBodyCount = 0;
  let loadCount = 0;
  let saveCount = 0;
  let rateLimitArgs = null;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, body: payload };
      res.writableEnded = true;
      return captured;
    },
    rateLimit: (key, limit) => { rateLimitArgs = { key, limit }; return true; },
    readBody: (...args) => { readBodyCount += 1; return readBody(...args); },
    loadJSON: () => { loadCount += 1; throw new Error('loadJSON must not run on the catch path'); },
    saveJSON: () => { saveCount += 1; throw new Error('saveJSON must not run on the catch path'); },
    ANALYTICS_FILE: '/tmp/next-pageview-badbody-test.json',
  };
  await analyticsUsersRoutes(req, res, url, PATH, ctx);
  return { captured, readBodyCount, loadCount, saveCount, rateLimitArgs };
}

describe('POST /api/analytics/pageview outer catch returns a fixed 400 (current behavior)', () => {
  it('returns 400 Invalid request when readBody rejects, before any store IO', async () => {
    // The first statement in the try is `await readBody(req)`; a rejected promise lands
    // straight in the outer catch, which returns the fixed 400 and touches no store.
    const { captured, readBodyCount, loadCount, saveCount, rateLimitArgs } = await invoke({
      readBody: async () => { throw new Error('boom: malformed body'); },
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    // The rate-limit guard cleared and readBody was awaited (so control entered the try),
    // yet no store IO ran before the catch returned.
    assert.deepEqual(rateLimitArgs, { key: 'pageview:127.0.0.1', limit: 60 });
    assert.equal(readBodyCount, 1);
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 400 Invalid request when readBody resolves null, ahead of the Missing path guard', async () => {
    // readBody resolving null makes `const {path, referrer, userAgent} = body` throw a
    // TypeError that the SAME outer catch handles. The fixed 400, not the inner 'Missing
    // path' 400, proves the catch wins over the first validation guard, and no store IO runs.
    const { captured, readBodyCount, loadCount, saveCount, rateLimitArgs } = await invoke({
      readBody: async () => null,
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.deepEqual(rateLimitArgs, { key: 'pageview:127.0.0.1', limit: 60 });
    assert.equal(readBodyCount, 1);
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });
});
