import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load the REAL route module the way the sibling
// presence tests do (see tests/next-presence-protokey-guard.test.mjs and
// tests/next-presence-post-input-guards.test.mjs), so these cases exercise the
// shipped GET /api/presence handler rather than a reimplementation.
//
// No existing test drives the GET projection: the presence suites cover only
// POST /api/presence, and tests/next-presence-users.test.mjs exercises
// makePresenceStore().clean() in server-utils, never this route. So the {users}
// projection, the Missing-path 400 guard, and the absent-bucket fallback are
// pinned here for the first time. This file edits no source.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

// Drive the GET /api/presence handler with a minimal mocked ctx and capture the
// response handed to json(res, status, payload). The handler reads only json,
// cleanStalePresence, and presenceStore from ctx; it falls through every earlier
// method/pathname guard without touching their helpers, so nothing else is wired.
//
// cleanStalePresence is a counter, so each case pins both the projection AND how
// many times the handler cleaned stale presence (the Missing-path guard returns
// before the call; the success paths clean exactly once before the read). Object
// is intentionally NOT injected: Object.values and the prototype lookups keep
// their real global semantics, which case 4 relies on.
async function invokeGet({ path, presenceStore = {} } = {}) {
  const pathname = '/api/presence';
  const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`;
  const url = new URL(`http://localhost${pathname}${query}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let cleanCalls = 0;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    cleanStalePresence: () => { cleanCalls += 1; },
    presenceStore,
  };
  await analyticsUsersRoutes(req, res, url, pathname, ctx);
  return { ...captured, cleanCalls };
}

describe('analytics-users GET /api/presence list projection', () => {
  // 1. Both a missing `?path` (searchParams.get returns null) and an empty
  //    `?path=` (returns '') are falsy, so the `!presencePath` guard returns 400
  //    before cleanStalePresence runs.
  for (const { label, path } of [
    { label: 'missing (no ?path)', path: undefined },
    { label: 'empty (?path=)', path: '' },
  ]) {
    it(`returns 400 for a ${label} path and does not clean stale presence`, async () => {
      const r = await invokeGet({ path });
      assert.equal(r.status, 400);
      assert.deepStrictEqual(r.payload, { error: 'Missing path param' });
      assert.equal(r.cleanCalls, 0);
    });
  }

  // 2. A populated bucket projects Object.values(entries): the per-user records
  //    (the VALUES, not the keys), in insertion order. cleanStalePresence runs
  //    exactly once before the read.
  it('returns 200 with the bucket values in insertion order, cleaning once', async () => {
    const entries = {
      alice: { userId: 'alice', userName: 'Alice', cursor: null, lastSeen: 1000 },
      bob: { userId: 'bob', userName: 'Bob', cursor: { line: 3, ch: 7 }, lastSeen: 2000 },
    };
    const presenceStore = { 'docs/intro.md': entries };
    const r = await invokeGet({ path: 'docs/intro.md', presenceStore });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, {
      users: [
        { userId: 'alice', userName: 'Alice', cursor: null, lastSeen: 1000 },
        { userId: 'bob', userName: 'Bob', cursor: { line: 3, ch: 7 }, lastSeen: 2000 },
      ],
    });
    assert.equal(r.cleanCalls, 1);
  });

  // 3. An absent bucket (no own entry for the path) falls back to {} via the
  //    `|| {}` default, so Object.values is [] and the status is still 200. The
  //    cleanup still runs once before the read.
  it('returns 200 {users: []} for an absent bucket', async () => {
    const presenceStore = { 'docs/other.md': { x: { userId: 'x' } } };
    const r = await invokeGet({ path: 'docs/absent.md', presenceStore });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, { users: [] });
    assert.equal(r.cleanCalls, 1);
  });

  // 4. The lookup is a raw presenceStore[path], NOT an own-key guard, so unlike
  //    POST /api/presence (which screens PROTO_KEYS and uses Object.hasOwn) the
  //    GET path does no such guarding. A path equal to an inherited member such
  //    as 'toString' resolves to Object.prototype.toString, a function with no
  //    own enumerable properties, so the `|| {}` fallback is skipped (the
  //    function is truthy) yet Object.values(fn) is still [], giving 200
  //    {users: []}. Pinned to document the GET/POST asymmetry.
  it('does not own-key-guard: an inherited key like "toString" yields 200 {users: []}', async () => {
    const presenceStore = {};
    const r = await invokeGet({ path: 'toString', presenceStore });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, { users: [] });
    assert.equal(r.cleanCalls, 1);
  });
});
