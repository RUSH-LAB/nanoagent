import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load the REAL route module the way the sibling
// POST /api/annotations badbody test (tests/next-annotations-badbody.test.mjs)
// does. This pins the POST /api/streak handler's OUTER try/catch: the FIXED 400
// {error: 'Invalid request'} it returns before any store IO. A per-IP rate-limit
// gate (`streak:` + remoteAddress, 30) sits BEFORE the try, so the try is entered
// only once that gate clears. The try opens with `const body = await
// readBody(req)` immediately followed by the PROPERTY ACCESS `body.userId` (this
// handler has NO upfront destructure), so the catch is reachable two ways:
// readBody throwing, or readBody resolving null whose `body.userId` access throws
// a TypeError. That catch is unpinned today: the covering guards test
// (tests/next-streak-post-validation-guards.test.mjs) only ever resolves readBody
// to a valid object, so the fixed-400 catch body never executes.
const require = createRequire(import.meta.url);
const analysisAdminRoutes = require('../server/routes/analysis-admin.js');

// The first inner validation guard inside the try. The outer catch must beat it
// whenever the `body.userId` property access itself throws, so the body returned
// on the null case is the fixed 'Invalid request', never this message.
const USERID_MUST_BE_STRING = 'userId must be a string';

// Drive POST /api/streak through the outer catch and capture the response handed
// to json(res, status, payload). readBody is supplied per case so it can reject
// or resolve null, and is wrapped to count entries. rateLimit returns true (the
// limiter clears, so control reaches the try) and records its args. loadJSON and
// saveJSON are ZERO-CALL tripwires: the handler's first store IO is
// loadJSON(STREAKS_FILE), which runs only AFTER the body.userId property access
// and every field guard, so an outer-catch hit must never reach them. Each bumps
// a counter and throws on contact, so any accidental IO both fails the test
// loudly and surfaces a non-zero count. The success path's clock (new Date) lives
// past the property access as well, so the error path the test exercises stays
// fully deterministic.
async function invokePost({ readBody }) {
  const pathname = '/api/streak';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  let bodyCalls = 0;
  let rateLimitCalls = 0;
  let rateLimitArgs = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-streak-badbody-test',
    STREAKS_FILE: '/tmp/next-streak-badbody-test/streaks.json',
    readBody: async (r) => { bodyCalls += 1; return readBody(r); },
    rateLimit: (key, limit) => { rateLimitCalls += 1; rateLimitArgs = { key, limit }; return true; },
    loadJSON: () => { loadCalls += 1; throw new Error('loadJSON must not run on the outer-catch path'); },
    saveJSON: () => { saveCalls += 1; throw new Error('saveJSON must not run on the outer-catch path'); },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, body: payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await analysisAdminRoutes(req, res, url, pathname, ctx);
  return { captured, loadCalls, saveCalls, bodyCalls, rateLimitCalls, rateLimitArgs };
}

describe('POST /api/streak outer-catch 400 badbody golden', () => {
  // Trigger 1: readBody rejects. The first statement in the outer try throws, so
  // control jumps straight to the catch before the body.userId access, any field
  // guard, and any store IO. The 0 IO counters prove the catch fires pre-IO, and
  // the single readBody entry proves the try ran exactly once. The limiter cleared
  // first, keyed per-IP, which is why the try was reached at all.
  it('returns a fixed 400 when readBody rejects, touching no store IO', async () => {
    const { captured, loadCalls, saveCalls, bodyCalls, rateLimitCalls, rateLimitArgs } = await invokePost({
      readBody: async () => { throw new Error('malformed body'); },
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
    assert.equal(bodyCalls, 1);
    assert.equal(rateLimitCalls, 1);
    assert.deepEqual(rateLimitArgs, { key: 'streak:127.0.0.1', limit: 30 });
  });

  // Trigger 2: readBody resolves null. The property access `body.userId` throws a
  // TypeError on null, landing in the SAME outer catch and returning the SAME
  // fixed 400. This also pins PRECEDENCE: the outer catch beats the first inner
  // validation guard (USERID_MUST_BE_STRING), which never runs because the
  // property access throws before its condition can evaluate.
  it('returns the same fixed 400 when readBody resolves null, before any guard or IO', async () => {
    const { captured, loadCalls, saveCalls, bodyCalls } = await invokePost({
      readBody: async () => null,
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.notEqual(captured.body.error, USERID_MUST_BE_STRING);
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
    assert.equal(bodyCalls, 1);
  });
});
