import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load the real module the way the sibling
// server route tests do so this characterization test drives the genuine
// DELETE /api/notes handler in server/routes/comments-notes.js.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// Drive a single DELETE /api/notes request over a fully mocked ctx (no real
// filesystem, network, git, or clock). The DELETE reject branches under test
// fire before the PUT save path's only `new Date()`, so every case is
// deterministic. loadJSON and saveJSON each bump a counter so a test can prove
// the request bailed before reading or writing the notes store, and json
// captures the response so each assertion can read the status and body.
// Passing readBodyThrows exercises the outer catch.
async function invokeDelete({ body, readBodyThrows = false } = {}) {
  const pathname = '/api/notes';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  const ctx = {
    NOTES_FILE: 'notes.json',
    readBody: async () => {
      if (readBodyThrows) throw new Error('forced readBody failure');
      return body || {};
    },
    loadJSON: () => { loadCalls += 1; return {}; },
    saveJSON: () => { saveCalls += 1; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { captured, loadCalls, saveCalls };
}

describe('DELETE /api/notes missing or invalid key guard', () => {
  // The key guard is the first check inside the try, so it rejects before
  // loadJSON or saveJSON runs. A body with no key leaves `key` undefined, which
  // is falsy, so the `!key` half of the guard fires.
  it('rejects a body with no key with 400 and no load or save', async () => {
    const { captured, loadCalls, saveCalls } = await invokeDelete({ body: {} });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid key' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  // A present but non-string key (here a number) is truthy, so it clears the
  // `!key` half and is caught by the `typeof key !== 'string'` half of the same
  // guard, again before any read or write.
  it('rejects a numeric key with 400 and no load or save', async () => {
    const { captured, loadCalls, saveCalls } = await invokeDelete({ body: { key: 42 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid key' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});

describe('DELETE /api/notes outer catch', () => {
  // A throw anywhere in the try (here from readBody, standing in for a
  // malformed body) maps to the fixed delete-note 400 message. The throw
  // happens before loadJSON, so nothing is read and nothing is persisted.
  it('maps a readBody failure to the delete-note 400 error with no save', async () => {
    const { captured, loadCalls, saveCalls } = await invokeDelete({ readBodyThrows: true });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, {
      error: 'Failed to delete note: request body must be JSON with "key" (string) identifying the note to delete',
    });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});
