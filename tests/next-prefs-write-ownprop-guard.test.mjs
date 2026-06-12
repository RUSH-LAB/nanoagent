import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// Drive PUT /api/preferences with a minimal mocked ctx and capture both the
// response handed to json(res, status, payload) and the object handed to
// saveJSON. loadJSON returns `store` verbatim (a plain object literal), so
// inherited Object.prototype names like toString, valueOf, and hasOwnProperty
// resolve to truthy inherited functions exactly as they would on the real
// loadJSON result. `Object` is never injected into ctx, so the handler relies on
// the real global Object.hasOwn.
async function putPreferences({ body, store }) {
  const url = new URL('http://localhost/api/preferences');
  const req = { method: 'PUT', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const data = store || {};
  let captured = null;
  let saved = null;
  let saveCalls = 0;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/prefs-ownprop-test',
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => data,
    saveJSON: (_file, d) => { saved = d; saveCalls++; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, '/api/preferences', ctx);
  return { captured, saved, saveCalls };
}

// Read preferences back through the unchanged GET handler against a given store,
// the way a fresh process would after the store was persisted to and reloaded
// from disk.
async function getPreferences({ userId, store }) {
  const url = new URL(`http://localhost/api/preferences?userId=${encodeURIComponent(userId)}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/prefs-ownprop-test',
    loadJSON: () => store,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, '/api/preferences', ctx);
  return captured;
}

// Inherited Object.prototype member names. On a plain object literal each resolves
// to a truthy inherited function, so the pre-fix bare `!prefs[safeUserId]` test was
// false and skipped `prefs[safeUserId] = {}`. The writes then landed on the
// inherited function instead of a real own key, so JSON serialization dropped them
// and the preference silently failed to persist. None of these is in
// DANGEROUS_PREFERENCE_KEYS, so they clear the prototype-pollution guard and reach
// the init line under test.
const INHERITED = ['toString', 'valueOf', 'hasOwnProperty'];

describe('PUT /api/preferences own-property userId guard (no silent loss)', () => {
  for (const userId of INHERITED) {
    it(`persists preferences under the inherited userId "${userId}" as a real own key`, async () => {
      const { captured, saved, saveCalls } = await putPreferences({
        body: { userId, preferences: { theme: 'dark' } },
      });
      assert.equal(captured.status, 200);
      assert.equal(captured.payload.success, true);
      assert.equal(saveCalls, 1);

      // The own-property guard creates a real own key. The old truthy form left
      // the value on the inherited function, so the saved store carried no own
      // entry for the userId at all.
      assert.ok(Object.hasOwn(saved, userId), 'saved store has the userId as an own key');
      assert.equal(saved[userId].theme, 'dark');

      // Faithful persistence round trip: JSON.stringify drops non-own (inherited)
      // members, so a value written onto the inherited function would vanish here.
      // The GET handler then reads it back the way a fresh process would.
      const persisted = JSON.parse(JSON.stringify(saved));
      assert.ok(Object.hasOwn(persisted, userId), 'survives a JSON persistence round trip');
      const got = await getPreferences({ userId, store: persisted });
      assert.equal(got.status, 200);
      assert.equal(got.payload.preferences.theme, 'dark', 'reads back the persisted preference');
    });
  }

  it('round-trips a normal userId (persist then read back)', async () => {
    const { captured, saved, saveCalls } = await putPreferences({
      body: { userId: 'alice', preferences: { theme: 'dark', fontSize: 14 } },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(captured.payload.preferences.theme, 'dark');
    assert.equal(saveCalls, 1);
    assert.ok(Object.hasOwn(saved, 'alice'));
    assert.equal(saved.alice.theme, 'dark');
    assert.equal(saved.alice.fontSize, 14);

    const persisted = JSON.parse(JSON.stringify(saved));
    const got = await getPreferences({ userId: 'alice', store: persisted });
    assert.equal(got.status, 200);
    assert.equal(got.payload.preferences.theme, 'dark');
    assert.equal(got.payload.preferences.fontSize, 14);
  });

  it('merges into an existing own-key user without clobbering prior preferences', async () => {
    const store = { alice: { theme: 'light', locale: 'en' } };
    const { captured, saved } = await putPreferences({
      body: { userId: 'alice', preferences: { theme: 'dark' } }, store,
    });
    assert.equal(captured.status, 200);
    assert.equal(saved.alice.theme, 'dark', 'updates the changed key');
    assert.equal(saved.alice.locale, 'en', 'leaves the untouched key in place');
  });
});
