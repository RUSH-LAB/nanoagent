import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-c.js');

// Drive the real POST /api/template-variables handler in process (no network) and
// capture the response handed to json(res, status, payload). The prototype-pollution
// guard was hoisted from a per-request `new Set(...)` to the module-scope
// TEMPLATE_VAR_PROTO_KEYS, so these tests pin the guard's behavior and prove the
// hoist preserved it. rateLimit is stubbed open so the limiter never masks a result;
// readBody yields the supplied body; loadJSON / saveJSON / sanitizeText are stubs so
// the happy path performs no real file I/O.
async function invokePost(body, extraCtx = {}) {
  const url = new URL('http://localhost/api/template-variables');
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    rateLimit: () => true,
    readBody: async () => body,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    ...extraCtx,
  };
  await routes(req, res, url, '/api/template-variables', ctx);
  return captured;
}

// File-I/O stubs for the accept path: loadJSON starts from an empty store, saveJSON
// captures what would be written, and sanitizeText is identity so the assertions read
// the raw name and value the handler echoes back.
function acceptCtx(saved) {
  return {
    path,
    PROJECT_ROOT: '/tmp/template-vars-test',
    loadJSON: () => ({}),
    saveJSON: (file, data) => { if (saved) saved.push({ file, data }); },
    sanitizeText: s => s,
  };
}

// Each reserved key is alphanumeric, so it sails past the
// `/^[a-zA-Z_][a-zA-Z0-9_-]*$/` name-format check; the only thing rejecting it is the
// TEMPLATE_VAR_PROTO_KEYS guard. The distinct 'Invalid variable name' message proves
// the 400 comes from that guard branch rather than the format check.
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];

describe('POST /api/template-variables (hoisted module-scope TEMPLATE_VAR_PROTO_KEYS)', () => {
  for (const key of PROTO_KEYS) {
    it(`rejects the prototype-polluting name "${key}" with HTTP 400`, async () => {
      const r = await invokePost({ name: key, value: 'whatever' });
      assert.equal(r.status, 400);
      assert.equal(r.payload.error, 'Invalid variable name');
    });
  }

  it('accepts a valid name + value and persists the pair', async () => {
    const saved = [];
    const r = await invokePost({ name: 'my_var', value: 'hello world' }, acceptCtx(saved));
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { success: true, name: 'my_var', value: 'hello world' });
    assert.equal(saved.length, 1, 'the accepted variable is written exactly once');
    assert.deepEqual(saved[0].data.variables, { my_var: 'hello world' });
  });

  it('keeps rejecting after an accepted write (shared Set is read-only, no state bleed)', async () => {
    // .has() never mutates the Set, so an earlier accepted request cannot weaken the
    // guard for a later one. Interleave an accept between two rejects to prove the one
    // shared TEMPLATE_VAR_PROTO_KEYS instance stays intact across requests.
    const reject1 = await invokePost({ name: '__proto__', value: 'x' });
    const accept = await invokePost({ name: 'safe', value: 'ok' }, acceptCtx());
    const reject2 = await invokePost({ name: 'constructor', value: 'x' });
    assert.equal(reject1.status, 400);
    assert.equal(reject1.payload.error, 'Invalid variable name');
    assert.equal(accept.status, 200);
    assert.equal(reject2.status, 400);
    assert.equal(reject2.payload.error, 'Invalid variable name');
  });
});
