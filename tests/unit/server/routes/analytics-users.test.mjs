/**
 * server/routes/analytics-users.js: pageview recording, analytics readout, the
 * user list and role assignment, and the ephemeral presence store.
 *
 * Consolidated from the fifteen per-branch suites that used to cover this
 * module. Three stores here are keyed by request-controlled strings (analytics
 * counts, users, presence), so much of this pins the proto-key and
 * own-property guards that keep such a key off Object.prototype.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke, FILES} from '../../_harness.mjs';

const routes = loadRoute('analytics-users');
const {ANALYTICS_FILE, USERS_FILE} = FILES;

/** The three keys the module refuses outright (its frozen PROTO_KEYS). */
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];
/** Truthy inherited members that PROTO_KEYS does NOT screen. */
const INHERITED_KEYS = ['toString', 'valueOf', 'hasOwnProperty'];

// ── Analytics ─────────────────────────────────────────────────────────────

describe('POST /api/analytics/pageview', () => {
  it('returns 429 with the pageview key and limit 60, doing no IO', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/analytics/pageview', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'pageview:127.0.0.1', maxPerMinute: 60}]);
    assert.equal(reads, 0);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  const GUARDS = [
    {name: 'an omitted path', body: {}, error: 'Missing path'},
    {name: 'an empty-string path', body: {path: ''}, error: 'Missing path'},
    {name: 'a non-string path', body: {path: 7}, error: 'Missing path'},
    {name: 'a 501-character path', body: {path: 'p'.repeat(501)}, error: 'Path too long'},
    {name: 'a non-string referrer', body: {path: '/p', referrer: 7}, error: 'referrer must be a string'},
    {name: 'a non-string userAgent', body: {path: '/p', userAgent: 7}, error: 'userAgent must be a string'},
    // referrer is checked first, so a body failing both reports referrer.
    {name: 'both referrer and userAgent non-string, reporting referrer first', body: {path: '/p', referrer: 7, userAgent: 7}, error: 'referrer must be a string'},
    ...PROTO_KEYS.map(path => ({name: `the proto path ${JSON.stringify(path)}`, body: {path}, error: 'Invalid path'})),
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/analytics/pageview', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('increments the per-path count and unshifts a recent entry', async () => {
    const ctx = makeCtx({store: {[ANALYTICS_FILE]: {counts: {'/p': 2}, recent: [{path: '/old'}]}}});
    const r = await invoke(routes, {method: 'POST', path: '/api/analytics/pageview', body: {path: '/p', referrer: '/from', userAgent: 'UA'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    const saved = ctx.store[ANALYTICS_FILE];
    assert.equal(saved.counts['/p'], 3);
    assert.equal(saved.recent.length, 2);
    assert.equal(saved.recent[1].path, '/old', 'the new entry goes to the front');
    const {timestamp, ...head} = saved.recent[0];
    assert.deepEqual(head, {path: '/p', referrer: '/from', userAgent: 'UA'});
    assert.ok(timestamp);
  });

  it('nulls an omitted referrer and userAgent and initialises an empty store', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'POST', path: '/api/analytics/pageview', body: {path: '/p'}, ctx});
    const saved = ctx.store[ANALYTICS_FILE];
    assert.deepEqual(saved.counts, {'/p': 1});
    assert.equal(saved.recent[0].referrer, null);
    assert.equal(saved.recent[0].userAgent, null);
  });

  it('caps the recent list at 100 entries', async () => {
    const recent = Array.from({length: 100}, (_, i) => ({path: `/old${i}`}));
    const ctx = makeCtx({store: {[ANALYTICS_FILE]: {counts: {}, recent}}});
    await invoke(routes, {method: 'POST', path: '/api/analytics/pageview', body: {path: '/new'}, ctx});
    const saved = ctx.store[ANALYTICS_FILE];
    assert.equal(saved.recent.length, 100);
    assert.equal(saved.recent[0].path, '/new');
    assert.equal(saved.recent.at(-1).path, '/old98', 'the oldest entry is dropped');
  });
});

describe('GET /api/analytics', () => {
  const PROJECTIONS = [
    {name: 'a populated store', stored: {counts: {'/a': 1}, recent: [{path: '/a'}]}, expected: {pageviews: {'/a': 1}, recent: [{path: '/a'}]}},
    {name: 'an empty store', stored: {}, expected: {pageviews: {}, recent: []}},
    {name: 'counts present but recent absent', stored: {counts: {'/a': 1}}, expected: {pageviews: {'/a': 1}, recent: []}},
    {name: 'recent present but counts absent', stored: {recent: [{path: '/a'}]}, expected: {pageviews: {}, recent: [{path: '/a'}]}},
  ];
  for (const {name, stored, expected} of PROJECTIONS) {
    it(`projects ${name}`, async () => {
      const r = await invoke(routes, {path: '/api/analytics', ctx: makeCtx({store: {[ANALYTICS_FILE]: stored}})});
      assert.deepEqual([r.status, r.payload], [200, expected]);
    });
  }
});

// ── Users ─────────────────────────────────────────────────────────────────

describe('GET /api/users', () => {
  it('returns the whole store under {users}', async () => {
    const users = {u1: {role: 'owner'}, u2: {role: 'viewer'}};
    const r = await invoke(routes, {path: '/api/users', ctx: makeCtx({store: {[USERS_FILE]: users}})});
    assert.deepEqual([r.status, r.payload], [200, {users}]);
  });

  it('projects the loadJSON result by reference rather than copying it', async () => {
    const loaded = {u1: {role: 'owner'}};
    const r = await invoke(routes, {path: '/api/users', ctx: makeCtx({loadJSON: () => loaded})});
    assert.strictEqual(r.payload.users, loaded);
  });

  it('returns an empty object for a missing store', async () => {
    const r = await invoke(routes, {path: '/api/users'});
    assert.deepEqual([r.status, r.payload], [200, {users: {}}]);
  });
});

describe('GET /api/users/me', () => {
  const USERS = {u1: {role: 'editor', email: 'e@x', name: 'Ed'}};

  it('returns 400 when userId is missing', async () => {
    const r = await invoke(routes, {path: '/api/users/me'});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing userId'}]);
  });

  it('returns the role, email and name for a real user', async () => {
    const r = await invoke(routes, {path: '/api/users/me', query: {userId: 'u1'}, ctx: makeCtx({store: {[USERS_FILE]: USERS}})});
    assert.deepEqual([r.status, r.payload], [200, {role: 'editor', email: 'e@x', name: 'Ed'}]);
  });

  // A request-controlled id such as `constructor` resolves to a truthy
  // inherited value, which without the own-key guard would leak
  // {role: undefined, ...} instead of the viewer default.
  for (const userId of [...PROTO_KEYS, ...INHERITED_KEYS, 'absent']) {
    it(`returns the viewer default for the non-own id ${JSON.stringify(userId)}`, async () => {
      const r = await invoke(routes, {path: '/api/users/me', query: {userId}, ctx: makeCtx({store: {[USERS_FILE]: USERS}})});
      assert.deepEqual([r.status, r.payload], [200, {role: 'viewer'}]);
    });
  }
});

describe('SET_ROLE_RE', () => {
  const {SET_ROLE_RE} = routes;

  it('is one shared, stateless instance', () => {
    // No /g and no /y, so .test() never reads or mutates lastIndex.
    assert.equal(SET_ROLE_RE.global, false);
    assert.equal(SET_ROLE_RE.sticky, false);
    assert.strictEqual(loadRoute('analytics-users').SET_ROLE_RE, SET_ROLE_RE);
    const path = '/api/users/u1/role';
    assert.deepEqual([SET_ROLE_RE.test(path), SET_ROLE_RE.test(path)], [true, true]);
  });

  const MATCHES = [
    ['/api/users/u1/role', true],
    ['/api/users/user-with-dashes/role', true],
    ['/api/users/u1/role/extra', false],
    ['/api/users/u1', false],
    ['/api/users//role', false],
  ];
  for (const [path, expected] of MATCHES) {
    it(`${expected ? 'matches' : 'rejects'} ${JSON.stringify(path)}`, () => {
      assert.equal(SET_ROLE_RE.test(path), expected);
    });
  }
});

describe('PUT /api/users/:id/role', () => {
  const ROLE_PATH = '/api/users/u1/role';
  const OWNER = {[USERS_FILE]: {boss: {role: 'owner'}}};

  it('returns 429 before any validation', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'set-role:127.0.0.1', maxPerMinute: 10}]);
  });

  const ROLE_ERR = 'Invalid role. Must be owner, editor, or viewer';
  const GUARDS = [
    {name: 'a missing role', body: {}, status: 400, error: ROLE_ERR},
    {name: 'a non-string role', body: {role: 7}, status: 400, error: ROLE_ERR},
    {name: 'an empty-string role', body: {role: ''}, status: 400, error: ROLE_ERR},
    {name: 'an out-of-list role', body: {role: 'admin'}, status: 400, error: ROLE_ERR},
    // The allow-list is case-sensitive.
    {name: 'a wrong-case role', body: {role: 'Owner'}, status: 400, error: ROLE_ERR},
    {name: 'a missing requesterId', body: {role: 'editor'}, status: 403, error: 'Missing or invalid requesterId'},
    {name: 'a non-string requesterId', body: {role: 'editor', requesterId: 7}, status: 403, error: 'Missing or invalid requesterId'},
    {name: 'a non-string email', body: {role: 'editor', requesterId: 'boss', email: 7}, status: 400, error: 'email must be a string'},
    {name: 'a non-string name', body: {role: 'editor', requesterId: 'boss', name: 7}, status: 400, error: 'name must be a string'},
    ...PROTO_KEYS.map(id => ({name: `the proto requesterId ${JSON.stringify(id)}`, body: {role: 'editor', requesterId: id}, status: 400, error: 'Invalid requesterId'})),
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx({store: structuredClone(OWNER)});
      const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  for (const userId of PROTO_KEYS) {
    it(`rejects the proto target userId ${JSON.stringify(userId)}`, async () => {
      const ctx = makeCtx({store: structuredClone(OWNER)});
      const body = {role: 'editor', requesterId: 'boss'};
      const r = await invoke(routes, {method: 'PUT', path: `/api/users/${userId}/role`, body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid userId'}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('advances past the role guard for every valid role', async () => {
    for (const role of ['owner', 'editor', 'viewer']) {
      const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, body: {role}, ctx: makeCtx()});
      assert.deepEqual([r.status, r.payload], [403, {error: 'Missing or invalid requesterId'}], `role ${role}`);
    }
  });

  const NON_OWNERS = [
    {name: 'an unknown requester', users: {}},
    {name: 'an editor requester', users: {boss: {role: 'editor'}}},
  ];
  for (const {name, users} of NON_OWNERS) {
    it(`rejects ${name} with 403`, async () => {
      const ctx = makeCtx({store: {[USERS_FILE]: users}});
      const body = {role: 'editor', requesterId: 'boss'};
      const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [403, {error: 'Only owners can change roles'}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('creates a brand-new user with a fresh record', async () => {
    const ctx = makeCtx({store: structuredClone(OWNER)});
    const body = {role: 'editor', requesterId: 'boss', email: 'new@x', name: 'New'};
    const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, body, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.success, true);
    assert.deepEqual(Object.keys(r.payload.user).sort(), ['addedAt', 'email', 'name', 'role']);
    const {addedAt, ...stable} = r.payload.user;
    assert.deepEqual(stable, {role: 'editor', email: 'new@x', name: 'New'});
    assert.deepEqual(ctx.store[USERS_FILE].u1, r.payload.user);
  });

  it('preserves the existing email, name and addedAt when the body omits them', async () => {
    const existing = {role: 'viewer', email: 'old@x', name: 'Old', addedAt: '2020-01-01T00:00:00.000Z'};
    const ctx = makeCtx({store: {[USERS_FILE]: {boss: {role: 'owner'}, u1: existing}}});
    const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, body: {role: 'owner', requesterId: 'boss'}, ctx});
    assert.deepEqual(r.payload.user, {role: 'owner', email: 'old@x', name: 'Old', addedAt: '2020-01-01T00:00:00.000Z'});
  });

  it('defaults email and name to empty strings for a new user with neither supplied', async () => {
    const ctx = makeCtx({store: structuredClone(OWNER)});
    const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, body: {role: 'viewer', requesterId: 'boss'}, ctx});
    assert.equal(r.payload.user.email, '');
    assert.equal(r.payload.user.name, '');
  });
});

describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/analytics/pageview'},
    {method: 'PUT', path: '/api/users/u1/role'},
  ];
  for (const {method, path: p} of CASES) {
    for (const [label, readBody] of [
      ['readBody rejects', async () => { throw new Error('bad json'); }],
      ['readBody resolves null', async () => null],
    ]) {
      it(`${method} ${p} returns 400 Invalid request when ${label}, with no store IO`, async () => {
        const ctx = makeCtx({readBody});
        const r = await invoke(routes, {method, path: p, ctx});
        assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
        assert.deepEqual(ctx.calls.saveJSON, []);
      });
    }
  }
});
