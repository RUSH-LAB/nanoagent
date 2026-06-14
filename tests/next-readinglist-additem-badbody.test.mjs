import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load the real route module the way the
// sibling add-item tests do (tests/next-readinglist-additem-guards.test.mjs for the
// handler harness and the rl-items gate, tests/next-readinglists-badbody.test.mjs for
// the readBody-reject and null-destructure outer-catch pattern), so these cases drive
// the shipped POST /api/reading-lists/:id/items add-item handler, not a reimplementation.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

// WHY THE OUTER CATCH IS DETERMINISTIC AND PINNED HERE
// ──────────────────────────────────────────────────────────────────────────
// POST /api/reading-lists/:id/items first clears a `rateLimit('rl-items:' +
// remoteAddress, 60)` gate that sits BEFORE the try. Inside the try it runs
// `const parts = pathname.split('/'); const listId = decodeURIComponent(parts[3]);`
// (both PURE on a valid pathname) and only THEN `const body = await readBody(req);`
// followed by `const {path: itemPath, title, type} = body;`. So readBody is the first
// FAILABLE step, and the first store IO (loadJSON(READING_LISTS_FILE)) runs only after
// the destructure and the inner guards clear. The covering guards test only ever
// resolves readBody to a valid object, so this outer catch was 0-hit and its golden
// unpinned. Two inputs route into it deterministically:
//   1. readBody rejects, so the awaited body throws.
//   2. readBody resolves null, so destructuring null throws, beating the inner
//      `Missing path` guard and pinning outer-catch precedence.
// Neither input touches the clock, randomness, the network, or the filesystem.

// Drive the real handler with a minimal mocked ctx and capture the response handed to
// json(res, status, body). loadJSON and saveJSON are zero-call tripwires: each
// increments a counter AND throws on contact, so a regression that reached the store is
// caught by the counter. Asserting the body alone would not prove the store stayed
// untouched, because a tripwire throw lands in the SAME outer catch and still yields the
// fixed 400, so the count === 0 check is the real never-reached proof. rateLimit returns
// true so control clears the `rl-items:` gate and reaches readBody; its key, limit, and
// call count are recorded to prove the handler was entered through that gate. sanitizeText
// is identity, though no path pinned here reaches it (it and new Date() run only on the
// 200 path).
async function invokeAddItem({ readBodyImpl, listId = 'list-1' }) {
  const pathname = `/api/reading-lists/${listId}/items`;
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  let readBodyCalls = 0;
  let rateLimitCalls = 0;
  let rateLimitKey = null;
  let rateLimitMax = null;
  const ctx = {
    READING_LISTS_FILE: '/tmp/next-readinglist-additem-badbody.json',
    rateLimit: (key, max) => { rateLimitCalls += 1; rateLimitKey = key; rateLimitMax = max; return true; },
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
  return { captured, loadCalls, saveCalls, readBodyCalls, rateLimitCalls, rateLimitKey, rateLimitMax };
}

// The fixed shape the outer catch always returns, regardless of which trigger fired.
// Both cases assert this exact object via assert.deepEqual.
const EXPECTED = { status: 400, body: { error: 'Invalid request' } };

describe('POST /api/reading-lists/:id/items outer-catch 400 badbody golden', () => {
  it('readBody rejecting routes into the outer catch and returns the fixed 400 before any store IO', async () => {
    // The awaited readBody throws inside the try, so the outer catch returns the fixed
    // 400 without ever reaching loadJSON or saveJSON.
    const { captured, loadCalls, saveCalls, readBodyCalls, rateLimitCalls, rateLimitKey, rateLimitMax } =
      await invokeAddItem({ readBodyImpl: async () => { throw new Error('malformed request body'); } });
    assert.deepEqual(captured, EXPECTED);
    assert.equal(readBodyCalls, 1);
    // Never-reached proof: the store tripwires were not touched.
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
    // The rl-items gate sits before the try and was cleared exactly once.
    assert.equal(rateLimitCalls, 1);
    assert.equal(rateLimitKey, 'rl-items:127.0.0.1');
    assert.equal(rateLimitMax, 60);
  });

  it('readBody resolving null throws in the destructure into the same catch, beating the Missing-path guard', async () => {
    // body is null, so `const {path: itemPath, title, type} = body` throws a TypeError
    // that the same outer catch turns into the identical fixed 400. This pins PRECEDENCE:
    // the first inner guard ({error: 'Missing path'}) never runs, and no store IO is reached.
    const { captured, loadCalls, saveCalls, readBodyCalls, rateLimitCalls, rateLimitKey, rateLimitMax } =
      await invokeAddItem({ readBodyImpl: async () => null });
    assert.deepEqual(captured, EXPECTED);
    // Precedence, stated directly: the body is the fixed Invalid request golden, not the
    // inner Missing path guard that a non-throwing destructure would have reached.
    assert.notEqual(captured.body.error, 'Missing path');
    assert.equal(readBodyCalls, 1);
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
    assert.equal(rateLimitCalls, 1);
    assert.equal(rateLimitKey, 'rl-items:127.0.0.1');
    assert.equal(rateLimitMax, 60);
  });
});
