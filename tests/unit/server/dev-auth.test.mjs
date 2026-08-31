/**
 * server/dev-auth.js: the root account and the passwordless local sign-in.
 *
 * This is the one place in the codebase that hands out a session without a
 * password, so the tests that matter most are the ones proving it refuses. Each
 * of the three guards is checked on its own, because a guard that only works
 * while the other two also hold is a guard that will be removed by someone
 * "simplifying" it.
 *
 * The module reads its flags once at load, so each configuration is a fresh
 * require.
 */
import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DEV_AUTH_PATH = require.resolve('../../../src/server/dev-auth.js');
const AUTH_PATH = require.resolve('../../../src/server/auth.js');
const DB_PATH = require.resolve('../../../src/server/db.js');
const ROLES_PATH = require.resolve('../../../src/server/roles.js');
const CHAT_PATH = require.resolve('../../../src/server/chat.js');
// Every module that closes over the database connection, so a reload under a
// different DATABASE_FILE gets a consistent set rather than a stale mix.
const MODULE_PATHS = [DEV_AUTH_PATH, AUTH_PATH, DB_PATH, ROLES_PATH, CHAT_PATH];

const ENV_KEYS = [
  'DEV_AUTOLOGIN', 'NODE_ENV', 'DATABASE_FILE', 'BETTER_AUTH_SECRET',
  'ENABLE_AUTH', 'ROOT_PASSWORD', 'ROOT_USERNAME', 'ROOT_EMAIL',
];

/** Load fresh copies of dev-auth (and, on request, auth/db) under `env`. */
function load(env, {withAuth = false} = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const p of MODULE_PATHS) delete require.cache[p];
  try {
    const devAuth = require('../../../src/server/dev-auth.js');
    const auth = withAuth ? require('../../../src/server/auth.js').auth : null;
    // Required here, not by the caller: the finally below restores the
    // environment, so a later require would load db.js against the default
    // DATABASE_FILE and read a different database than the one under test.
    const roles = withAuth ? require('../../../src/server/roles.js') : null;
    const db = withAuth ? require('../../../src/server/db.js').db : null;
    return {devAuth, auth, roles, db};
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const p of MODULE_PATHS) delete require.cache[p];
  }
}

/** A request from `address`, shaped the way node's http server presents one. */
const reqFrom = address => ({socket: {remoteAddress: address}, headers: {}});

/** Capture what a handler passes to json(res, status, body). */
function capture() {
  const calls = [];
  return {calls, json: (_res, status, body) => { calls.push({status, body}); }};
}

describe('DEV_AUTOLOGIN', () => {
  it('is off when the flag is unset', () => {
    assert.equal(load({DEV_AUTOLOGIN: undefined}).devAuth.DEV_AUTOLOGIN, false);
  });

  it('is on for exactly the string "true" outside production', () => {
    assert.equal(load({DEV_AUTOLOGIN: 'true', NODE_ENV: undefined}).devAuth.DEV_AUTOLOGIN, true);
  });

  // A production build must not be one stray variable away from giving out
  // sessions, so NODE_ENV overrides the flag rather than merely warning.
  it('is off in production even with the flag set', () => {
    assert.equal(load({DEV_AUTOLOGIN: 'true', NODE_ENV: 'production'}).devAuth.DEV_AUTOLOGIN, false);
  });

  for (const value of ['1', 'yes', 'TRUE', 'false', '']) {
    it(`stays off for DEV_AUTOLOGIN=${JSON.stringify(value)}`, () => {
      assert.equal(load({DEV_AUTOLOGIN: value, NODE_ENV: undefined}).devAuth.DEV_AUTOLOGIN, false);
    });
  }
});

describe('isLoopback', () => {
  const LOCAL = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  for (const addr of LOCAL) {
    it(`accepts ${addr}`, () => {
      assert.equal(load({}).devAuth.isLoopback(reqFrom(addr)), true);
    });
  }

  // 127.0.0.2 is loopback by netmask but is not what node reports for a normal
  // local connection, and accepting a whole /8 widens the door for no gain.
  const REMOTE = ['192.168.1.10', '10.0.0.5', '::ffff:192.168.1.10', '203.0.113.7', '127.0.0.2', undefined];
  for (const addr of REMOTE) {
    it(`rejects ${String(addr)}`, () => {
      assert.equal(load({}).devAuth.isLoopback(reqFrom(addr)), false);
    });
  }

  it('rejects a request with no socket at all', () => {
    assert.equal(load({}).devAuth.isLoopback({headers: {}}), false);
  });
});

describe('handleDevLogin refuses', () => {
  it('answers 404 when auto-login is off, revealing nothing about the route', async () => {
    const {devAuth} = load({DEV_AUTOLOGIN: undefined});
    const {calls, json} = capture();
    await devAuth.handleDevLogin(reqFrom('127.0.0.1'), {}, null, json);
    assert.equal(calls[0].status, 404);
    assert.deepEqual(calls[0].body, {error: 'Not found', path: '/api/dev-login'});
  });

  it('answers 404 in production even with the flag set', async () => {
    const {devAuth} = load({DEV_AUTOLOGIN: 'true', NODE_ENV: 'production'});
    const {calls, json} = capture();
    await devAuth.handleDevLogin(reqFrom('127.0.0.1'), {}, null, json);
    assert.equal(calls[0].status, 404);
  });

  // The flag being on is not enough: a machine reachable from the network must
  // not hand a root session to whoever asks.
  it('answers 403 to a non-loopback caller with the flag on', async () => {
    const {devAuth} = load({DEV_AUTOLOGIN: 'true', NODE_ENV: undefined});
    const {calls, json} = capture();
    await devAuth.handleDevLogin(reqFrom('192.168.1.50'), {}, null, json);
    assert.equal(calls[0].status, 403);
    assert.match(calls[0].body.error, /localhost only/);
  });

  it('never reaches the auth API on a refused request', async () => {
    const {devAuth} = load({DEV_AUTOLOGIN: 'true', NODE_ENV: undefined});
    const {json} = capture();
    // A null `auth` would throw if the handler touched it; a clean return proves
    // the guard rejected before any sign-in was attempted.
    await devAuth.handleDevLogin(reqFrom('8.8.8.8'), {}, null, json);
  });
});

describe('the no-auth development identity', () => {
  it('gets a real owner membership without bypassing workspace authorization', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-dev-identity-'));
    try {
      const {devAuth, db} = load({
        DATABASE_FILE: path.join(dir, 'development.db'),
        BETTER_AUTH_SECRET: 'test-secret-'.padEnd(48, 'd'),
      }, {withAuth: true});
      const first = devAuth.ensureDevelopmentWorkspace();
      const second = devAuth.ensureDevelopmentWorkspace();
      assert.equal(second.id, first.id, 'provisioning is idempotent');
      assert.deepEqual(
        db.prepare('SELECT role FROM member WHERE organizationId = ? AND userId = ?')
          .get(first.id, 'dev-user'),
        {role: 'owner'},
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM channel WHERE organizationId = ? AND name = ?')
          .get(first.id, devAuth.ROOT_CHANNEL).n,
        1,
      );
    } finally {
      try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* already gone */ }
    }
  });
});

describe('the root account', () => {
  let dir;
  let devAuth;
  let auth;
  let roles;
  let db;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-root-'));
    ({devAuth, auth, roles, db} = load({
      DEV_AUTOLOGIN: 'true',
      NODE_ENV: undefined,
      ENABLE_AUTH: 'true',
      DATABASE_FILE: path.join(dir, 'root.db'),
      BETTER_AUTH_SECRET: 'test-secret-'.padEnd(48, 'y'),
      ROOT_PASSWORD: 'root-test-password',
      ROOT_EMAIL: 'root@test.invalid',
    }, {withAuth: true}));
  });

  after(() => {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* already gone */ }
  });

  it('is created on the first call, as a real row', async () => {
    const report = await devAuth.ensureRootUser(auth);
    assert.equal(report.created, true);
    assert.equal(report.username, 'root');
    assert.ok(report.userId, 'has a generated id');
  });

  // Every restart after the first takes the sign-in path instead, which is the
  // branch that broke first in development.
  it('is reused, not recreated, on a second call', async () => {
    const first = await devAuth.ensureRootUser(auth);
    const second = await devAuth.ensureRootUser(auth);
    assert.equal(second.created, false, 'the account already existed');
    assert.equal(second.userId, first.userId, 'and it is the same account');
  });

  it('can sign in with the password it was created with', async () => {
    const result = await auth.api.signInEmail({
      body: {email: 'root@test.invalid', password: 'root-test-password'},
    });
    assert.ok(result.token, 'root is an ordinary account with a working password');
  });

  it('grants root the platform administrator role', async () => {
    const report = await devAuth.ensureRootUser(auth);
    assert.equal(roles.getRole(report.userId), 'admin');
  });

  it('reports no change when root is already a platform administrator', async () => {
    await devAuth.ensureRootUser(auth);
    const again = await devAuth.ensureRootUser(auth);
    assert.equal(again.grantedPlatformAdmin, false);
  });

  // The role is a foreign key to the user table now, so deleting the account
  // takes the role with it. The JSON store had no such link, which is how three
  // owners accumulated for a root that only ever existed once.
  it('leaves no orphan role behind when the account is deleted', async () => {
    const report = await devAuth.ensureRootUser(auth);
    assert.equal(roles.getRole(report.userId), 'admin');
    db.prepare('DELETE FROM "user" WHERE id = ?').run(report.userId);
    assert.equal(roles.getRole(report.userId), 'user', 'the role went with the user');
    assert.equal(roles.adminCount(), 0, 'and left no administrator row behind');
  });

  it('hands out a session to a loopback caller', async () => {
    await devAuth.ensureRootUser(auth);
    const {calls, json} = capture();
    const headers = {};
    const res = {setHeader: (name, value) => { headers[name] = value; }};
    await devAuth.handleDevLogin(reqFrom('127.0.0.1'), res, auth, json);
    assert.equal(calls[0].status, 200);
    assert.equal('token' in calls[0].body, false, 'the session is not readable by JavaScript');
    assert.match(headers['Set-Cookie'][0], /HttpOnly/, 'the session is an HttpOnly cookie');
    assert.equal(calls[0].body.user.name, devAuth.ROOT_NAME);
  });

  it('creates nothing at all when auto-login is off', async () => {
    const off = load({DEV_AUTOLOGIN: undefined}).devAuth;
    assert.equal(await off.ensureRootUser(auth), null);
  });

  /** The id of the organization with `slug`, whichever of the two it is. */
  const orgIdOf = slug => db.prepare('SELECT id FROM organization WHERE slug = ?').get(slug)?.id;

  // Chat is scoped to an organization and Better Auth creates none, so without
  // this a fresh database answers 409 to every chat endpoint and the CLI opens
  // on an empty rail.
  it('gives root an organization with a #general in it', async () => {
    await devAuth.ensureRootUser(auth);
    const channels = db
      .prepare('SELECT name, kind FROM channel WHERE organizationId = ?')
      .all(orgIdOf(devAuth.ROOT_ORG_SLUG));
    assert.deepEqual(channels, [{name: devAuth.ROOT_CHANNEL, kind: 'public'}]);
  });

  it('provisions the workspace once, not on every start', async () => {
    const again = await devAuth.ensureRootUser(auth);
    assert.equal(again.workspace.created, false, 'the workspace was already there');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM channel').get().n, 2,
      'root and demo each keep exactly one lifecycle-provisioned channel');
  });

  // The whole point of provisioning it: the one-click sign-in lands somewhere
  // with something in it, and lands in root's own rather than in the fixture.
  it('signs root in to that workspace, not the empty second one', async () => {
    await devAuth.ensureRootUser(auth);
    const {calls, json} = capture();
    const headers = {};
    const res = {setHeader: (name, value) => { headers[name] = value; }};
    await devAuth.handleDevLogin(reqFrom('127.0.0.1'), res, auth, json);

    const session = await auth.api.getSession({
      headers: {cookie: headers['Set-Cookie'][0].split(';')[0]},
    });
    assert.equal(session.session.activeOrganizationId, orgIdOf(devAuth.ROOT_ORG_SLUG));
  });

  // The fixture that gives the navbar switcher something to switch to.
  describe('the second workspace', () => {
    it('exists, with root as its owner', async () => {
      const {userId, demo} = await devAuth.ensureRootUser(auth);
      assert.equal(demo.name, devAuth.DEMO_ORG_NAME);
      const membership = db
        .prepare('SELECT role FROM member WHERE organizationId = ? AND userId = ?')
        .get(orgIdOf(devAuth.DEMO_ORG_SLUG), userId);
      assert.equal(membership.role, 'owner');
    });

    it('is immediately usable with its lifecycle-provisioned channel', async () => {
      await devAuth.ensureRootUser(auth);
      const channels = db
        .prepare('SELECT COUNT(*) AS n FROM channel WHERE organizationId = ?')
        .get(orgIdOf(devAuth.DEMO_ORG_SLUG));
      assert.equal(channels.n, 1);
    });

    it('leaves root in two workspaces, which is what the switcher needs', async () => {
      const {userId} = await devAuth.ensureRootUser(auth);
      // Ordered the way listMemberships and firstOrganizationOf order it. Both
      // break the same-millisecond tie on rowid, because the ids are random and
      // provisioning both workspaces takes less than a millisecond.
      const slugs = db
        .prepare(
          `SELECT o.slug FROM member m JOIN organization o ON o.id = m.organizationId
            WHERE m.userId = ? ORDER BY m.createdAt, m.rowid`,
        )
        .all(userId)
        .map(r => r.slug);
      assert.deepEqual(slugs, [devAuth.ROOT_ORG_SLUG, devAuth.DEMO_ORG_SLUG],
        'root\'s own first, so a new session opens there');
    });

    // Unlike the root workspace, this one is keyed on its slug rather than on
    // whether root has any organization: a fixture that disappears as soon as
    // you make a workspace of your own would be no use.
    it('is created once however many times the server starts', async () => {
      await devAuth.ensureRootUser(auth);
      await devAuth.ensureRootUser(auth);
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM organization WHERE slug = ?')
        .get(devAuth.DEMO_ORG_SLUG);
      assert.equal(count.n, 1);
    });

    it('takes root back in if the membership was removed but the workspace kept', async () => {
      const {userId} = await devAuth.ensureRootUser(auth);
      const demoId = orgIdOf(devAuth.DEMO_ORG_SLUG);
      db.prepare('DELETE FROM member WHERE organizationId = ? AND userId = ?').run(demoId, userId);

      await devAuth.ensureRootUser(auth);
      assert.ok(
        db.prepare('SELECT 1 FROM member WHERE organizationId = ? AND userId = ?').get(demoId, userId),
        'and does not fail on the unique slug trying to make a second one',
      );
    });
  });
});
