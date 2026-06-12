import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// The three keys the prototype-pollution guard must reject as either a userId or
// a preference key. Hoisting the per-request Set into the module-scope
// DANGEROUS_PREFERENCE_KEYS must not change which keys are blocked, so the table
// is exercised in full at both guarded positions.
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

// Build a preferences object that carries `key` as a genuine own-enumerable
// property. A plain object literal `{ __proto__: v }` would set the prototype
// instead of creating an own key, so Object.keys would miss it; JSON.parse takes
// the [[DefineOwnProperty]] path and reproduces the real pollution vector the
// handler defends against.
function prefsWithKey(key) {
  return JSON.parse(`{ ${JSON.stringify(key)}: "evil" }`);
}

// Invoke the PUT /api/preferences handler in-process with a minimal mocked ctx
// and capture the response handed to json(res, status, payload). No network and
// no real filesystem: readBody returns the test body verbatim and rateLimit lets
// the request through so it reaches the guard.
async function putPreferences({ body, ctx = {} }) {
  const url = new URL('http://localhost/api/preferences');
  const req = { method: 'PUT', socket: { remoteAddress: '127.0.0.1' } };
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
  await studyKnowledgeRoutes(req, res, url, '/api/preferences', fullCtx);
  return captured;
}

describe('PUT /api/preferences userId proto-key guard (hoisted DANGEROUS_PREFERENCE_KEYS)', () => {
  for (const userId of DANGEROUS_KEYS) {
    it(`rejects a dangerous userId "${userId}" with 400 Invalid userId`, async () => {
      // A valid preferences object clears the earlier validators so the proto-key
      // guard is what produces the rejection.
      const r = await putPreferences({ body: { userId, preferences: { theme: 'dark' } } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: 'Invalid userId' });
    });
  }
});

describe('PUT /api/preferences preference-key proto-key guard (hoisted DANGEROUS_PREFERENCE_KEYS)', () => {
  for (const key of DANGEROUS_KEYS) {
    it(`rejects a dangerous preference key "${key}" with 400 Invalid preference key`, async () => {
      // A safe userId so the userId guard passes and the per-key guard is reached.
      const r = await putPreferences({ body: { userId: 'alice', preferences: prefsWithKey(key) } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: `Invalid preference key: ${key}` });
    });
  }

  it('confirms the malicious preferences object really carries the key as own-enumerable', () => {
    // Guards against a false pass: if prefsWithKey ever stopped producing an own
    // key, the rejection tests above would silently no-op.
    for (const key of DANGEROUS_KEYS) {
      assert.deepEqual(Object.keys(prefsWithKey(key)), [key]);
    }
  });
});

describe('PUT /api/preferences accepts a valid userId + key (guard does not over-reject)', () => {
  it('persists a normal preference and returns 200', async () => {
    let saved = null;
    const r = await putPreferences({
      body: { userId: 'alice', preferences: { theme: 'dark' } },
      ctx: {
        PROJECT_ROOT: '/tmp/prefs-test-root',
        path,
        loadJSON: () => ({}),
        saveJSON: (_file, data) => { saved = data; },
        sanitizeText: (s) => s,
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.success, true);
    assert.equal(r.payload.preferences.theme, 'dark', 'returns the stored preference');
    assert.ok(saved && saved.alice, 'persists under the userId key');
    assert.equal(saved.alice.theme, 'dark', 'persists the preference value');
  });
});
