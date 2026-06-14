import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load the real module the way the sibling
// route tests do (see tests/next-react-badbody.test.mjs, which pins the POST arm,
// and tests/next-react-write-ownprop-guard.test.mjs for the DELETE ctx shape), so
// these cases drive the shipped DELETE /api/comments/react handler rather than a
// reimplementation.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

// WHY THE DELETE OUTER CATCH IS DETERMINISTIC AND PINNED HERE
// ──────────────────────────────────────────────────────────────────────────
// The DELETE /api/comments/react arm opens an OUTER `try` whose FIRST statement is
// `const body = await readBody(req)`, immediately followed by
// `const {page, commentId, emoji, userId} = body;`. Unlike the POST sibling, this
// arm has NO rate-limit gate: the `try` is the very first statement, so rateLimit
// is never consulted. The OUTER `catch` returns a fixed 400
// `{error: 'Invalid request'}` before ANY store IO, because the first IO,
// loadJSON(COMMENTS_FILE), runs only after the destructure clears AND the first
// inner guard passes. Three inputs make the branch behavior observable:
//   1. readBody rejects, so the awaited body throws into the outer catch.
//   2. readBody resolves null, so destructuring null throws into the SAME catch.
//      This BEATS the first inner guard, pinning outer-catch precedence.
//   3. readBody resolves {}, so `page` is undefined and the inner guard
//      `{error: 'Missing page, commentId, emoji, or userId'}` fires with its own
//      400. A {} body therefore never reaches the outer catch; this is the
//      contrast that makes the precedence claim in case 2 concrete.
// loadJSON returns {} on a missing or broken file rather than throwing, so the
// only genuine pre-IO throw triggers are cases 1 and 2. None of the three inputs
// touches the clock, randomness, the network, or the filesystem, so the test is
// deterministic.

// Drive the real handler with a minimal mocked ctx and capture the response handed
// to json(res, status, body). loadJSON and saveJSON are zero-call tripwires: each
// increments a counter AND throws on contact, so a regression that reached the
// store would be exposed by the counter (and its throw would land in the same
// catch and yield the identical 400, which is why the COUNTER, not the body, is
// the never-reached proof). rateLimit records every call so the DELETE arm's
// no-gate shape can be asserted: it is expected to stay untouched.
async function invokeDelete({ readBodyImpl }) {
  const pathname = '/api/comments/react';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const calls = { rateLimit: [], load: 0, save: 0, readBody: 0 };
  const ctx = {
    COMMENTS_FILE: '/tmp/next-react-delete-badbody.json',
    rateLimit: (...args) => { calls.rateLimit.push(args); return true; },
    readBody: async (r) => { calls.readBody += 1; return readBodyImpl(r); },
    loadJSON: () => { calls.load += 1; throw new Error('loadJSON must never run on the badbody catch path'); },
    saveJSON: () => { calls.save += 1; throw new Error('saveJSON must never run on the badbody catch path'); },
    sanitizeText: (s) => s,
    json(_res, status, body) {
      captured = { status, body };
      res.writableEnded = true;
      return captured;
    },
  };
  await bookmarksReadingListsRoutes(req, res, url, pathname, ctx);
  return { captured, calls };
}

// The fixed shape the outer catch always returns, regardless of which trigger
// fired. Both catch cases assert this exact object via assert.deepEqual.
const EXPECTED = { status: 400, body: { error: 'Invalid request' } };
// The first inner guard that the null destructure must BEAT. The outer catch must
// never return this when body is null.
const MISSING_FIELDS = { error: 'Missing page, commentId, emoji, or userId' };

describe('DELETE /api/comments/react outer-catch 400 badbody golden', () => {
  it('readBody rejecting routes into the outer catch and returns the fixed 400 before any store IO', async () => {
    const { captured, calls } = await invokeDelete({
      readBodyImpl: async () => { throw new Error('malformed request body'); },
    });
    assert.deepEqual(captured, EXPECTED);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.load, 0);
    assert.equal(calls.save, 0);
    assert.equal(calls.rateLimit.length, 0);
  });

  it('readBody resolving null throws in the destructure into the same catch, beating the Missing-fields guard', async () => {
    const { captured, calls } = await invokeDelete({
      readBodyImpl: async () => null,
    });
    assert.deepEqual(captured, EXPECTED);
    // Precedence: destructuring null throws before the first inner guard runs, so
    // the catch's fixed 400 wins and the Missing-fields 400 never fires.
    assert.notDeepEqual(captured.body, MISSING_FIELDS);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.load, 0);
    assert.equal(calls.save, 0);
    assert.equal(calls.rateLimit.length, 0);
  });

  it('an empty {} body stops at the Missing-fields inner guard, never reaching the outer catch or any store IO', async () => {
    // Contrast that makes the precedence claim concrete: a non-throwing falsy body
    // reaches the first inner guard (page is undefined), which returns its own 400
    // before loadJSON. The null case above throws earlier, in the destructure, so
    // it lands in the outer catch instead.
    const { captured, calls } = await invokeDelete({
      readBodyImpl: async () => ({}),
    });
    assert.deepEqual(captured, { status: 400, body: MISSING_FIELDS });
    assert.equal(calls.readBody, 1);
    assert.equal(calls.load, 0);
    assert.equal(calls.save, 0);
    assert.equal(calls.rateLimit.length, 0);
  });
});
