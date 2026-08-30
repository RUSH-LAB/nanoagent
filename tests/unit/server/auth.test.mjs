/**
 * server/auth.js: the single place the API decides who is calling.
 *
 * The module reads ENABLE_AUTH and CLERK_SECRET_KEY once at load, so the cases
 * that need a different configuration reload it through a fresh require after
 * setting the environment, rather than trying to mutate a frozen decision.
 *
 * Nothing here reaches the network. The enabled-mode cases use tokens that fail
 * local JWT parsing, so verifyToken rejects before it would fetch a JWKS.
 */
import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const AUTH_PATH = require.resolve('../../../src/server/auth.js');

/** Load a fresh copy of server/auth.js under the given environment. */
function loadAuth(env) {
  const saved = {ENABLE_AUTH: process.env.ENABLE_AUTH, CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[AUTH_PATH];
  try {
    return require('../../../src/server/auth.js');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[AUTH_PATH];
  }
}

const auth = loadAuth({ENABLE_AUTH: undefined, CLERK_SECRET_KEY: undefined});
const req = headers => ({headers});

describe('readToken', () => {
  it('reads a bearer token from the Authorization header', () => {
    assert.equal(auth.readToken(req({authorization: 'Bearer abc.def.ghi'})), 'abc.def.ghi');
  });

  it('trims surrounding whitespace on the header token', () => {
    assert.equal(auth.readToken(req({authorization: 'Bearer   tok  '})), 'tok');
  });

  const NON_BEARER = [
    ['a scheme that is not Bearer', {authorization: 'Basic abc'}],
    ['a lowercase bearer scheme', {authorization: 'bearer abc'}],
    ['an empty bearer value', {authorization: 'Bearer '}],
    ['no headers at all', {}],
  ];
  for (const [name, headers] of NON_BEARER) {
    it(`returns null for ${name}`, () => {
      assert.equal(auth.readToken(req(headers)), null);
    });
  }

  it('falls back to the __session cookie', () => {
    assert.equal(auth.readToken(req({cookie: 'other=1; __session=cookie-token; more=2'})), 'cookie-token');
  });

  it('url-decodes the cookie value', () => {
    assert.equal(auth.readToken(req({cookie: '__session=a%2Bb'})), 'a+b');
  });

  it('prefers the header over the cookie', () => {
    const headers = {authorization: 'Bearer from-header', cookie: '__session=from-cookie'};
    assert.equal(auth.readToken(req(headers)), 'from-header');
  });

  it('falls through to the cookie when the header is not a bearer', () => {
    const headers = {authorization: 'Basic nope', cookie: '__session=from-cookie'};
    assert.equal(auth.readToken(req(headers)), 'from-cookie');
  });

  const NO_COOKIE = [
    ['a cookie header without __session', '__sessions=x; other=1'],
    ['a malformed cookie segment', 'novalue'],
    ['an empty __session value', '__session='],
  ];
  for (const [name, cookie] of NO_COOKIE) {
    it(`returns null for ${name}`, () => {
      assert.equal(auth.readToken(req({cookie})), null);
    });
  }

  it('is not confused by a cookie name that ends in __session', () => {
    assert.equal(auth.readToken(req({cookie: 'not__session=x'})), null);
  });
});

describe('identityFromClaims', () => {
  it('reads a v2 token, whose organization is nested under `o`', () => {
    const claims = {sub: 'user_1', sid: 'sess_1', v: 2, o: {id: 'org_1', rol: 'admin', slg: 'acme'}};
    assert.deepEqual(auth.identityFromClaims(claims), {
      userId: 'user_1', orgId: 'org_1', orgRole: 'admin', sessionId: 'sess_1',
    });
  });

  it('reads a v1 token, whose organization is spelled out at the top level', () => {
    const claims = {sub: 'user_1', sid: 'sess_1', org_id: 'org_1', org_role: 'org:admin'};
    assert.deepEqual(auth.identityFromClaims(claims), {
      userId: 'user_1', orgId: 'org_1', orgRole: 'admin', sessionId: 'sess_1',
    });
  });

  it('strips the org: prefix v1 uses and v2 does not, so the role reads the same either way', () => {
    assert.equal(auth.identityFromClaims({sub: 'u', org_role: 'org:member'}).orgRole, 'member');
    assert.equal(auth.identityFromClaims({sub: 'u', o: {rol: 'member'}}).orgRole, 'member');
  });

  it('nulls the organization for a personal-account token', () => {
    assert.deepEqual(auth.identityFromClaims({sub: 'user_1'}), {
      userId: 'user_1', orgId: null, orgRole: null, sessionId: null,
    });
  });

  it('prefers the v2 nesting when a token somehow carries both', () => {
    const claims = {sub: 'u', o: {id: 'org_v2', rol: 'admin'}, org_id: 'org_v1', org_role: 'org:member'};
    const identity = auth.identityFromClaims(claims);
    assert.deepEqual([identity.orgId, identity.orgRole], ['org_v2', 'admin']);
  });

  it('nulls a non-string role rather than passing it through', () => {
    assert.equal(auth.identityFromClaims({sub: 'u', org_role: 7}).orgRole, null);
  });
});

describe('isSafeId', () => {
  it('accepts an ordinary Clerk id', () => {
    assert.equal(auth.isSafeId('user_2abcDEF'), true);
  });

  it('accepts an id of exactly the 200 character limit', () => {
    assert.equal(auth.isSafeId('u'.repeat(200)), true);
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
      assert.equal(auth.isSafeId(id), false);
    });
  }

  // These name Object.prototype members but are not assignment hazards, so the
  // handlers' own-key guards, not this check, are what keep them honest.
  for (const id of ['toString', 'valueOf', 'hasOwnProperty']) {
    it(`accepts the inherited-but-harmless id ${JSON.stringify(id)}`, () => {
      assert.equal(auth.isSafeId(id), true);
    });
  }
});

describe('isPublicPath', () => {
  for (const p of ['/api/health', '/api/feed/rss', '/api/feed/atom']) {
    it(`treats ${p} as public, since its callers cannot hold a session`, () => {
      assert.equal(auth.isPublicPath(p), true);
    });
  }

  for (const p of ['/api/users', '/api/users/me', '/api/logs', '/api/debug/memory', '/api/feed', '/']) {
    it(`treats ${p} as requiring a session`, () => {
      assert.equal(auth.isPublicPath(p), false);
    });
  }
});

describe('resolveIdentity with ENABLE_AUTH unset', () => {
  it('reports itself disabled', () => {
    assert.equal(auth.AUTH_ENABLED, false);
  });

  it('resolves every request to the development identity', async () => {
    const result = await auth.resolveIdentity(req({}));
    assert.deepEqual(result, {ok: true, identity: auth.DEV_IDENTITY});
    assert.equal(result.identity.userId, 'dev-user');
  });

  it('ignores a token entirely rather than trying to verify it', async () => {
    const result = await auth.resolveIdentity(req({authorization: 'Bearer garbage'}));
    assert.deepEqual(result.identity, auth.DEV_IDENTITY);
  });

  it('hands out a frozen identity, so a handler cannot rewrite the caller', () => {
    assert.throws(() => { auth.DEV_IDENTITY.userId = 'someone-else'; }, TypeError);
  });
});

describe('resolveIdentity with ENABLE_AUTH=true', () => {
  let enabled;
  before(() => {
    enabled = loadAuth({ENABLE_AUTH: 'true', CLERK_SECRET_KEY: 'sk_test_not_a_real_key'});
  });

  it('reports itself enabled', () => {
    assert.equal(enabled.AUTH_ENABLED, true);
  });

  it('rejects a request with no token, without consulting Clerk', async () => {
    assert.deepEqual(await enabled.resolveIdentity(req({})), {
      ok: false, status: 401, error: 'Missing session token',
    });
  });

  // A token that is not a well-formed JWT fails local parsing, so verifyToken
  // rejects before it would reach for a signing key over the network.
  for (const token of ['garbage', 'a.b', 'not.a.jwt']) {
    it(`rejects the unparseable token ${JSON.stringify(token)} as 401`, async () => {
      const result = await enabled.resolveIdentity(req({authorization: `Bearer ${token}`}));
      assert.deepEqual(result, {ok: false, status: 401, error: 'Invalid or expired session token'});
    });
  }

  it('does not disclose why verification failed', async () => {
    const result = await enabled.resolveIdentity(req({authorization: 'Bearer garbage'}));
    // One flat message for every failure mode: an attacker learns nothing about
    // which part of a forgery to correct.
    assert.equal(result.error, 'Invalid or expired session token');
  });

  it('reads the token from the __session cookie too', async () => {
    const result = await enabled.resolveIdentity(req({cookie: '__session=garbage'}));
    assert.deepEqual(result, {ok: false, status: 401, error: 'Invalid or expired session token'});
  });
});

describe('startup configuration', () => {
  it('refuses to load with authentication on and no secret key', () => {
    assert.throws(
      () => loadAuth({ENABLE_AUTH: 'true', CLERK_SECRET_KEY: undefined}),
      /ENABLE_AUTH=true requires CLERK_SECRET_KEY/,
    );
  });

  it('treats an empty secret key the same as a missing one', () => {
    assert.throws(
      () => loadAuth({ENABLE_AUTH: 'true', CLERK_SECRET_KEY: ''}),
      /ENABLE_AUTH=true requires CLERK_SECRET_KEY/,
    );
  });

  // Only the exact string 'true' turns authentication on, so a stray value can
  // never half-enable it.
  for (const value of ['1', 'yes', 'TRUE', 'false', '']) {
    it(`stays disabled for ENABLE_AUTH=${JSON.stringify(value)}`, () => {
      assert.equal(loadAuth({ENABLE_AUTH: value, CLERK_SECRET_KEY: undefined}).AUTH_ENABLED, false);
    });
  }
});
