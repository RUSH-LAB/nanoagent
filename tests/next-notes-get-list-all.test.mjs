import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load the real module the way the sibling
// server route tests do so this characterization test drives the genuine
// GET /api/notes handler in server/routes/comments-notes.js.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// Drive a single GET /api/notes request over a fully mocked ctx (no real
// filesystem, network, git, or clock; the list-all read path touches none of
// them). loadJSON counts its calls and records the file it was handed, then
// returns the supplied store by reference so a test can prove the handler
// passes the store straight through. saveJSON is a tripwire whose count must
// stay 0 on this read-only path, and json captures the response so each
// assertion can read the status and body.
async function invokeGet({ search = '', store = {} } = {}) {
  const pathname = '/api/notes';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let loadFile = null;
  let saveCalls = 0;
  const ctx = {
    NOTES_FILE: 'notes.json',
    loadJSON: (file) => {
      loadCalls += 1;
      loadFile = file;
      return store;
    },
    saveJSON: () => { saveCalls += 1; },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { captured, loadCalls, loadFile, saveCalls };
}

describe('GET /api/notes no-key list-all projection', () => {
  // The disambiguating, list-all behavior: with no `key` query param,
  // `url.searchParams.get('key')` is null (falsy), so the handler skips the
  // single-note branch and returns the whole store under `{notes}`. It reads
  // once via loadJSON from NOTES_FILE and never writes. The payload's notes is
  // the exact object loadJSON returned (a passthrough, no copy or transform).
  it('returns {notes} deep-equal to the full multi-entry store on a no-key GET (list-all)', async () => {
    const store = {
      'page-a': { content: 'first note', title: 'A', updatedAt: '2020-01-01T00:00:00.000Z' },
      'page-b': { content: 'second note', title: 'B', updatedAt: '2020-02-02T00:00:00.000Z' },
    };
    const { captured, loadCalls, loadFile, saveCalls } = await invokeGet({ store });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { notes: store });
    // The store is returned by reference, confirming a straight projection.
    assert.equal(captured.payload.notes, store);
    // A single deterministic read from the notes store, and no write.
    assert.equal(loadCalls, 1);
    assert.equal(loadFile, 'notes.json');
    assert.equal(saveCalls, 0);
  });

  // An empty store still takes the list-all branch and projects to an empty
  // map, distinguishing "no notes yet" (200 with {notes: {}}) from any error or
  // single-note shape.
  it('returns {notes: {}} for an empty store on a no-key GET (list-all)', async () => {
    const { captured, loadCalls, saveCalls } = await invokeGet({ store: {} });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { notes: {} });
    assert.equal(loadCalls, 1);
    assert.equal(saveCalls, 0);
  });

  // An empty-string `?key=` resolves to '' (falsy), so the `if (key)` test is
  // false and the request still takes the list-all branch, not the truthy-key
  // single-note path the existing GET /api/notes tests already cover. The
  // response carries `notes`, never `note`.
  it('treats an empty-string ?key= as falsy and still takes the list-all branch', async () => {
    const store = {
      'page-a': { content: 'first note', title: 'A', updatedAt: '2020-01-01T00:00:00.000Z' },
    };
    const { captured, saveCalls } = await invokeGet({ search: '?key=', store });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { notes: store });
    // It is the list-all shape, not the single-note {note} shape.
    assert.ok(Object.hasOwn(captured.payload, 'notes'));
    assert.ok(!Object.hasOwn(captured.payload, 'note'));
    assert.equal(saveCalls, 0);
  });
});
