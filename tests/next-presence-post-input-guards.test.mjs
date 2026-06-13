import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load the REAL route module the way the sibling
// server route tests do (see tests/next-analytics-pageview-post-guards.test.mjs and
// tests/next-presence-protokey-guard.test.mjs), so these cases exercise the shipped
// POST /api/presence handler rather than a reimplementation.
//
// The proto-key 'Invalid filePath or userId' branch is already pinned by
// tests/next-presence-protokey-guard.test.mjs, so this file pins the OTHER
// input-validation guards the handler runs before any store write: the rate limit,
// the Missing-filePath-or-userId check, the string-type check, and the length check.
// Every branch here returns before the presenceStore write and the lastSeen clock,
// so the cases are deterministic and the file edits no source.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

const PATH = '/api/presence';

// Drive the POST /api/presence handler with a minimal mocked ctx. `body` is what the
// handler receives from `await readBody(req)`. The recorders capture the response
// handed to json(res, status, payload), the rate-limit arguments, how many times
// readBody and cleanStalePresence ran, and the presenceStore object itself, so each
// guard is pinned both by its status and body and by the work it did NOT perform.
//
// presenceStore is a fresh object the handler mutates only on the accepting path; the
// write and the `lastSeen` clock value it carries live in one statement, so a store
// that is still empty after the call proves neither the write nor the clock was
// reached. cleanStalePresence runs immediately after that write, so a count of zero
// is the same proof seen from the other side. No asserted branch reaches sanitizeText
// either, so it is intentionally absent from ctx.
async function invoke({
  body = {},
  rateLimitOk = true,
  remoteAddress = '127.0.0.1',
  presenceStore = {},
} = {}) {
  const url = new URL(`http://localhost${PATH}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };
  let captured = null;
  let readBodyCount = 0;
  let cleanCount = 0;
  let rateLimitArgs = null;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    rateLimit: (key, limit) => { rateLimitArgs = { key, limit }; return rateLimitOk; },
    readBody: async () => { readBodyCount += 1; return body; },
    cleanStalePresence: () => { cleanCount += 1; },
    presenceStore,
  };
  await analyticsUsersRoutes(req, res, url, PATH, ctx);
  return { captured, readBodyCount, cleanCount, rateLimitArgs, presenceStore };
}

describe('POST /api/presence input-validation guards (current behavior)', () => {
  it('returns 429 with the presence key and limit 120 and reads no body when rate limited', async () => {
    const { captured, readBodyCount, cleanCount, rateLimitArgs, presenceStore } = await invoke({
      body: { filePath: 'docs/intro.md', userId: 'alice' },
      rateLimitOk: false,
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many presence updates. Try again in a minute.' });
    // The rate-limit guard sits before the try block, so readBody never runs and the
    // store is never touched.
    assert.equal(readBodyCount, 0);
    assert.equal(cleanCount, 0);
    assert.deepEqual(presenceStore, {});
    // The handler keys the limiter on the socket address and allows 120 per window.
    assert.equal(rateLimitArgs.key, 'presence:127.0.0.1');
    assert.equal(rateLimitArgs.limit, 120);
  });

  it('returns 400 Missing filePath or userId for a falsy filePath or userId', async () => {
    // `!presencePath || !userId` rejects when either value is falsy, before any type
    // check or store write. Note that 0 and false are non-strings too, yet the Missing
    // guard claims them first precisely because they are falsy, so the type check below
    // never sees them.
    const bodies = [
      {},                                      // both omitted (undefined)
      { filePath: 'docs/x.md' },               // userId omitted
      { userId: 'alice' },                     // filePath omitted
      { filePath: '', userId: 'alice' },       // empty filePath
      { filePath: 'docs/x.md', userId: '' },   // empty userId
      { filePath: null, userId: 'alice' },
      { filePath: 'docs/x.md', userId: null },
      { filePath: 0, userId: 'alice' },        // falsy number, claimed before the type guard
      { filePath: 'docs/x.md', userId: false },// falsy boolean, claimed before the type guard
    ];
    for (const body of bodies) {
      const { captured, readBodyCount, cleanCount, presenceStore } = await invoke({ body });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Missing filePath or userId' });
      // readBody ran (the rate limit passed), but the guard returns before the store.
      assert.equal(readBodyCount, 1);
      assert.equal(cleanCount, 0);
      assert.deepEqual(presenceStore, {});
    }
  });

  it('returns 400 filePath and userId must be strings for a defined truthy non-string', async () => {
    // Falsy values were already claimed by the Missing guard, so this branch fires for
    // a truthy value whose type is not string. The `||` covers either field.
    const bodies = [
      { filePath: 123, userId: 'alice' },
      { filePath: 'docs/x.md', userId: 456 },
      { filePath: true, userId: 'alice' },
      { filePath: 'docs/x.md', userId: true },
      { filePath: {}, userId: 'alice' },
      { filePath: 'docs/x.md', userId: {} },
      { filePath: ['x'], userId: 'alice' },
      { filePath: 123, userId: 456 },          // both non-string still reports the strings error
    ];
    for (const body of bodies) {
      const { captured, readBodyCount, cleanCount, presenceStore } = await invoke({ body });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'filePath and userId must be strings' });
      assert.equal(readBodyCount, 1);
      assert.equal(cleanCount, 0);
      assert.deepEqual(presenceStore, {});
    }
  });

  it('returns 400 filePath or userId too long past 500 and 100 characters', async () => {
    // The length guard fires once `presencePath.length > 500` or `userId.length > 100`.
    // A 500-character filePath and a 100-character userId both clear it, but that
    // accepting case is out of scope here because it proceeds to the store write and
    // the live clock, which this deterministic guard suite avoids.
    const bodies = [
      { filePath: 'a'.repeat(501), userId: 'alice' },          // filePath one past the limit
      { filePath: 'docs/x.md', userId: 'a'.repeat(101) },      // userId one past the limit
      { filePath: 'a'.repeat(501), userId: 'a'.repeat(101) },  // both past the limit
    ];
    for (const body of bodies) {
      const { captured, readBodyCount, cleanCount, presenceStore } = await invoke({ body });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'filePath or userId too long' });
      assert.equal(readBodyCount, 1);
      assert.equal(cleanCount, 0);
      assert.deepEqual(presenceStore, {});
    }
  });

  it('checks the string-type guard before the length guard for an over-length array', async () => {
    // An array of 501 entries has a `.length` of 501, which would trip the length guard
    // if it were measured. The type check runs first, so the response is the strings
    // error rather than the length error, pinning the guard order.
    const { captured, cleanCount, presenceStore } = await invoke({
      body: { filePath: new Array(501).fill('x'), userId: 'alice' },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'filePath and userId must be strings' });
    assert.equal(cleanCount, 0);
    assert.deepEqual(presenceStore, {});
  });
});
