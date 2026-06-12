import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

// The three dangerous keys the shared PROTO_KEYS guard must reject at every call
// site. Hoisting the list into one frozen const must not change which keys are
// blocked, so the full table is asserted at each of the three guards.
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

// Invoke an analytics-users route handler with a minimal mocked ctx and capture
// the response handed to json(res, status, payload). readBody returns the test
// body verbatim; rateLimit allows the request so the handler reaches its
// validators.
async function invoke({ method, pathname, body, ctx = {} }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    readBody: async () => body,
    rateLimit: () => true,
    ...ctx,
  };
  await analyticsUsersRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('POST /api/analytics/pageview proto-key guard', () => {
  for (const path of DANGEROUS_KEYS) {
    it(`rejects a dangerous path "${path}" with 400 Invalid path`, async () => {
      // A valid-length string clears the earlier validators so the proto-key
      // guard is what produces the rejection.
      const r = await invoke({
        method: 'POST',
        pathname: '/api/analytics/pageview',
        body: { path },
      });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: 'Invalid path' });
    });
  }

  it('still accepts a normal path (the guard does not over-reject)', async () => {
    let saved = null;
    const r = await invoke({
      method: 'POST',
      pathname: '/api/analytics/pageview',
      body: { path: '/docs/intro' },
      ctx: {
        ANALYTICS_FILE: 'analytics.json',
        loadJSON: () => ({}),
        saveJSON: (_file, data) => { saved = data; },
        sanitizeText: (s) => s,
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { success: true });
    assert.ok(saved && saved.counts['/docs/intro'] === 1, 'records the pageview count');
  });
});

describe('PUT /api/users/:id/role userId proto-key guard', () => {
  for (const userId of DANGEROUS_KEYS) {
    it(`rejects a dangerous userId "${userId}" with 400 Invalid userId`, async () => {
      // A valid role clears the earlier validator so the userId guard is what
      // rejects the request; the dangerous key rides in through the URL path.
      const r = await invoke({
        method: 'PUT',
        pathname: `/api/users/${userId}/role`,
        body: { role: 'editor' },
      });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: 'Invalid userId' });
    });
  }
});

describe('PUT /api/users/:id/role requesterId proto-key guard', () => {
  for (const requesterId of DANGEROUS_KEYS) {
    it(`rejects a dangerous requesterId "${requesterId}" with 400 Invalid requesterId`, async () => {
      // A normal userId and valid role clear the earlier guards so the
      // requesterId proto-key guard is what rejects the request.
      const r = await invoke({
        method: 'PUT',
        pathname: '/api/users/alice/role',
        body: { role: 'editor', requesterId },
      });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: 'Invalid requesterId' });
    });
  }

  it('still accepts normal userId and requesterId (neither guard over-rejects)', async () => {
    let saved = null;
    const r = await invoke({
      method: 'PUT',
      pathname: '/api/users/alice/role',
      body: { role: 'editor', requesterId: 'owner1' },
      ctx: {
        USERS_FILE: 'users.json',
        loadJSON: () => ({
          owner1: { role: 'owner', email: 'o@example.com', name: 'Owner', addedAt: '2020-01-01T00:00:00.000Z' },
        }),
        saveJSON: (_file, data) => { saved = data; },
        sanitizeText: (s) => (typeof s === 'string' ? s : ''),
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.success, true);
    assert.equal(r.payload.user.role, 'editor');
    assert.ok(saved && saved.alice, 'persists the updated user under its key');
  });
});
