import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

// Invoke GET /api/users/me with a minimal mocked ctx and capture the response
// handed to json(res, status, payload). loadJSON returns the supplied users map
// verbatim: a plain object literal, so inherited keys like __proto__ and
// constructor resolve to truthy values exactly as they would on the real
// loadJSON result. The read path never writes, so saveJSON is unneeded.
async function invokeMe({ userId, users }) {
  const pathname = '/api/users/me';
  const query = userId === undefined ? '' : `?userId=${encodeURIComponent(userId)}`;
  const url = new URL(`http://localhost${pathname}${query}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    USERS_FILE: 'users.json',
    loadJSON: () => users,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await analyticsUsersRoutes(req, res, url, pathname, ctx);
  return captured;
}

const USERS = {
  alice: { role: 'editor', email: 'alice@example.com', name: 'Alice' },
};

describe('GET /api/users/me own-property lookup', () => {
  // __proto__ and constructor resolve to truthy inherited values on a plain
  // object, so without the Object.hasOwn guard the handler would treat them as
  // real users and leak {role:undefined, email:undefined, name:undefined}.
  for (const userId of ['__proto__', 'constructor']) {
    it(`returns the viewer default for the inherited key "${userId}"`, async () => {
      const r = await invokeMe({ userId, users: USERS });
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload, { role: 'viewer' });
    });
  }

  it('returns the role, email, and name for a real own-key user', async () => {
    const r = await invokeMe({ userId: 'alice', users: USERS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { role: 'editor', email: 'alice@example.com', name: 'Alice' });
  });

  it('returns the viewer default for an absent ordinary id', async () => {
    const r = await invokeMe({ userId: 'nobody', users: USERS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { role: 'viewer' });
  });

  it('returns 400 when userId is missing', async () => {
    const r = await invokeMe({ userId: undefined, users: USERS });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Missing userId' });
  });
});
