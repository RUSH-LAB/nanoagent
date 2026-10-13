/**
 * server/auth.js: the single place the API decides who is calling.
 *
 * The resolveIdentity cases are not mocked. They stand up a real Better Auth
 * instance over a throwaway SQLite file, create GitHub accounts and sessions
 * through its own adapter, and hand the session cookie back to resolveIdentity. That is
 * worth the few milliseconds: the thing most likely to break here is the wiring
 * between Better Auth, the schema in migrations/, and the identity shape the
 * handlers destructure, and none of that is exercised by a stub.
 *
 * The module reads its environment once at load, so cases that
 * need a different configuration reload it through a fresh require.
 */
import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {githubAccount, sessionCookie} from './_github-account.mjs';

const require = createRequire(import.meta.url);
const AUTH_PATH = require.resolve('../../../src/server/auth.js');
const DB_PATH = require.resolve('../../../src/server/db.js');

/** Load a fresh copy of server/auth.js (and its db) under the given environment. */
function loadAuth(env) {
  const saved = {};
  for (const k of ['DATABASE_FILE', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[AUTH_PATH];
  delete require.cache[DB_PATH];
  try {
    return require('../../../src/server/auth.js');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[AUTH_PATH];
    delete require.cache[DB_PATH];
  }
}

const req = headers => ({headers});
const GITHUB = {GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret'};
const authModule = loadAuth({DATABASE_FILE: undefined, ...GITHUB});

describe('isPublicPath', () => {
  for (const p of ['/api/health']) {
    it(`treats ${p} as public`, () => {
      assert.equal(authModule.isPublicPath(p), true);
    });
  }

  // Gating sign-in behind sign-in would lock everybody out, so the whole Better
  // Auth prefix is public and does its own authorization.
  for (const p of ['/api/auth/sign-in/social', '/api/auth/callback/github', '/api/auth/device/token', '/api/auth/get-session']) {
    it(`treats ${p} as public, because that is where a caller goes to get a session`, () => {
      assert.equal(authModule.isPublicPath(p), true);
    });
  }

  for (const p of ['/api/users', '/api/users/me', '/api/logs', '/api/preferences', '/api/feed', '/api/feed/rss', '/api/feed/atom', '/api/workspaces/ws/feed/rss', '/api/authx', '/']) {
    it(`treats ${p} as requiring a session`, () => {
      assert.equal(authModule.isPublicPath(p), false);
    });
  }
});

// One unauthenticated read, matched by shape rather than by prefix. Somebody
// following an invitation link has no session and cannot make an account with
// the right address until they are told which address was invited; accepting
// the invitation is a different path and still needs the session.
describe('isPublicPath for an invitation link', () => {
  it('lets the link itself be read', () => {
    assert.equal(authModule.isPublicPath('/api/invite/inv_abc123'), true);
  });

  const GUARDED = [
    '/api/invite/inv_abc123/accept',
    '/api/invite/inv_abc123/anything',
    '/api/invite',
    '/api/invite/',
    '/api/invitex/inv_abc123',
    '/api/org/invitations/inv_abc123',
  ];
  for (const p of GUARDED) {
    it(`still requires a session for ${p}`, () => {
      assert.equal(authModule.isPublicPath(p), false);
    });
  }
});

describe('isSafeId', () => {
  it('accepts a generated Better Auth id', () => {
    assert.equal(authModule.isSafeId('vWm7Ls6392wGlXsU6kfwCyrfVx3Ng5T8'), true);
  });

  it('accepts an id of exactly the 200 character limit', () => {
    assert.equal(authModule.isSafeId('u'.repeat(200)), true);
  });

  const REJECTED = [
    ['__proto__', '__proto__'],
    ['constructor', 'constructor'],
    ['prototype', 'prototype'],
    ['an empty string', ''],
    ['an over-long id', 'u'.repeat(201)],
    ['a non-string', 7],
    ['null', null],
    ['undefined', undefined],
  ];
  for (const [name, id] of REJECTED) {
    it(`rejects ${name}`, () => {
      assert.equal(authModule.isSafeId(id), false);
    });
  }

  // These name Object.prototype members but are not assignment hazards, so the
  // handlers' own-key guards, not this check, are what keep them honest.
  for (const id of ['toString', 'valueOf', 'hasOwnProperty']) {
    it(`accepts the inherited-but-harmless id ${JSON.stringify(id)}`, () => {
      assert.equal(authModule.isSafeId(id), true);
    });
  }
});

describe('resolveIdentity', () => {
  let enabled;
  let dbFile;
  let alice;   // {id, cookie}
  let bob;

  before(async () => {
    dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-auth-')), 'test.db');
    enabled = loadAuth({
      DATABASE_FILE: dbFile,
      BETTER_AUTH_SECRET: 'test-secret-'.padEnd(48, 'x'),
      ...GITHUB,
    });

    alice = await githubAccount(enabled.auth, 'alice');
    bob = await githubAccount(enabled.auth, 'bob');
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(dbFile + suffix); } catch { /* already gone */ }
    }
  });

  it('created real rows in the SQL database', () => {
    assert.ok(alice.id, 'alice has a generated id');
    assert.match(alice.cookie, /^better-auth\.session_token=/, 'the session is a session cookie');
    assert.notEqual(alice.id, bob.id, 'two accounts are two users');
  });

  it('resolves a valid HttpOnly cookie to that account', async () => {
    const result = await enabled.resolveIdentity(req({cookie: alice.cookie}));
    assert.equal(result.ok, true);
    assert.equal(result.identity.userId, alice.id);
    assert.equal(result.identity.orgId, null, 'no organization selected yet');
    assert.ok(result.identity.sessionId, 'carries the session id');
  });

  it('tells two signed-in callers apart', async () => {
    const a = await enabled.resolveIdentity(req({cookie: alice.cookie}));
    const b = await enabled.resolveIdentity(req({cookie: bob.cookie}));
    assert.notEqual(a.identity.userId, b.identity.userId);
    assert.equal(b.identity.userId, bob.id);
  });

  it('freezes the identity, so a handler cannot rewrite the caller', async () => {
    const {identity} = await enabled.resolveIdentity(req({cookie: alice.cookie}));
    assert.throws(() => { identity.userId = bob.id; }, TypeError);
  });

  it('rejects a request with no token', async () => {
    assert.deepEqual(await enabled.resolveIdentity(req({})), {
      ok: false, status: 401, error: 'Not signed in', cookies: [],
    });
  });

  const FORGED = ['garbage', 'a.b', 'Bearer', ''];
  for (const token of FORGED) {
    it(`rejects the forged cookie ${JSON.stringify(token)}`, async () => {
      const result = await enabled.resolveIdentity(req({cookie: `better-auth.session_token=${token}`}));
      assert.equal(result.ok, false);
      assert.equal(result.status, 401);
    });
  }

  it('rejects a token belonging to a revoked session', async () => {
    const {cookie, id} = await githubAccount(enabled.auth, 'carol');

    const before = await enabled.resolveIdentity(req({cookie}));
    assert.equal(before.identity.userId, id, 'the session works to begin with');

    await enabled.auth.api.signOut({headers: {cookie}});

    const after = await enabled.resolveIdentity(req({cookie}));
    assert.equal(after.ok, false, 'the same token stops working once signed out');
    assert.equal(after.status, 401);
  });

  // The snapshot is what spares the next request its query, and also why a
  // session revoked elsewhere holds until the snapshot's minute is up.
  it('hands back the session snapshot, which identifies the caller without the session row', async () => {
    const {cookie, id} = await githubAccount(enabled.auth, 'dave');
    const first = await enabled.resolveIdentity(req({cookie}));
    const snapshot = first.cookies.find(value => value.startsWith('better-auth.session_data='));
    assert.ok(snapshot, 'the session snapshot is set');
    const cached = `${cookie}; ${snapshot.split(';')[0]}`;

    await enabled.auth.api.signOut({headers: {cookie}});
    assert.equal((await enabled.resolveIdentity(req({cookie}))).ok, false, 'the session itself is gone');
    assert.equal((await enabled.resolveIdentity(req({cookie: cached}))).identity.userId, id, 'the snapshot still names its user');
  });

  it('does not expose username sign-in', () => {
    assert.equal(enabled.auth.api.signInUsername, undefined);
  });

  // GitHub is the only way in.
  it('refuses email and password sign-up and sign-in', async () => {
    await assert.rejects(
      () => enabled.auth.api.signUpEmail({body: {email: 'mallory@test.invalid', password: 'correcthorsebattery', name: 'mallory'}}),
    );
    await assert.rejects(
      () => enabled.auth.api.signInEmail({body: {email: 'alice@test.invalid', password: 'correcthorsebattery'}}),
    );
  });

  // The command-line client's way in: a device code, approved by a browser
  // session, exchanged for a bearer token.
  it('signs the command-line client in through an approved device code', async () => {
    const code = await enabled.auth.api.deviceCode({body: {client_id: 'mochi-cli'}});
    assert.match(code.verification_uri, /\/device$/);
    await enabled.auth.api.deviceVerify({query: {user_code: code.user_code}, headers: {cookie: alice.cookie}});
    await enabled.auth.api.deviceApprove({body: {userCode: code.user_code}, headers: {cookie: alice.cookie}});
    const token = await enabled.auth.api.deviceToken({body: {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code, client_id: 'mochi-cli',
    }});
    const result = await enabled.resolveIdentity(req({authorization: `Bearer ${token.access_token}`}));
    assert.equal(result.identity.userId, alice.id);
  });

  it('refuses a device code to any other client', async () => {
    await assert.rejects(() => enabled.auth.api.deviceCode({body: {client_id: 'someone-else'}}));
  });

  it('offers GitHub as its only social provider', () => {
    assert.deepEqual(Object.keys(enabled.auth.options.socialProviders), ['github']);
  });

  it('copies the GitHub profile onto the account at every sign-in', () => {
    assert.equal(enabled.auth.options.socialProviders.github.overrideUserInfoOnSignIn, true);
  });

  // The address an account gets is trusted by invitations and the sign-up
  // policy, so GitHub must have verified it.
  it('refuses to create an account whose email GitHub has not verified', async () => {
    const {internalAdapter} = await enabled.auth.$context;
    await assert.rejects(
      () => internalAdapter.createUser({name: 'mallory', email: 'mallory@test.invalid', emailVerified: false}),
      /Verify your primary email address on GitHub/,
    );
  });

  // These three use their own accounts rather than alice and bob, so that
  // creating an organization here cannot change what the assertions above,
  // which expect an account in none, resolve to.
  const account = name => githubAccount(enabled.auth, name);

  // Better Auth leaves the active organization unset until something calls
  // set-active, and everything under /api/chat needs one, so a session opens in
  // the account's own organization rather than in none.
  it('opens a new session in the account\'s organization', async () => {
    const dana = await account('dana');
    const org = await enabled.auth.api.createOrganization({
      body: {name: 'Dana Co', slug: 'dana-co', userId: dana.id},
    });
    const result = await enabled.resolveIdentity(req({cookie: await sessionCookie(enabled.auth, dana.id)}));
    assert.equal(result.identity.orgId, org.id);
  });

  // The hook fires only when a session is created, so a session issued before
  // its account had an organization would otherwise stay in none for as long as
  // it lives, answering 409 to every chat request until its owner happened to
  // sign out and back in.
  it('falls back to the organization for a session issued before it existed', async () => {
    const erin = await account('erin');
    const before = await enabled.resolveIdentity(req({cookie: erin.cookie}));
    assert.equal(before.identity.orgId, null, 'she had none when she signed up');

    const org = await enabled.auth.api.createOrganization({
      body: {name: 'Erin Co', slug: 'erin-co', userId: erin.id},
    });
    const after = await enabled.resolveIdentity(req({cookie: erin.cookie}));
    assert.equal(after.identity.orgId, org.id, 'the same token now resolves into it');
  });

  it('leaves a caller who belongs to no organization in none', async () => {
    const frank = await account('frank');
    const result = await enabled.resolveIdentity(req({cookie: frank.cookie}));
    assert.equal(result.identity.orgId, null, 'no organization is not the same as the wrong one');
  });
});

describe('loading', () => {
  for (const missing of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']) {
    it(`refuses to load without ${missing}`, () => {
      assert.throws(
        () => loadAuth({DATABASE_FILE: undefined, ...GITHUB, [missing]: undefined}),
        /GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET/,
      );
    });
  }
});

describe('productionAuthError', () => {
  const configured = {
    NODE_ENV: 'production',
    ...GITHUB,
    ROOT_GITHUB_LOGIN: 'root-login',
    MAIL_WEBHOOK_URL: 'https://mail.example.test/send',
    BETTER_AUTH_SECRET: 'production-test-secret'.padEnd(48, 'x'),
    SITE_URL: 'https://mochi.example.test',
    DATABASE_URL: 'postgres://app:secret@db/mochi',
    DATABASE_MIGRATION_URL: 'postgres://owner:secret@db/mochi',
  };
  for (const missing of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']) {
    it(`requires ${missing} in production`, () => {
      assert.match(authModule.productionAuthError({...configured, [missing]: undefined}), /GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET/);
    });
  }

  it('requires ROOT_GITHUB_LOGIN in production', () => {
    assert.match(authModule.productionAuthError({...configured, ROOT_GITHUB_LOGIN: ' '}), /ROOT_GITHUB_LOGIN/);
  });

  it('requires transactional email in production', () => {
    assert.match(
      authModule.productionAuthError({...configured, MAIL_WEBHOOK_URL: undefined}),
      /RESEND_API_KEY.*MAIL_FROM.*MAIL_WEBHOOK_URL/,
    );
  });

  it('requires both Resend settings when either is present', () => {
    assert.match(
      authModule.productionAuthError({...configured, MAIL_WEBHOOK_URL: undefined, RESEND_API_KEY: 're_test'}),
      /RESEND_API_KEY and MAIL_FROM/,
    );
  });

  it('accepts direct Resend delivery instead of a webhook', () => {
    assert.equal(authModule.productionAuthError({
      ...configured,
      MAIL_WEBHOOK_URL: undefined,
      RESEND_API_KEY: 're_test',
      MAIL_FROM: 'Mochi <mail@example.test>',
    }), null);
  });

  it('requires an explicit strong session secret in production', () => {
    assert.match(authModule.productionAuthError({...configured, BETTER_AUTH_SECRET: undefined}), /BETTER_AUTH_SECRET/);
  });

  it('requires an HTTPS same-origin site URL in production', () => {
    assert.match(authModule.productionAuthError({...configured, SITE_URL: 'http://example.test'}), /HTTPS SITE_URL/);
  });

  it('requires a separate PostgreSQL migration connection in production', () => {
    assert.match(authModule.productionAuthError({
      ...configured,
      DATABASE_MIGRATION_URL: undefined,
      DATABASE_URL: 'postgres://app:secret@db/mochi',
    }), /DATABASE_MIGRATION_URL/);
  });

  it('permits production once authentication, GitHub, and email are configured', () => {
    assert.equal(authModule.productionAuthError(configured), null);
  });

  // Development is the case where running without authentication is the point:
  // the test suites do it deliberately.
  for (const nodeEnv of [undefined, 'development', 'test']) {
    it(`permits NODE_ENV=${JSON.stringify(nodeEnv)} without authentication`, () => {
      assert.equal(authModule.productionAuthError({NODE_ENV: nodeEnv}), null);
    });
  }

  it('reads process.env when called with no argument', () => {
    // Whatever the suite runs under, the default-argument path must agree with
    // passing that same environment explicitly. This is what index.js calls.
    assert.equal(authModule.productionAuthError(), authModule.productionAuthError(process.env));
  });
});
