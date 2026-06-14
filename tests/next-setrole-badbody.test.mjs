import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load the real shipping module the way the
// sibling PUT badbody route tests do (see tests/next-reviewsput-badbody.test.mjs
// and tests/next-streak-badbody.test.mjs), so this pins the live
// PUT /api/users/:id/role handler rather than a copy.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

// SET_ROLE_RE matches /^\/api\/users\/[^/]+\/role$/, so a concrete :id segment
// drives the regex route. The userId value is irrelevant on the error path.
const SET_ROLE_PATHNAME = '/api/users/u1/role';
const REMOTE_ADDR = '203.0.113.7';

// The first inner validation guard inside the try. The outer catch must beat it
// whenever the destructure of a null body throws, so the null case returns the
// fixed 'Invalid request', never this message.
const INVALID_ROLE = 'Invalid role. Must be owner, editor, or viewer';

// Drive the real PUT /api/users/:id/role handler (analytics-users.js lines 84 to
// 115) over a minimal mocked ctx, exercising ONLY its outer catch. The handler
// shape is:
//
//   if (!rateLimit(`set-role:${req.socket.remoteAddress}`, 10)) return 429;  // gate, before the try
//   try {
//     const parts = pathname.split('/');                       // pure sync, cannot throw on a valid pathname
//     const userId = parts[3];                                 // pure sync, cannot throw
//     const body = await readBody(req);                        // first FAILABLE statement in the try
//     const {role, email, name, requesterId} = body;           // throws if body is null
//     if (!role || typeof role !== 'string' || !validRoles.includes(role)) return 400 {error: INVALID_ROLE};  // first inner guard
//     ... more validation ...
//     const users = loadJSON(USERS_FILE);                      // first store IO, only after the guards
//     ... saveJSON(USERS_FILE, users) ...
//     return json(res, 200, ...);
//   } catch {
//     return json(res, 400, {error: 'Invalid request'});
//   }
//
// The two leading statements are pure synchronous string and array work that
// cannot throw on a valid pathname, so readBody is the first failable step: any
// throw raised before the first loadJSON lands in the fixed 400 outer catch with
// zero store IO. This file pins both pre-IO throw sources:
//
//   1. readBody rejects: the catch fires before the destructure even runs.
//   2. readBody resolves null: the `const {role, ...} = null` destructure throws
//      into the SAME catch, so the response is the fixed 400, NOT the inner
//      INVALID_ROLE guard. That pins the precedence of the outer catch over the
//      first inner validation guard.
//
// loadJSON and saveJSON are zero-call tripwires: each increments a counter AND
// throws on contact. The counter===0 assertions are what actually prove the 400
// came from the pre-IO path, because a store call that threw would land in the
// same catch and return an identical 400. rateLimit returns true (its gate sits
// before the try) and is recorded so each case confirms it entered THIS handler
// through the set-role: rate-limit key.
//
// Determinism: the success path's only nondeterministic call is
// `new Date().toISOString()` for addedAt, which lives past the throw point, so
// the error path never reaches a clock and the golden stays stable.
async function runSetRolePut({ readBody: readBodyImpl, remoteAddress = REMOTE_ADDR }) {
  const calls = { rateLimit: [], readBody: 0, loadJSON: 0, saveJSON: 0 };
  let captured = null;

  const ctx = {
    rateLimit: (key, limit) => {
      calls.rateLimit.push({ key, limit });
      return true;
    },
    readBody: async (req) => {
      calls.readBody += 1;
      return readBodyImpl(req);
    },
    loadJSON: (fp) => {
      calls.loadJSON += 1;
      throw new Error(`loadJSON must not run on the pre-IO catch path (called with ${fp})`);
    },
    saveJSON: (fp) => {
      calls.saveJSON += 1;
      throw new Error(`saveJSON must not run on the pre-IO catch path (called with ${fp})`);
    },
    json: (_res, status, body) => {
      captured = { status, body };
      return captured;
    },
  };

  const url = new URL(`http://localhost${SET_ROLE_PATHNAME}`);
  const req = { method: 'PUT', socket: { remoteAddress } };
  const res = { writableEnded: false };
  await analyticsUsersRoutes(req, res, url, SET_ROLE_PATHNAME, ctx);
  return { captured, calls };
}

describe('PUT /api/users/:id/role outer-catch 400 badbody golden', () => {
  it('returns the fixed 400 {error: "Invalid request"} when readBody rejects, before any store IO', async () => {
    const { captured, calls } = await runSetRolePut({
      readBody: async () => { throw new Error('readBody boom'); },
    });

    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });

    // Entered this handler via its own set-role: gate (before the try), awaited
    // readBody once, then the catch fired before the first loadJSON: zero store IO.
    assert.deepEqual(calls.rateLimit, [{ key: `set-role:${REMOTE_ADDR}`, limit: 10 }]);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });

  it('returns the same fixed 400 {error: "Invalid request"} when readBody resolves null, beating the inner role guard, before any store IO', async () => {
    const { captured, calls } = await runSetRolePut({
      readBody: async () => null,
    });

    // The destructure of null throws into the outer catch, so the body is the
    // fixed 'Invalid request', never the first inner guard's message.
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.notDeepEqual(captured.body, { error: INVALID_ROLE });

    assert.deepEqual(calls.rateLimit, [{ key: `set-role:${REMOTE_ADDR}`, limit: 10 }]);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });
});
