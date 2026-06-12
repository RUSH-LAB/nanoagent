import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// Drive the /api/notes handlers with a minimal mocked ctx and capture the
// response handed to json(res, status, payload). loadJSON returns the supplied
// notes map verbatim (a plain object literal), so inherited names like toString
// and valueOf resolve to truthy values exactly as they would on the real
// loadJSON result; the own-property guard is what keeps them from being read or
// from faking a successful delete. `Object` is never injected into ctx, so the
// handler exercises the real global Object.hasOwn. GET reads `key` from the
// query string; PUT and DELETE read it from the body.
async function invoke({ method, key, body, notes = {} }) {
  const pathname = '/api/notes';
  const qs = method === 'GET' && key !== undefined ? `?key=${encodeURIComponent(key)}` : '';
  const url = new URL(`http://localhost${pathname}${qs}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saveCalls = 0;
  const ctx = {
    NOTES_FILE: 'notes.json',
    readBody: async () => body || {},
    loadJSON: () => notes,
    saveJSON: () => { saveCalls += 1; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { captured, saveCalls, store: notes };
}

describe('GET /api/notes own-property key guard', () => {
  // Inherited Object.prototype members resolve to truthy values on a plain
  // object, so the old `notes[key] || null` returned the inherited function
  // instead of null. The own-property guard now reports a clean miss.
  for (const key of ['toString', 'valueOf', 'hasOwnProperty']) {
    it(`returns {note: null} for the inherited key "${key}"`, async () => {
      const { captured } = await invoke({ method: 'GET', key });
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.payload, { note: null });
    });
  }

  it('returns {note: null} for an absent normal key', async () => {
    const { captured } = await invoke({ method: 'GET', key: 'docs/intro' });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { note: null });
  });
});

describe('DELETE /api/notes own-property key guard', () => {
  // For an absent key whose name is an inherited member, the old `if (!notes[key])`
  // test saw the truthy inherited function, skipped the 404, deleted nothing, and
  // returned a false 200 success. The own-property guard now returns a real 404
  // and never persists.
  for (const key of ['toString', 'valueOf', 'hasOwnProperty']) {
    it(`returns 404 (not a false success) for the inherited key "${key}"`, async () => {
      const { captured, saveCalls } = await invoke({ method: 'DELETE', body: { key } });
      assert.equal(captured.status, 404);
      assert.deepEqual(captured.payload, { error: 'Note not found' });
      assert.equal(saveCalls, 0);
    });
  }

  // The prototype-pollution names stay rejected by the unchanged PROTO_KEYS guard
  // with a 400 before the own-property guard is reached, and nothing is persisted.
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    it(`rejects the prototype-pollution key "${key}" with 400`, async () => {
      const { captured, saveCalls } = await invoke({ method: 'DELETE', body: { key } });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Invalid key' });
      assert.equal(saveCalls, 0);
    });
  }
});

describe('notes round-trip for a real saved note', () => {
  // A normal note saved through PUT must still be readable through GET and
  // removable through DELETE: the own-property guard only rejects inherited keys.
  it('saves, reads, then deletes a normal note', async () => {
    const notes = {};

    const put = await invoke({ method: 'PUT', body: { key: 'my-note', content: 'hello', title: 'My Note' }, notes });
    assert.equal(put.captured.status, 200);
    assert.deepEqual(put.captured.payload, { success: true });
    assert.equal(put.saveCalls, 1);
    assert.ok(Object.hasOwn(notes, 'my-note'));

    const get = await invoke({ method: 'GET', key: 'my-note', notes });
    assert.equal(get.captured.status, 200);
    assert.equal(get.captured.payload.note.content, 'hello');
    assert.equal(get.captured.payload.note.title, 'My Note');

    const del = await invoke({ method: 'DELETE', body: { key: 'my-note' }, notes });
    assert.equal(del.captured.status, 200);
    assert.deepEqual(del.captured.payload, { success: true });
    assert.equal(del.saveCalls, 1);
    assert.ok(!Object.hasOwn(notes, 'my-note'));
  });
});
