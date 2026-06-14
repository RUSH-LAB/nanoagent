import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load the real module the way the sibling
// route tests do (see tests/next-react-input-validation-guards.test.mjs and
// tests/next-react-write-ownprop-guard.test.mjs), so these cases drive the shipped
// POST /api/comments/react handler rather than a reimplementation.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

// WHY THE OUTER CATCH IS DETERMINISTIC AND PINNED HERE
// ──────────────────────────────────────────────────────────────────────────
// POST /api/comments/react opens an OUTER `try` whose first statement is
// `const body = await readBody(req)`, immediately followed by
// `const {page, commentId, emoji, userId} = body;`. The OUTER `catch` returns a
// fixed 400 `{error: 'Invalid request'}` before ANY store IO: the first IO,
// loadJSON(COMMENTS_FILE), runs only after the destructure clears. The sibling
// guards test (tests/next-react-input-validation-guards.test.mjs) only ever
// resolves readBody to a valid object, so this catch was 0-hit and its golden
// unpinned. Two inputs route into it deterministically:
//   1. readBody rejects, so the awaited body throws.
//   2. readBody resolves null, so destructuring null throws.
// Neither input touches the clock, randomness, the network, or the filesystem.

// Drive the real handler with a minimal mocked ctx and capture the response
// handed to json(res, status, body). loadJSON and saveJSON are zero-call
// tripwires: each increments a counter and throws on contact, so a regression
// that reached the store would be caught by the counter assertion (and the throw
// would itself be swallowed into the same catch, which the counter still exposes).
// rateLimit returns true so the handler clears the `react:` throttle, which sits
// BEFORE the try, and reaches readBody. sanitizeText is identity, though no path
// pinned here reaches it.
async function invokeReact({ readBodyImpl }) {
  const pathname = '/api/comments/react';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  let readBodyCalls = 0;
  const ctx = {
    COMMENTS_FILE: '/tmp/next-react-badbody.json',
    rateLimit: () => true,
    readBody: async (r) => { readBodyCalls += 1; return readBodyImpl(r); },
    loadJSON: () => { loadCalls += 1; throw new Error('loadJSON must never run on the badbody catch path'); },
    saveJSON: () => { saveCalls += 1; throw new Error('saveJSON must never run on the badbody catch path'); },
    sanitizeText: (s) => s,
    json(_res, status, body) {
      captured = { status, body };
      res.writableEnded = true;
      return captured;
    },
  };
  await bookmarksReadingListsRoutes(req, res, url, pathname, ctx);
  return { captured, loadCalls, saveCalls, readBodyCalls };
}

// The fixed shape the outer catch always returns, regardless of which trigger
// fired. Both cases assert this exact object via assert.deepEqual.
const EXPECTED = { status: 400, body: { error: 'Invalid request' } };

describe('POST /api/comments/react outer-catch 400 badbody golden', () => {
  it('readBody rejecting routes into the outer catch and returns the fixed 400 before any store IO', async () => {
    // The awaited readBody throws inside the try, so the outer catch returns the
    // fixed 400 without ever reaching loadJSON or saveJSON.
    const { captured, loadCalls, saveCalls, readBodyCalls } = await invokeReact({
      readBodyImpl: async () => { throw new Error('malformed request body'); },
    });
    assert.deepEqual(captured, EXPECTED);
    assert.equal(readBodyCalls, 1);
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('readBody resolving null throws in the destructure into the same catch, beating the Missing-fields guard', async () => {
    // body is null, so `const {page, commentId, emoji, userId} = body` throws a
    // TypeError that the same outer catch turns into the identical fixed 400.
    // This pins PRECEDENCE: the first inner guard
    // ({error: 'Missing page, commentId, emoji, or userId'}) never runs, and no
    // store IO is reached.
    const { captured, loadCalls, saveCalls, readBodyCalls } = await invokeReact({
      readBodyImpl: async () => null,
    });
    assert.deepEqual(captured, EXPECTED);
    assert.equal(readBodyCalls, 1);
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});
