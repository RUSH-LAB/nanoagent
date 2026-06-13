import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load the REAL module the way the sibling
// server route tests do, then drive PUT /api/users/:id/role over a fully mocked
// ctx. No real filesystem, network, or git is touched: every branch pinned here
// rejects before the handler reaches loadJSON(USERS_FILE).
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

// The handler's exact, deterministic rejection messages. Each lives in one place
// so these assertions stay in lock-step with the source strings.
const ROLE_ERROR = 'Invalid role. Must be owner, editor, or viewer';
const REQUESTER_ERROR = 'Missing or invalid requesterId';
const EMAIL_ERROR = 'email must be a string';
const NAME_ERROR = 'name must be a string';
const RATE_LIMIT_ERROR = 'Too many requests. Try again in a minute.';

// The case-sensitive allow-list the role guard checks against.
const VALID_ROLES = ['owner', 'editor', 'viewer'];

// A normal target path; the :id segment is a plain key (not a proto key), so the
// userId guard never fires and the branches under test are what reject.
const ROLE_PATH = '/api/users/alice/role';

// Invoke the set-role handler with a minimal mocked ctx and capture the response
// handed to json(res, status, payload). readBody returns the test body verbatim;
// rateLimit allows the request so the handler reaches its validators. saveJSON is
// a spy: every branch under test rejects before any write, so saveCount must stay
// 0. loadJSON returns {} purely for robustness; the target guards return first.
async function invoke({ method, pathname, body, ctx = {} }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saveCount = 0;
  const fullCtx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    readBody: async () => body,
    rateLimit: () => true,
    saveJSON: () => { saveCount += 1; },
    loadJSON: () => ({}),
    sanitizeText: (s) => (typeof s === 'string' ? s : ''),
    ...ctx,
  };
  await analyticsUsersRoutes(req, res, url, pathname, fullCtx);
  return { ...captured, saveCount };
}

describe('PUT /api/users/:id/role set-role validation guards', () => {
  describe('role allow-list guard (400)', () => {
    it('rejects a missing role with 400 and no save', async () => {
      const r = await invoke({ method: 'PUT', pathname: ROLE_PATH, body: { requesterId: 'owner1' } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: ROLE_ERROR });
      assert.equal(r.saveCount, 0);
    });

    it('rejects a non-string role (number) with 400 and no save', async () => {
      const r = await invoke({ method: 'PUT', pathname: ROLE_PATH, body: { role: 5, requesterId: 'owner1' } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: ROLE_ERROR });
      assert.equal(r.saveCount, 0);
    });

    it('rejects an empty-string role with 400 and no save', async () => {
      const r = await invoke({ method: 'PUT', pathname: ROLE_PATH, body: { role: '', requesterId: 'owner1' } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: ROLE_ERROR });
      assert.equal(r.saveCount, 0);
    });

    it('rejects an out-of-list role "admin" with 400 and no save', async () => {
      const r = await invoke({ method: 'PUT', pathname: ROLE_PATH, body: { role: 'admin', requesterId: 'owner1' } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: ROLE_ERROR });
      assert.equal(r.saveCount, 0);
    });

    it('rejects a wrong-case role "Owner" with 400 (allow-list is case-sensitive) and no save', async () => {
      const r = await invoke({ method: 'PUT', pathname: ROLE_PATH, body: { role: 'Owner', requesterId: 'owner1' } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: ROLE_ERROR });
      assert.equal(r.saveCount, 0);
    });
  });

  describe('requesterId guard (403, reached only past a valid role)', () => {
    it('advances past the role guard for each valid role and returns 403 when requesterId is missing', async () => {
      // Every allow-listed role clears the role guard, proving it does not
      // over-reject; with no requesterId the handler then returns the 403.
      for (const role of VALID_ROLES) {
        const r = await invoke({ method: 'PUT', pathname: ROLE_PATH, body: { role } });
        assert.equal(r.status, 403, `valid role "${role}" should clear the role guard`);
        assert.deepEqual(r.payload, { error: REQUESTER_ERROR });
        assert.equal(r.saveCount, 0);
      }
    });

    it('rejects a non-string requesterId (number) with 403 and no save', async () => {
      const r = await invoke({ method: 'PUT', pathname: ROLE_PATH, body: { role: 'editor', requesterId: 5 } });
      assert.equal(r.status, 403);
      assert.deepEqual(r.payload, { error: REQUESTER_ERROR });
      assert.equal(r.saveCount, 0);
    });
  });

  describe('email and name type guards (400, reached only past a valid requesterId)', () => {
    it('rejects a non-string email (number) with 400 and no save', async () => {
      const r = await invoke({ method: 'PUT', pathname: ROLE_PATH, body: { role: 'editor', requesterId: 'owner1', email: 5 } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: EMAIL_ERROR });
      assert.equal(r.saveCount, 0);
    });

    it('rejects a non-string name (number) with 400 and no save', async () => {
      const r = await invoke({ method: 'PUT', pathname: ROLE_PATH, body: { role: 'editor', requesterId: 'owner1', name: 5 } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: NAME_ERROR });
      assert.equal(r.saveCount, 0);
    });
  });

  describe('rate limit guard (429, already-covered class, pinned here for completeness)', () => {
    it('returns 429 before any validation when rateLimit denies the request', async () => {
      const r = await invoke({
        method: 'PUT',
        pathname: ROLE_PATH,
        body: { role: 'editor', requesterId: 'owner1' },
        ctx: { rateLimit: () => false },
      });
      assert.equal(r.status, 429);
      assert.deepEqual(r.payload, { error: RATE_LIMIT_ERROR });
      assert.equal(r.saveCount, 0);
    });
  });
});
