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
import {loadRoute, makeCtx, invoke, FILES, TEST_IDENTITY} from '../../_harness.mjs';

const routes = loadRoute('analytics-users');
const {ANALYTICS_FILE} = FILES;

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

// Every account on the server, across every organization, with addresses. That
// is the site owner's view, so each case below is asked as one and the refusal
// is the last of them. A member wanting to know who they work with reads their
// own organization's roster at GET /api/org/members instead.
describe('GET /api/users', () => {
  const OWNER = {id: 'u1', username: 'ann', email: 'ann@x', name: 'Ann', role: 'owner'};
  const ACCOUNTS = [OWNER, {id: 'u2', username: 'bo', email: 'bo@x', name: 'Bo', role: 'viewer'}];
  const asOwner = {...TEST_IDENTITY, userId: OWNER.id};

  it('lists every account with its role, keyed by id', async () => {
    const r = await invoke(routes, {path: '/api/users', ctx: makeCtx({users: ACCOUNTS}), auth: asOwner});
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.payload.users).sort(), ['u1', 'u2']);
    assert.equal(r.payload.users.u1.role, 'owner');
    assert.equal(r.payload.users.u2.username, 'bo');
  });

  // An account with no role row is still an account. Hiding it would make it
  // impossible to give anyone their first role through /admin.
  it('reports an account with no assigned role as a viewer', async () => {
    const ctx = makeCtx({users: [OWNER, {id: 'u3', username: 'cy', email: 'cy@x', name: 'Cy'}]});
    const r = await invoke(routes, {path: '/api/users', ctx, auth: asOwner});
    assert.equal(r.payload.users.u3.role, 'viewer');
  });

  // There is no answering this with nothing at all any more: a role belongs to
  // an account by foreign key, so somebody has to exist to be the owner asking.
  it('returns only the accounts that exist', async () => {
    const r = await invoke(routes, {path: '/api/users', ctx: makeCtx({users: [OWNER]}), auth: asOwner});
    assert.deepEqual([r.status, Object.keys(r.payload.users)], [200, ['u1']]);
  });

  it('refuses anyone who is not an owner, without naming a single account', async () => {
    const r = await invoke(routes, {path: '/api/users', ctx: makeCtx({users: ACCOUNTS})});
    assert.equal(r.status, 403);
    assert.equal(r.payload.code, 'not-owner');
    assert.equal(r.payload.users, undefined);
  });
});

describe('GET /api/users/me', () => {
  const ACCOUNTS = [{id: 'u1', username: 'ed', email: 'e@x', name: 'Ed', role: 'editor'}];
  const asUser = userId => ({...TEST_IDENTITY, userId});

  it('answers for the session subject, not for a userId in the query', async () => {
    const ctx = makeCtx({users: ACCOUNTS});
    const r = await invoke(routes, {path: '/api/users/me', query: {userId: 'u1'}, ctx});
    // Signed in as TEST_IDENTITY, who holds no role, so naming a real editor in
    // the query buys the caller nothing.
    assert.deepEqual([r.status, r.payload], [200, {
      userId: TEST_IDENTITY.userId, orgId: null, orgRole: null, role: 'viewer',
    }]);
  });

  it('reports the role the caller actually holds', async () => {
    const ctx = makeCtx({users: ACCOUNTS});
    const r = await invoke(routes, {path: '/api/users/me', ctx, auth: asUser('u1')});
    assert.deepEqual([r.status, r.payload], [200, {
      userId: 'u1', orgId: null, orgRole: null, role: 'editor',
    }]);
  });

  it('passes the active organization through from the session', async () => {
    const auth = {userId: 'u1', orgId: 'org_1', orgRole: 'admin', sessionId: 'sess_1'};
    const r = await invoke(routes, {path: '/api/users/me', ctx: makeCtx({users: ACCOUNTS}), auth});
    assert.deepEqual([r.payload.orgId, r.payload.orgRole], ['org_1', 'admin']);
  });

  it('falls back to viewer for an account with no role', async () => {
    const r = await invoke(routes, {path: '/api/users/me', ctx: makeCtx({users: ACCOUNTS}), auth: asUser('nobody')});
    assert.equal(r.payload.role, 'viewer');
  });
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
  const BOSS = TEST_IDENTITY.userId;
  // The requester is the session subject, so the owner is filed under the id
  // the harness signs requests as.
  const withOwner = (extra = []) => makeCtx({
    users: [
      {id: BOSS, username: 'boss', email: 'boss@x', name: 'Boss', role: 'owner'},
      {id: 'u1', username: 'one', email: 'one@x', name: 'One', role: 'viewer'},
      ...extra,
    ],
  });

  it('returns 429 before any validation', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'set-role:127.0.0.1', maxPerMinute: 10}]);
  });

  const ROLE_ERR = 'Invalid role. Must be owner, editor, viewer';
  const BAD_ROLES = [
    ['a missing role', {}],
    ['a non-string role', {role: 7}],
    ['an empty-string role', {role: ''}],
    ['an out-of-list role', {role: 'admin'}],
    // The allow-list is case-sensitive.
    ['a wrong-case role', {role: 'Owner'}],
  ];
  for (const [name, body] of BAD_ROLES) {
    it(`rejects ${name} without changing anything`, async () => {
      const ctx = withOwner();
      const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: ROLE_ERR}]);
      assert.equal(ctx.roles.getRole('u1'), 'viewer', 'the role is unchanged');
    });
  }

  it('rejects a non-owner with 403', async () => {
    const ctx = makeCtx({users: [{id: BOSS, role: 'editor'}, {id: 'u1', role: 'viewer'}]});
    const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, body: {role: 'owner'}, ctx});
    assert.deepEqual([r.status, r.payload], [403, {error: 'Only owners can change roles'}]);
    assert.equal(ctx.roles.getRole('u1'), 'viewer');
  });

  it('ignores a requesterId in the body naming a real owner', async () => {
    // The old handler read the requester straight out of the posted JSON, so
    // this body alone was enough to promote yourself.
    const ctx = makeCtx({users: [
      {id: 'owner1', role: 'owner'},
      {id: BOSS, role: 'editor'},
      {id: 'u1', role: 'viewer'},
    ]});
    const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, body: {role: 'owner', requesterId: 'owner1'}, ctx});
    assert.deepEqual([r.status, r.payload], [403, {error: 'Only owners can change roles'}]);
  });

  it('rejects a role for a user who does not exist', async () => {
    const ctx = withOwner();
    const r = await invoke(routes, {method: 'PUT', path: '/api/users/ghost/role', body: {role: 'editor'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'No such user'}]);
  });

  // Demoting the last owner would leave nobody able to promote anyone, with no
  // way back short of editing the database by hand.
  it('refuses to demote the last owner', async () => {
    const ctx = withOwner();
    const r = await invoke(routes, {method: 'PUT', path: `/api/users/${BOSS}/role`, body: {role: 'viewer'}, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'Cannot demote the last owner'}]);
    assert.equal(ctx.roles.getRole(BOSS), 'owner');
  });

  it('allows demoting an owner while another remains', async () => {
    const ctx = withOwner([{id: 'u2', username: 'two', email: 'two@x', name: 'Two', role: 'owner'}]);
    const r = await invoke(routes, {method: 'PUT', path: '/api/users/u2/role', body: {role: 'viewer'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(ctx.roles.getRole('u2'), 'viewer');
  });

  it('promotes a user and reports the new role', async () => {
    const ctx = withOwner();
    const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, body: {role: 'editor'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, user: {userId: 'u1', role: 'editor'}}]);
    assert.equal(ctx.roles.getRole('u1'), 'editor');
  });

  for (const role of ['owner', 'editor', 'viewer']) {
    it(`accepts the valid role ${JSON.stringify(role)}`, async () => {
      const ctx = withOwner();
      const r = await invoke(routes, {method: 'PUT', path: ROLE_PATH, body: {role}, ctx});
      assert.equal(r.status, 200, `role ${role}`);
      assert.equal(ctx.roles.getRole('u1'), role);
    });
  }
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
