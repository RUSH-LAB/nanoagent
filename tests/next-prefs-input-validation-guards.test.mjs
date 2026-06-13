import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real module the way the other server
// route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// Drive a single PUT /api/preferences request over a fully mocked ctx and capture
// the response handed to json(res, status, payload). The three input validators
// pinned here (userId presence and type at line 758, userId length at line 759,
// preferences presence and type at line 760) all run after readBody but before
// loadJSON and saveJSON. loadJSON and saveJSON are wired as counters and asserted
// to stay at zero: a tripped guard rejects with a 400 and never reads or writes
// the preferences store, so each case is deterministic and never persists.
async function putPreferences({ body }) {
  const url = new URL('http://localhost/api/preferences');
  const req = { method: 'PUT', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/prefs-input-validation-test',
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => { loadCalls++; return {}; },
    saveJSON: () => { saveCalls++; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, '/api/preferences', ctx);
  return { captured, loadCalls, saveCalls };
}

describe('PUT /api/preferences userId presence and type guard (line 758)', () => {
  it('rejects a missing userId with 400 Missing or invalid userId', async () => {
    // userId absent: the body carries only a valid preferences object, so the
    // first guard is the one that fires.
    const { captured, loadCalls, saveCalls } = await putPreferences({
      body: { preferences: { theme: 'dark' } },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid userId' });
    assert.equal(loadCalls, 0, 'a rejected request never reads the store');
    assert.equal(saveCalls, 0, 'a rejected request never persists');
  });

  it('rejects a non-string userId (number) with 400 Missing or invalid userId', async () => {
    // A truthy non-string clears the falsy half of the guard and trips the
    // typeof check instead (42 is truthy, so 0 would take the other branch).
    const { captured, loadCalls, saveCalls } = await putPreferences({
      body: { userId: 42, preferences: { theme: 'dark' } },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid userId' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});

describe('PUT /api/preferences userId length guard (line 759)', () => {
  it('rejects a userId longer than 200 characters with 400 userId must be 200 characters or fewer', async () => {
    // A 201 character string clears the presence and type guard and is the first
    // input to exceed the length cap, so the length guard is what rejects.
    const { captured, loadCalls, saveCalls } = await putPreferences({
      body: { userId: 'a'.repeat(201), preferences: { theme: 'dark' } },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'userId must be 200 characters or fewer' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});

describe('PUT /api/preferences preferences presence and type guard (line 760)', () => {
  it('rejects missing preferences with 400 Missing or invalid preferences', async () => {
    // A valid short userId clears the two userId guards; preferences is absent,
    // so the falsy half of the preferences guard fires.
    const { captured, loadCalls, saveCalls } = await putPreferences({
      body: { userId: 'alice' },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid preferences' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('rejects array preferences with 400 Missing or invalid preferences', async () => {
    // An array is truthy and typeof 'object', so it clears the first two clauses
    // of the guard and is caught by the Array.isArray check.
    const { captured, loadCalls, saveCalls } = await putPreferences({
      body: { userId: 'alice', preferences: ['theme', 'dark'] },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid preferences' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('rejects a non-object scalar preferences (string) with 400 Missing or invalid preferences', async () => {
    // A non-empty string is truthy but typeof 'string', so the typeof clause of
    // the guard rejects it.
    const { captured, loadCalls, saveCalls } = await putPreferences({
      body: { userId: 'alice', preferences: 'dark' },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid preferences' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});
