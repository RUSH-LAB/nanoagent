import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

// Invoke POST /api/sessions with a minimal mocked ctx and capture the response
// handed to json(res, status, payload). loadJSON returns the supplied store
// verbatim: a plain object literal, so inherited names like toString and valueOf
// resolve to truthy values exactly as they would on the real loadJSON result.
// We deliberately do NOT inject Object into ctx, so the handler exercises the
// real global Object.hasOwn. saveJSON receives the same store the handler
// mutated, so `saved` lets us assert what would have been persisted.
async function invokePost({ body, sessions = {} }) {
  const pathname = '/api/sessions';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saveCalls = 0;
  let saved = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-feeds-write-ownprop-test',
    readBody: async () => body,
    loadJSON: () => sessions,
    saveJSON: (_file, data) => { saveCalls += 1; saved = data; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await feedsRoutes(req, res, url, pathname, ctx);
  return { captured, saveCalls, saved, store: sessions };
}

// A valid POST body for a given userId; startTime is required by the handler.
const postBody = (userId) => ({ userId, startTime: '2024-01-01T00:00:00.000Z' });

describe('POST /api/sessions own-property guard on userId', () => {
  // toString, valueOf, and hasOwnProperty resolve to truthy inherited functions
  // on a plain object. Before the fix the bare `if (!sessions[userId])` guard
  // skipped the array init, so the following `.push` threw a TypeError that the
  // try/catch swallowed into a misleading 400 "Invalid request". With
  // Object.hasOwn the handler creates a fresh own array under the requested key
  // and the write succeeds.
  for (const userId of ['toString', 'valueOf', 'hasOwnProperty']) {
    it(`persists a session under the inherited key "${userId}" (200)`, async () => {
      const { captured, store, saved, saveCalls } = await invokePost({ body: postBody(userId) });
      assert.equal(captured.status, 200);
      assert.equal(captured.payload.success, true);
      assert.ok(captured.payload.session);
      assert.equal(saveCalls, 1);
      assert.ok(Object.hasOwn(store, userId));
      assert.equal(store[userId].length, 1);
      assert.equal(store[userId][0].id, captured.payload.session.id);
      // saveJSON receives the object the handler mutated. The real
      // loadJSON/saveJSON deep-copy through JSON, so this identity holds for the
      // simplified mock here, not for the production persistence layer.
      assert.equal(saved, store);
    });
  }

  // The PROTO_KEYS denylist still rejects the true pollution keys with a 400
  // before the own-property init is reached, and nothing is persisted.
  for (const userId of ['__proto__', 'constructor', 'prototype']) {
    it(`rejects the prototype-pollution key "${userId}" with 400`, async () => {
      const { captured, saveCalls } = await invokePost({ body: postBody(userId) });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Invalid userId' });
      assert.equal(saveCalls, 0);
    });
  }

  // The two normal-userId cases below assert that ordinary keys behave exactly
  // as before (spec case c). They return 200 under either guard form, so the
  // inherited-key cases above are what actually catch a regression to the old
  // `if (!sessions[userId])` check; these document unchanged behavior.
  it('creates the first session under a normal, previously absent userId (200)', async () => {
    const { captured, store, saveCalls } = await invokePost({ body: postBody('alice') });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(saveCalls, 1);
    assert.equal(store['alice'].length, 1);
    assert.equal(store['alice'][0].id, captured.payload.session.id);
  });

  it('appends to an existing own-key userId without dropping prior sessions (200)', async () => {
    // Own key already present: Object.hasOwn is true, so the array is reused and
    // the new session is appended, byte-identical to the prior behavior.
    const sessions = { bob: [{ id: 'sess_prior', startTime: 'x', duration: 0 }] };
    const { captured, store, saveCalls } = await invokePost({ body: postBody('bob'), sessions });
    assert.equal(captured.status, 200);
    assert.equal(saveCalls, 1);
    assert.equal(store['bob'].length, 2);
    assert.equal(store['bob'][0].id, 'sess_prior');
    assert.equal(store['bob'][1].id, captured.payload.session.id);
  });
});
