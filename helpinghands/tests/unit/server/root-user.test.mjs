/**
 * server/root-user.js: the root account on SQLite.
 *
 * Root is the GitHub account named by ROOT_GITHUB_LOGIN. GitHub's API is the
 * one part replaced, by a fake that answers for the profiles a test names;
 * everything from the account rows to the session is the real Better Auth.
 *
 * The modules read their configuration once at load, so each configuration is
 * a fresh require.
 */
import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sessionCookie} from './_github-account.mjs';

const require = createRequire(import.meta.url);
const ROOT_USER_PATH = require.resolve('../../../src/server/root-user.js');
const AUTH_PATH = require.resolve('../../../src/server/auth.js');
const DB_PATH = require.resolve('../../../src/server/db.js');
const ROLES_PATH = require.resolve('../../../src/server/roles.js');
const CHAT_PATH = require.resolve('../../../src/server/chat.js');
// Every module that closes over the database connection, so a reload under a
// different DATABASE_FILE gets a consistent set rather than a stale mix.
const MODULE_PATHS = [ROOT_USER_PATH, AUTH_PATH, DB_PATH, ROLES_PATH, CHAT_PATH];

const ENV_KEYS = [
  'NODE_ENV', 'DATABASE_FILE', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
];

/** Load fresh copies of root-user, auth, and db under `env`. */
function load(env) {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const p of MODULE_PATHS) delete require.cache[p];
  try {
    const rootUser = require('../../../src/server/root-user.js');
    const auth = require('../../../src/server/auth.js').auth;
    // Required here, not by the caller: the finally below restores the
    // environment, so a later require would load db.js against the default
    // DATABASE_FILE and read a different database than the one under test.
    const roles = require('../../../src/server/roles.js');
    const db = require('../../../src/server/db.js').db;
    return {rootUser, auth, roles, db};
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const p of MODULE_PATHS) delete require.cache[p];
  }
}

/** GitHub's users API, knowing only `profiles`. */
function fakeGithub(...profiles) {
  return async url => {
    const profile = profiles.find(p => url.endsWith(`/users/${p.login}`));
    return profile
      ? {ok: true, status: 200, json: async () => profile}
      : {ok: false, status: 404, json: async () => ({message: 'Not Found'})};
  };
}

const ROOT = {id: 4242, login: 'root-login', name: 'Root Person', email: null, avatar_url: 'https://avatars.test/4242'};
const asRoot = {login: ROOT.login, fetchImpl: fakeGithub(ROOT)};

describe('the root account', () => {
  let dir;
  let rootUser;
  let auth;
  let roles;
  let db;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-root-'));
    ({rootUser, auth, roles, db} = load({
      NODE_ENV: undefined,
      GITHUB_CLIENT_ID: 'test-client',
      GITHUB_CLIENT_SECRET: 'test-secret',
      DATABASE_FILE: path.join(dir, 'root.db'),
      BETTER_AUTH_SECRET: 'test-secret-'.padEnd(48, 'y'),
    }));
  });

  after(() => {
    try { fs.rmSync(dir, {recursive: true, force: true}); } catch { /* already gone */ }
  });

  /** The GitHub account id root's user signs in with. */
  const githubIdOf = userId => db
    .prepare('SELECT accountId FROM account WHERE userId = ? AND providerId = ?').get(userId, 'github')?.accountId;

  it('needs ROOT_GITHUB_LOGIN', async () => {
    await assert.rejects(() => rootUser.ensureRootUser(auth, {login: '', fetchImpl: fakeGithub()}), /ROOT_GITHUB_LOGIN/);
  });

  it('fails when GitHub has no such user', async () => {
    await assert.rejects(
      () => rootUser.ensureRootUser(auth, {login: 'nobody-here', fetchImpl: fakeGithub(ROOT)}),
      /GitHub has no user nobody-here/,
    );
  });

  it('is created on the first call, tied to the GitHub account id', async () => {
    const report = await rootUser.ensureRootUser(auth, asRoot);
    assert.equal(report.created, true);
    assert.equal(report.login, ROOT.login);
    assert.equal(githubIdOf(report.userId), String(ROOT.id));
    const user = db.prepare('SELECT name, email, emailVerified FROM "user" WHERE id = ?').get(report.userId);
    assert.deepEqual(user, {name: ROOT.name, email: '4242+root-login@users.noreply.github.com', emailVerified: 1});
  });

  it('is reused, not recreated, on a second call', async () => {
    const first = await rootUser.ensureRootUser(auth, asRoot);
    const second = await rootUser.ensureRootUser(auth, asRoot);
    assert.equal(second.created, false, 'the account already existed');
    assert.equal(second.userId, first.userId, 'and it is the same account');
  });

  // A login can be renamed and claimed by someone else; the id cannot.
  it('follows the GitHub account id, not the login', async () => {
    const first = await rootUser.ensureRootUser(auth, asRoot);
    const renamed = {...ROOT, login: 'root-renamed'};
    const again = await rootUser.ensureRootUser(auth, {login: renamed.login, fetchImpl: fakeGithub(renamed)});
    assert.equal(again.userId, first.userId);
  });

  it('grants root the platform administrator role', async () => {
    const report = await rootUser.ensureRootUser(auth, asRoot);
    assert.equal(roles.getRole(report.userId), 'admin');
  });

  it('reports no change when root is already a platform administrator', async () => {
    await rootUser.ensureRootUser(auth, asRoot);
    const again = await rootUser.ensureRootUser(auth, asRoot);
    assert.equal(again.grantedPlatformAdmin, false);
  });

  // The role is a foreign key to the user table now, so deleting the account
  // takes the role with it. The JSON store had no such link, which is how three
  // owners accumulated for a root that only ever existed once.
  it('leaves no orphan role behind when the account is deleted', async () => {
    const report = await rootUser.ensureRootUser(auth, asRoot);
    assert.equal(roles.getRole(report.userId), 'admin');
    db.prepare('DELETE FROM "user" WHERE id = ?').run(report.userId);
    assert.equal(roles.getRole(report.userId), 'user', 'the role went with the user');
    assert.equal(roles.adminCount(), 0, 'and left no administrator row behind');
  });

  // Somebody who already has root's public GitHub email, say from before
  // GitHub was the only sign-in, becomes root rather than gaining a twin.
  it('links GitHub to a verified account that already has root\'s email', async () => {
    const withEmail = {...ROOT, id: 5151, login: 'root-with-email', email: 'Root@Example.test'};
    const {internalAdapter} = await auth.$context;
    const existing = await internalAdapter.createUser({name: 'Old Root', email: 'root@example.test', emailVerified: true});
    const report = await rootUser.ensureRootUser(auth, {login: withEmail.login, fetchImpl: fakeGithub(withEmail)});
    assert.equal(report.userId, existing.id);
    assert.equal(githubIdOf(existing.id), '5151');
  });

  it('refuses to link GitHub to an unverified account with root\'s email', async () => {
    const withEmail = {...ROOT, id: 6161, login: 'root-unverified', email: 'unverified@example.test'};
    const at = new Date().toISOString();
    db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)')
      .run('unverified-user', 'Unverified', 'unverified@example.test', at, at);
    await assert.rejects(
      () => rootUser.ensureRootUser(auth, {login: withEmail.login, fetchImpl: fakeGithub(withEmail)}),
      /An unverified account already uses unverified@example.test/,
    );
  });

  /** The id of the organization with `slug`, whichever of the two it is. */
  const orgIdOf = slug => db.prepare('SELECT id FROM organization WHERE slug = ?').get(slug)?.id;

  // Chat is scoped to an organization and Better Auth creates none, so without
  // this a fresh database answers 409 to every chat endpoint and the CLI opens
  // on an empty rail.
  it('gives root an organization with a #general in it', async () => {
    await rootUser.ensureRootUser(auth, asRoot);
    const channels = db
      .prepare('SELECT name, kind FROM channel WHERE organizationId = ?')
      .all(orgIdOf(rootUser.ROOT_ORG_SLUG));
    assert.deepEqual(channels, [{name: rootUser.ROOT_CHANNEL, kind: 'public'}]);
  });

  it('provisions the workspace once, not on every start', async () => {
    const again = await rootUser.ensureRootUser(auth, asRoot);
    assert.equal(again.workspace.created, false, 'the workspace was already there');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM channel').get().n, 1,
      'root keeps exactly one lifecycle-provisioned channel');
  });

  // The whole point of provisioning it: root's sign-in lands somewhere with
  // something in it.
  it('opens root\'s sessions in its workspace', async () => {
    const {userId} = await rootUser.ensureRootUser(auth, asRoot);
    const session = await auth.api.getSession({headers: {cookie: await sessionCookie(auth, userId)}});
    assert.equal(session.session.activeOrganizationId, orgIdOf(rootUser.ROOT_ORG_SLUG));
  });
});
