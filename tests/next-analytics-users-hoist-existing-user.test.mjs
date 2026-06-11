import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// analytics-users.js and data-store.js are CommonJS; load them the way the
// other server route tests do. The real loadJSON/saveJSON give the handler a
// genuine round-trip through a temporary USERS_FILE so the persisted record is
// the actual bytes on disk, not a mock.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');
const { loadJSON, saveJSON } = require('../server/data-store.js');

// Mirror server-utils sanitizeText for the short strings this test feeds in:
// pass strings through, coerce anything non-string to ''.
const sanitizeText = (s) => (typeof s === 'string' ? s : '');

// Unique scratch dir for the fixtures, removed once the suite finishes.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-users-hoist-'));
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

let fileCounter = 0;

// Seed a fresh USERS_FILE, invoke PUT /api/users/:id/role, and return both the
// captured json() response and the record read straight back off disk. A new
// file per call keeps the loadJSON cache from leaking state between cases.
async function setRole({ userId, body, seed }) {
  const USERS_FILE = path.join(tmpDir, `users-${fileCounter++}.json`);
  fs.writeFileSync(USERS_FILE, JSON.stringify(seed, null, 2), 'utf-8');

  let captured = null;
  const req = { method: 'PUT', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const ctx = {
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON,
    saveJSON,
    sanitizeText,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    USERS_FILE,
  };
  const pathname = `/api/users/${userId}/role`;
  const url = new URL(`http://localhost${pathname}`);
  await analyticsUsersRoutes(req, res, url, pathname, ctx);

  const persisted = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  return { ...captured, persisted };
}

const OWNER = {
  owner1: {
    role: 'owner',
    email: 'owner@example.com',
    name: 'Owner One',
    addedAt: '2020-01-01T00:00:00.000Z',
  },
};

describe('PUT /api/users/:id/role hoists the pre-existing record', () => {
  it('preserves an existing user\'s addedAt, email, and name when not supplied', async () => {
    const original = {
      role: 'viewer',
      email: 'alice@example.com',
      name: 'Alice',
      addedAt: '2021-06-15T08:30:00.000Z',
    };
    const r = await setRole({
      userId: 'alice',
      body: { role: 'editor', requesterId: 'owner1' },
      seed: { ...OWNER, alice: original },
    });

    assert.equal(r.status, 200);
    assert.equal(r.payload.success, true);
    // Role updated; the three unsupplied fields fall back to the prior record.
    assert.deepEqual(r.payload.user, {
      role: 'editor',
      email: 'alice@example.com',
      name: 'Alice',
      addedAt: '2021-06-15T08:30:00.000Z',
    });
    // The persisted bytes match the response exactly.
    assert.deepEqual(r.persisted.alice, r.payload.user);
    // The owner record is untouched by the update.
    assert.deepEqual(r.persisted.owner1, OWNER.owner1);
  });

  it('creates a brand-new user with the supplied role and a fresh record', async () => {
    const before = new Date().toISOString();
    const r = await setRole({
      userId: 'bob',
      body: { role: 'editor', email: 'bob@example.com', name: 'Bob', requesterId: 'owner1' },
      seed: { ...OWNER },
    });
    const after = new Date().toISOString();

    assert.equal(r.status, 200);
    assert.equal(r.payload.success, true);
    assert.equal(r.payload.user.role, 'editor');
    assert.equal(r.payload.user.email, 'bob@example.com');
    assert.equal(r.payload.user.name, 'Bob');
    // A fresh addedAt is stamped; assert it is a real ISO time in range, never
    // an exact value.
    assert.ok(typeof r.payload.user.addedAt === 'string' && r.payload.user.addedAt.length > 0);
    assert.ok(r.payload.user.addedAt >= before && r.payload.user.addedAt <= after,
      'new user addedAt is stamped at creation time');
    assert.deepEqual(r.persisted.bob, r.payload.user);
  });

  it('returns the {success, user:{role,email,name,addedAt}} shape', async () => {
    const r = await setRole({
      userId: 'carol',
      body: { role: 'viewer', email: 'carol@example.com', name: 'Carol', requesterId: 'owner1' },
      seed: { ...OWNER },
    });

    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.payload).sort(), ['success', 'user']);
    assert.deepEqual(Object.keys(r.payload.user).sort(), ['addedAt', 'email', 'name', 'role']);
  });

  it('keeps the owner-only authorization guard (non-owner is rejected)', async () => {
    const r = await setRole({
      userId: 'alice',
      body: { role: 'editor', requesterId: 'someViewer' },
      seed: { ...OWNER, someViewer: { role: 'viewer', email: '', name: '', addedAt: '2022-01-01T00:00:00.000Z' } },
    });
    assert.equal(r.status, 403);
    assert.equal(r.payload.error, 'Only owners can change roles');
  });
});
