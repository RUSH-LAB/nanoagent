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
  for (const p of [DEV_AUTH_PATH, AUTH_PATH, DB_PATH]) delete require.cache[p];
  try {
    const devAuth = require('../../../src/server/dev-auth.js');
    const auth = withAuth ? require('../../../src/server/auth.js').auth : null;
    return {devAuth, auth};
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const p of [DEV_AUTH_PATH, AUTH_PATH, DB_PATH]) delete require.cache[p];
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

describe('the root account', () => {
  let dir;
  let devAuth;
  let auth;
  let usersFile;   // scratch role store; the real one must stay untouched

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-root-'));
    usersFile = path.join(dir, 'users.json');
    ({devAuth, auth} = load({
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
    const report = await devAuth.ensureRootUser(auth, usersFile);
    assert.equal(report.created, true);
    assert.equal(report.username, 'root');
    assert.ok(report.userId, 'has a generated id');
  });

  // Every restart after the first takes the sign-in path instead, which is the
  // branch that broke first in development.
  it('is reused, not recreated, on a second call', async () => {
    const first = await devAuth.ensureRootUser(auth, usersFile);
    const second = await devAuth.ensureRootUser(auth, usersFile);
    assert.equal(second.created, false, 'the account already existed');
    assert.equal(second.userId, first.userId, 'and it is the same account');
  });

  it('can sign in with the password it was created with', async () => {
    const result = await auth.api.signInEmail({
      body: {email: 'root@test.invalid', password: 'root-test-password'},
    });
    assert.ok(result.token, 'root is an ordinary account with a working password');
  });

  it('grants root the owner role in the store', async () => {
    const report = await devAuth.ensureRootUser(auth, usersFile);
    const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
    assert.equal(users[report.userId].role, 'owner', 'root is the first owner');
  });

  it('hands out a session to a loopback caller', async () => {
    await devAuth.ensureRootUser(auth, usersFile);
    const {calls, json} = capture();
    await devAuth.handleDevLogin(reqFrom('127.0.0.1'), {}, auth, json);
    assert.equal(calls[0].status, 200);
    assert.ok(calls[0].body.token, 'returns a usable session token');
    assert.equal(calls[0].body.user.username, 'root');
  });

  it('creates nothing at all when auto-login is off', async () => {
    const off = load({DEV_AUTOLOGIN: undefined}).devAuth;
    assert.equal(await off.ensureRootUser(auth), null);
  });
});

describe('grantOwner', () => {
  let dir;
  let devAuth;
  let usersFile;

  before(() => {
    // A scratch role store. The real one lives in the repo, and a test that
    // wrote through to it would leave the checkout dirty and race any other
    // suite reading it.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-owner-'));
    usersFile = path.join(dir, 'users.json');
    ({devAuth} = load({DEV_AUTOLOGIN: 'true', NODE_ENV: undefined}));
  });

  after(() => {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* already gone */ }
  });

  const read = () => JSON.parse(fs.readFileSync(usersFile, 'utf-8'));

  it('records a new user as owner and reports the change', () => {
    assert.equal(devAuth.grantOwner('owner-1', 'a@test.invalid', 'A', usersFile), true);
    assert.equal(read()['owner-1'].role, 'owner');
    assert.equal(read()['owner-1'].email, 'a@test.invalid');
  });

  it('is idempotent, reporting no change the second time', () => {
    devAuth.grantOwner('owner-2', 'b@test.invalid', 'B', usersFile);
    assert.equal(devAuth.grantOwner('owner-2', 'b@test.invalid', 'B', usersFile), false);
  });

  it('promotes an existing non-owner, keeping their original details', () => {
    const users = read();
    users['owner-3'] = {role: 'viewer', email: 'c@test.invalid', name: 'C', addedAt: '2020-01-01T00:00:00.000Z'};
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));

    assert.equal(devAuth.grantOwner('owner-3', 'ignored@test.invalid', 'Ignored', usersFile), true);
    const after = read()['owner-3'];
    assert.equal(after.role, 'owner');
    assert.equal(after.addedAt, '2020-01-01T00:00:00.000Z', 'the original join date survives');
    assert.equal(after.email, 'c@test.invalid', 'the existing email wins over the argument');
  });

  it('leaves other users untouched', () => {
    const before = Object.keys(read()).sort();
    devAuth.grantOwner('owner-4', 'd@test.invalid', 'D', usersFile);
    assert.deepEqual(Object.keys(read()).sort(), [...before, 'owner-4'].sort());
  });
});
