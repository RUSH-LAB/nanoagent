import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load the real module the way the sibling route
// tests do (see tests/next-react-badbody.test.mjs), so these cases drive the
// shipped DELETE /api/comments handler rather than a reimplementation.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// WHY THE OUTER CATCH IS DETERMINISTIC AND PINNED HERE
//
// DELETE /api/comments opens an outer `try` whose first statement is
// `const body = await readBody(req)`, immediately followed by
// `const {page, commentId, userId} = body;`. The outer `catch` returns a fixed
// 400 `{error: 'Invalid request'}` before ANY store IO: the first IO,
// loadJSON(COMMENTS_FILE), runs only after the destructure clears, and the
// owner-auth branch's loadJSON(USERS_FILE) sits later still, also past the
// destructure. This handler has no rate-limit gate, so nothing runs before the
// try. Two inputs route into the catch deterministically:
//   1. readBody rejects, so the awaited body throws.
//   2. readBody resolves null, so destructuring null throws.
// Neither input touches the clock, randomness, the network, or the filesystem.

// Drive the real handler with a minimal mocked ctx and capture the response
// handed to json(res, status, body). loadJSON and saveJSON are zero-call
// tripwires: each increments a counter and throws on contact. The counter, not
// the body, is the never-reached proof: a regression that reached the store
// would throw on the tripwire and that throw would be swallowed into the same
// catch, yielding the identical badbody 400, so the body alone cannot tell the
// two apart. rateLimit is a counting stub that must stay untouched, confirming
// this handler never gates on the rate limiter.
async function invokeDelete({ readBodyImpl }) {
  const pathname = '/api/comments';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  let readBodyCalls = 0;
  const rateLimitCalls = [];
  const ctx = {
    COMMENTS_FILE: '/tmp/next-comments-delete-badbody.json',
    USERS_FILE: '/tmp/next-comments-delete-badbody-users.json',
    rateLimit: (...args) => { rateLimitCalls.push(args); return true; },
    readBody: async (r) => { readBodyCalls += 1; return readBodyImpl(r); },
    loadJSON: () => { loadCalls += 1; throw new Error('loadJSON must never run on the badbody catch path'); },
    saveJSON: () => { saveCalls += 1; throw new Error('saveJSON must never run on the badbody catch path'); },
    json(_res, status, body) {
      captured = { status, body };
      res.writableEnded = true;
      return captured;
    },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { captured, loadCalls, saveCalls, readBodyCalls, rateLimitCalls };
}

// The fixed shape the outer catch always returns, regardless of which trigger
// fired. Both cases assert this exact object via assert.deepEqual.
const EXPECTED = { status: 400, body: { error: 'Invalid request' } };

// The first inner guard's body. The null case must NOT return this: the
// destructure throws before the guard runs, so the outer catch wins.
const MISSING_GUARD_BODY = { error: 'Missing page or commentId' };

describe('DELETE /api/comments outer-catch 400 badbody golden', () => {
  it('readBody rejecting routes into the outer catch and returns the fixed 400 before any store IO', async () => {
    // The awaited readBody throws inside the try, so the outer catch returns the
    // fixed 400 without ever reaching loadJSON or saveJSON.
    const { captured, loadCalls, saveCalls, readBodyCalls, rateLimitCalls } = await invokeDelete({
      readBodyImpl: async () => { throw new Error('malformed request body'); },
    });
    assert.deepEqual(captured, EXPECTED);
    assert.equal(readBodyCalls, 1);
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
    assert.equal(rateLimitCalls.length, 0);
  });

  it('readBody resolving null throws in the destructure into the same catch, beating the Missing-fields guard', async () => {
    // body is null, so `const {page, commentId, userId} = body` throws a
    // TypeError that the same outer catch turns into the identical fixed 400.
    // This pins PRECEDENCE: the first inner guard ({error: 'Missing page or
    // commentId'}) never runs, and no store IO is reached.
    const { captured, loadCalls, saveCalls, readBodyCalls, rateLimitCalls } = await invokeDelete({
      readBodyImpl: async () => null,
    });
    assert.deepEqual(captured, EXPECTED);
    assert.notDeepEqual(captured.body, MISSING_GUARD_BODY);
    assert.equal(readBodyCalls, 1);
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
    assert.equal(rateLimitCalls.length, 0);
  });
});
