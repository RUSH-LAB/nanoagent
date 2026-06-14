import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

// Invoke GET /api/users with a minimal mocked ctx and capture the response handed
// to json(res, status, payload). The harness mirrors next-users-me-protokey-default:
// loadJSON returns the supplied store verbatim, so it resolves the in-memory users
// map the way the real route does. The list handler is
// `const users = loadJSON(USERS_FILE); return json(res, 200, {users})`, a pure read,
// so saveJSON is unneeded.
async function invokeList({ users }) {
  const pathname = '/api/users';
  const url = new URL(`http://localhost${pathname}`);
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

describe('analytics-users GET /api/users list projection', () => {
  // Goldens captured by running the real handler (server/routes/analytics-users.js,
  // GET /api/users). The handler wraps the loadJSON result in {users} with no
  // defensive copy, so the projection is by reference and the top-level payload
  // carries the single "users" key.

  it('returns status 200 and the full store under {users} for a populated store', async () => {
    const store = {
      alice: { role: 'editor', email: 'alice@example.com', name: 'Alice', addedAt: '2020-01-01T00:00:00.000Z' },
      bob: { role: 'owner', email: 'bob@example.com', name: 'Bob', addedAt: '2021-06-15T12:30:00.000Z' },
    };
    const r = await invokeList({ users: store });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, {
      users: {
        alice: { role: 'editor', email: 'alice@example.com', name: 'Alice', addedAt: '2020-01-01T00:00:00.000Z' },
        bob: { role: 'owner', email: 'bob@example.com', name: 'Bob', addedAt: '2021-06-15T12:30:00.000Z' },
      },
    });
  });

  it('projects the loadJSON result by reference rather than copying it', async () => {
    const store = {
      alice: { role: 'editor', email: 'alice@example.com', name: 'Alice', addedAt: '2020-01-01T00:00:00.000Z' },
    };
    const r = await invokeList({ users: store });
    assert.equal(r.status, 200);
    // {users} is shorthand for {users: users}, so the payload holds the exact
    // object loadJSON returned. The real handler does not clone it.
    assert.strictEqual(r.payload.users, store);
  });

  it('returns {users: {}} for a missing or empty store (the loadJSON default)', async () => {
    // The real loadJSON returns {} when the users file is absent; the handler
    // wraps that default through unchanged.
    const store = {};
    const r = await invokeList({ users: store });
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.payload, { users: {} });
    assert.strictEqual(r.payload.users, store);
  });
});
