import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

// The three dangerous keys the shared PROTO_KEYS guard must reject. POST
// /api/presence used both filePath and userId directly as map keys on
// presenceStore, so each must be screened the same way its sibling write
// handlers already screen their keys.
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

// Drive the presence route handler over a minimal mocked ctx and capture the
// response handed to json(res, status, payload). readBody returns the test body
// verbatim; rateLimit allows the request so POST reaches its validators;
// cleanStalePresence is a no-op so the handler stays self-contained; each test
// passes its own fresh presenceStore through ctx.
async function invoke({ body, presenceStore = {}, ctx = {} }) {
  const pathname = '/api/presence';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
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
    cleanStalePresence: () => {},
    sanitizeText: (s) => s,
    presenceStore,
    ...ctx,
  };
  await analyticsUsersRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('POST /api/presence proto-key guard', () => {
  it('rejects filePath "__proto__" and leaves Object.prototype unpolluted', async () => {
    // Load-bearing proof: without the guard, presenceStore['__proto__'] reads
    // Object.prototype, so presenceStore['__proto__']['evil'] = {...} writes onto
    // Object.prototype and every later {} inherits the injected key. The guard
    // returns 400 before that write, so the fresh object below stays clean.
    const r = await invoke({ body: { filePath: '__proto__', userId: 'evil' } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid filePath or userId' });
    assert.equal(({}).evil, undefined, 'a fresh object must not inherit an injected key');
    assert.equal(Object.prototype.evil, undefined, 'Object.prototype must stay unpolluted');
  });

  it('rejects userId "__proto__" with 400', async () => {
    const r = await invoke({ body: { filePath: 'docs/x.md', userId: '__proto__' } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid filePath or userId' });
  });

  for (const key of DANGEROUS_KEYS) {
    it(`rejects a dangerous filePath "${key}" with 400`, async () => {
      // A valid-length userId clears the earlier validators so the proto-key
      // guard is what produces the rejection.
      const r = await invoke({ body: { filePath: key, userId: 'alice' } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: 'Invalid filePath or userId' });
    });

    it(`rejects a dangerous userId "${key}" with 400`, async () => {
      // A valid filePath clears the earlier validators so the proto-key guard is
      // what produces the rejection.
      const r = await invoke({ body: { filePath: 'docs/intro.md', userId: key } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: 'Invalid filePath or userId' });
    });
  }

  it('still records a normal filePath and userId (the guard does not over-reject)', async () => {
    const presenceStore = {};
    const r = await invoke({
      body: { filePath: 'docs/intro.md', userId: 'alice', userName: 'Alice' },
      presenceStore,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { success: true });
    assert.ok(
      presenceStore['docs/intro.md'] && presenceStore['docs/intro.md']['alice'],
      'records presence under the filePath and userId keys',
    );
    assert.equal(presenceStore['docs/intro.md']['alice'].userName, 'Alice');
  });
});
