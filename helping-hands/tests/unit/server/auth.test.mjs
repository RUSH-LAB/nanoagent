/**
 * server/auth.js: the single place the API decides who is calling.
 *
 * The enabled-mode cases are not mocked. They stand up a real Better Auth
 * instance over a throwaway SQLite file, sign a real account up through the
 * real endpoint, and hand the resulting token back to resolveIdentity. That is
 * worth the few milliseconds: the thing most likely to break here is the wiring
 * between Better Auth, the schema in migrations/, and the identity shape the
 * handlers destructure, and none of that is exercised by a stub.
 *
 * The module reads ENABLE_AUTH and DATABASE_FILE once at load, so cases that
 * need a different configuration reload it through a fresh require.
 */
import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AUTH_PATH = require.resolve('../../../src/server/auth.js');
const DB_PATH = require.resolve('../../../src/server/db.js');

/** Load a fresh copy of server/auth.js (and its db) under the given environment. */
function loadAuth(env) {
  const saved = {};
  for (const k of ['ENABLE_AUTH', 'DATABASE_FILE', 'BETTER_AUTH_SECRET']) saved[k] = process.env[k];
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
const cookieFrom = result => result.headers.getSetCookie()[0].split(';')[0];
const disabled = loadAuth({ENABLE_AUTH: undefined, DATABASE_FILE: undefined});

describe('isPublicPath', () => {
  for (const p of ['/api/health']) {
    it(`treats ${p} as public`, () => {
      assert.equal(disabled.isPublicPath(p), true);
    });
  }

  // Gating sign-in behind sign-in would lock everybody out, so the whole Better
  // Auth prefix is public and does its own authorization.
  for (const p of ['/api/auth/sign-in/email', '/api/auth/sign-up/email', '/api/auth/get-session']) {
    it(`treats ${p} as public, because that is where a caller goes to get a session`, () => {
      assert.equal(disabled.isPublicPath(p), true);
    });
  }

  for (const p of ['/api/users', '/api/users/me', '/api/logs', '/api/preferences', '/api/feed', '/api/feed/rss', '/api/feed/atom', '/api/workspaces/ws/feed/rss', '/api/authx', '/']) {
    it(`treats ${p} as requiring a session`, () => {
      assert.equal(disabled.isPublicPath(p), false);
    });
  }
});

// One unauthenticated read, matched by shape rather than by prefix. Somebody
// following an invitation link has no session and cannot make an account with
// the right address until they are told which address was invited; accepting
// the invitation is a different path and still needs the session.
describe('isPublicPath for an invitation link', () => {
  it('lets the link itself be read', () => {
    assert.equal(disabled.isPublicPath('/api/invite/inv_abc123'), true);
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
      assert.equal(disabled.isPublicPath(p), false);
    });
  }
});

describe('isSafeId', () => {
  it('accepts a generated Better Auth id', () => {
    assert.equal(disabled.isSafeId('vWm7Ls6392wGlXsU6kfwCyrfVx3Ng5T8'), true);
  });

  it('accepts an id of exactly the 200 character limit', () => {
    assert.equal(disabled.isSafeId('u'.repeat(200)), true);
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
      assert.equal(disabled.isSafeId(id), false);
    });
  }

  // These name Object.prototype members but are not assignment hazards, so the
  // handlers' own-key guards, not this check, are what keep them honest.
  for (const id of ['toString', 'valueOf', 'hasOwnProperty']) {
    it(`accepts the inherited-but-harmless id ${JSON.stringify(id)}`, () => {
      assert.equal(disabled.isSafeId(id), true);
    });
  }
});

describe('resolveIdentity with ENABLE_AUTH unset', () => {
  it('reports itself disabled', () => {
    assert.equal(disabled.AUTH_ENABLED, false);
  });

  it('resolves every request to the development identity', async () => {
    const result = await disabled.resolveIdentity(req({}));
    assert.deepEqual(result, {ok: true, identity: disabled.DEV_IDENTITY});
    assert.equal(result.identity.userId, 'dev-user');
  });

  it('ignores a token entirely rather than trying to verify it', async () => {
    const result = await disabled.resolveIdentity(req({authorization: 'Bearer garbage'}));
    assert.deepEqual(result.identity, disabled.DEV_IDENTITY);
  });

  it('hands out a frozen identity, so a handler cannot rewrite the caller', () => {
    assert.throws(() => { disabled.DEV_IDENTITY.userId = 'someone-else'; }, TypeError);
  });
});

describe('resolveIdentity with ENABLE_AUTH=true', () => {
  let enabled;
  let dbFile;
  let alice;   // {id, cookie}
  let bob;

  before(async () => {
    dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-auth-')), 'test.db');
    enabled = loadAuth({
      ENABLE_AUTH: 'true',
      DATABASE_FILE: dbFile,
      BETTER_AUTH_SECRET: 'test-secret-'.padEnd(48, 'x'),
    });

    const signUp = async (username, email) => {
      const res = await enabled.auth.api.signUpEmail({
        body: {email, password: 'correcthorsebattery', name: username},
        returnHeaders: true,
      });
      const body = res.response ?? res;
      return {id: body.user.id, cookie: cookieFrom(res)};
    };
    alice = await signUp('alice', 'alice@test.invalid');
    bob = await signUp('bob', 'bob@test.invalid');
  });

  after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(dbFile + suffix); } catch { /* already gone */ }
    }
  });

  it('reports itself enabled', () => {
    assert.equal(enabled.AUTH_ENABLED, true);
  });

  it('created real rows in the SQL database', () => {
    assert.ok(alice.id, 'alice has a generated id');
    assert.match(alice.cookie, /^better-auth\.session_token=/, 'sign-up set a session cookie');
    assert.notEqual(alice.id, bob.id, 'two accounts are two users');
  });

  it('resolves a valid HttpOnly cookie to that account', async () => {
    const result = await enabled.resolveIdentity(req({cookie: alice.cookie}));
    assert.equal(result.ok, true);
    assert.equal(result.identity.userId, alice.id);
    assert.equal(result.identity.orgId, null, 'no organization selected yet');
    assert.equal(result.identity.orgRole, null);
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
      ok: false, status: 401, error: 'Not signed in',
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
    const {cookie, id} = await (async () => {
      const res = await enabled.auth.api.signUpEmail({
        body: {email: 'carol@test.invalid', password: 'correcthorsebattery', name: 'carol'},
        returnHeaders: true,
      });
      return {cookie: cookieFrom(res), id: res.response.user.id};
    })();

    const before = await enabled.resolveIdentity(req({cookie}));
    assert.equal(before.identity.userId, id, 'the session works to begin with');

    await enabled.auth.api.signOut({headers: {cookie}});

    const after = await enabled.resolveIdentity(req({cookie}));
    assert.equal(after.ok, false, 'the same token stops working once signed out');
    assert.equal(after.status, 401);
  });

  it('does not expose username sign-in', () => {
    assert.equal(enabled.auth.api.signInUsername, undefined);
  });

  it('refuses the wrong password', async () => {
    await assert.rejects(
      () => enabled.auth.api.signInEmail({body: {email: 'alice@test.invalid', password: 'not-the-password'}}),
    );
  });

  // These three use their own accounts rather than alice and bob, so that
  // creating an organization here cannot change what the assertions above,
  // which expect an account in none, resolve to.
  const account = async (name) => {
    const res = await enabled.auth.api.signUpEmail({
      body: {email: `${name}@test.invalid`, password: 'correcthorsebattery', name},
      returnHeaders: true,
    });
    return {id: res.response.user.id, cookie: cookieFrom(res)};
  };
  const signIn = async (name) => {
    const result = await enabled.auth.api.signInEmail({
      body: {email: `${name}@test.invalid`, password: 'correcthorsebattery'},
      returnHeaders: true,
    });
    return cookieFrom(result);
  };

  // Better Auth leaves the active organization unset until something calls
  // set-active, and everything under /api/chat needs one, so a session opens in
  // the account's own organization rather than in none.
  it('opens a new session in the account\'s organization', async () => {
    const dana = await account('dana');
    const org = await enabled.auth.api.createOrganization({
      body: {name: 'Dana Co', slug: 'dana-co', userId: dana.id},
    });
    const result = await enabled.resolveIdentity(req({cookie: await signIn('dana')}));
    assert.equal(result.identity.orgId, org.id);
    assert.equal(result.identity.orgRole, 'owner', 'with the role the membership gives');
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
    assert.equal(after.identity.orgRole, 'owner');
  });

  it('leaves a caller who belongs to no organization in none', async () => {
    const frank = await account('frank');
    const result = await enabled.resolveIdentity(req({cookie: frank.cookie}));
    assert.equal(result.identity.orgId, null, 'no organization is not the same as the wrong one');
    assert.equal(result.identity.orgRole, null);
  });
});

describe('orgRoleFor', () => {
  it('returns null when the caller has no active organization', () => {
    assert.equal(disabled.orgRoleFor('any-user', null), null);
  });

  it('returns null rather than throwing when the membership is absent', () => {
    assert.equal(disabled.orgRoleFor('nobody', 'no-such-org'), null);
  });
});

describe('ENABLE_AUTH parsing', () => {
  // Only the exact string 'true' turns authentication on, so a stray value can
  // never half-enable it.
  for (const value of ['1', 'yes', 'TRUE', 'false', '']) {
    it(`stays disabled for ENABLE_AUTH=${JSON.stringify(value)}`, () => {
      assert.equal(loadAuth({ENABLE_AUTH: value}).AUTH_ENABLED, false);
    });
  }
});

describe('productionAuthError', () => {
  const configured = {
    NODE_ENV: 'production',
    ENABLE_AUTH: 'true',
    MAIL_WEBHOOK_URL: 'https://mail.example.test/send',
    BETTER_AUTH_SECRET: 'production-test-secret'.padEnd(48, 'x'),
    SITE_URL: 'https://mochi.example.test',
    DATABASE_URL: 'postgres://app:secret@db/mochi',
    DATABASE_MIGRATION_URL: 'postgres://owner:secret@db/mochi',
  };
  // The same values as above: a production server may only start on the exact
  // string that turns authentication on, because every other value leaves
  // resolveIdentity returning DEV_IDENTITY to everybody.
  for (const value of ['1', 'yes', 'TRUE', 'false', '', undefined]) {
    it(`refuses production with ENABLE_AUTH=${JSON.stringify(value)}`, () => {
      const error = disabled.productionAuthError({NODE_ENV: 'production', ENABLE_AUTH: value});
      assert.ok(error, 'a production server without authentication must not start');
      assert.match(error, /ENABLE_AUTH/, 'the refusal has to name the variable to set');
    });
  }

  it('requires transactional email in production', () => {
    assert.match(
      disabled.productionAuthError({NODE_ENV: 'production', ENABLE_AUTH: 'true'}),
      /RESEND_API_KEY.*MAIL_FROM.*MAIL_WEBHOOK_URL/,
    );
  });

  it('requires both Resend settings when either is present', () => {
    assert.match(
      disabled.productionAuthError({...configured, MAIL_WEBHOOK_URL: undefined, RESEND_API_KEY: 're_test'}),
      /RESEND_API_KEY and MAIL_FROM/,
    );
  });

  it('accepts direct Resend delivery instead of a webhook', () => {
    assert.equal(disabled.productionAuthError({
      ...configured,
      MAIL_WEBHOOK_URL: undefined,
      RESEND_API_KEY: 're_test',
      MAIL_FROM: 'Mochi <mail@example.test>',
    }), null);
  });

  it('requires an explicit strong session secret in production', () => {
    assert.match(disabled.productionAuthError({...configured, BETTER_AUTH_SECRET: undefined}), /BETTER_AUTH_SECRET/);
  });

  it('requires an HTTPS same-origin site URL in production', () => {
    assert.match(disabled.productionAuthError({...configured, SITE_URL: 'http://example.test'}), /HTTPS SITE_URL/);
  });

  it('requires a separate PostgreSQL migration connection in production', () => {
    assert.match(disabled.productionAuthError({
      ...configured,
      DATABASE_MIGRATION_URL: undefined,
      DATABASE_URL: 'postgres://app:secret@db/mochi',
    }), /DATABASE_MIGRATION_URL/);
  });

  it('permits production once authentication and email are configured', () => {
    assert.equal(disabled.productionAuthError(configured), null);
  });

  // Development is the case where running without authentication is the point:
  // the test suites do it deliberately.
  for (const nodeEnv of [undefined, 'development', 'test']) {
    it(`permits NODE_ENV=${JSON.stringify(nodeEnv)} without authentication`, () => {
      assert.equal(disabled.productionAuthError({NODE_ENV: nodeEnv}), null);
    });
  }

  it('reads process.env when called with no argument', () => {
    // Whatever the suite runs under, the default-argument path must agree with
    // passing that same environment explicitly. This is what index.js calls.
    assert.equal(disabled.productionAuthError(), disabled.productionAuthError(process.env));
  });
});
