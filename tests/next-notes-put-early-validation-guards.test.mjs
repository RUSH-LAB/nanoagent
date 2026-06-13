import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load the real module the way the sibling
// server route tests do so this characterization test drives the genuine
// PUT /api/notes save handler in server/routes/comments-notes.js.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// Drive a single PUT /api/notes request over a fully mocked ctx (no real
// filesystem, network, or git). loadJSON and saveJSON are wired as tripwires:
// every early key/content guard rejects with a 400 BEFORE loadJSON (line 121),
// the only new Date() (line 122), and saveJSON (line 123) run, so on each
// rejected case both counters must stay at 0. sanitizeText is identity so the
// boundary-accept cases can read back exactly what was persisted. The handler
// dispatches on method plus pathname, so setting method PUT and pathname
// /api/notes scopes every assertion to the save handler even where a rung's
// message (for example 'Missing or invalid key') is shared with another route.
async function invokePut({ body } = {}) {
  const pathname = '/api/notes';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'PUT', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  let savedPayload = null;
  const ctx = {
    NOTES_FILE: 'notes.json',
    readBody: async () => body || {},
    loadJSON: () => { loadCalls += 1; return {}; },
    saveJSON: (_file, payload) => { saveCalls += 1; savedPayload = payload; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { captured, loadCalls, saveCalls, savedPayload };
}

describe('PUT /api/notes key presence and type guard (line 114)', () => {
  it('rejects a missing key with 400 Missing or invalid key and never touches the store', async () => {
    // No key field at all: the falsy half of `!key || typeof key !== 'string'`
    // fires. A valid string content is supplied so this guard is unambiguously
    // the rung that rejects.
    const { captured, loadCalls, saveCalls } = await invokePut({ body: { content: 'hello' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid key' });
    assert.equal(loadCalls, 0, 'a rejected request never reads the notes store');
    assert.equal(saveCalls, 0, 'a rejected request never persists');
  });

  it('rejects a non-string key (number) with 400 Missing or invalid key and never touches the store', async () => {
    // 42 is truthy, so it clears the `!key` half and trips the typeof half
    // instead (0 would take the falsy branch, so a truthy non-string is used).
    const { captured, loadCalls, saveCalls } = await invokePut({ body: { key: 42, content: 'hello' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid key' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});

describe('PUT /api/notes key length cap (line 115)', () => {
  it('rejects a key longer than 200 characters with 400 Key must be 200 characters or fewer and no save', async () => {
    // A 201 character string clears the presence and type guard and is the
    // first input to exceed the cap, so the length guard rejects it. This is
    // the globally unique anchor message for the handler.
    const { captured, loadCalls, saveCalls } = await invokePut({ body: { key: 'a'.repeat(201), content: 'hello' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Key must be 200 characters or fewer' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('accepts a key of exactly 200 characters (the cap is inclusive)', async () => {
    // The boundary: 200 > 200 is false, so a 200 character key clears the cap,
    // and with a valid string content the handler reaches the success path,
    // reading the store once and persisting once under that key.
    const key = 'a'.repeat(200);
    const { captured, loadCalls, saveCalls, savedPayload } = await invokePut({ body: { key, content: 'hello' } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(loadCalls, 1);
    assert.equal(saveCalls, 1);
    assert.ok(savedPayload[key], 'persists under the 200 character key');
  });
});

describe('PUT /api/notes content type guard (line 116)', () => {
  it('rejects a non-string content (number) with 400 Content must be a string and no save', async () => {
    // A valid key clears the first two guards; content 42 is not a string, so
    // the typeof guard rejects before any read or write. Unlike the key guard
    // there is no falsy short-circuit here, the check is purely typeof.
    const { captured, loadCalls, saveCalls } = await invokePut({ body: { key: 'note-1', content: 42 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Content must be a string' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('rejects a missing content with 400 Content must be a string and no save', async () => {
    // content omitted entirely: typeof undefined !== 'string', so the same
    // guard fires. There is no separate presence check for content.
    const { captured, loadCalls, saveCalls } = await invokePut({ body: { key: 'note-1' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Content must be a string' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});

describe('PUT /api/notes content length cap (line 117)', () => {
  it('rejects content longer than 50000 characters with 400 Content must be 50000 characters or fewer and no save', async () => {
    // A 50001 character string clears the type guard and is the first content
    // to exceed the cap, so the length guard rejects it before any write.
    const { captured, loadCalls, saveCalls } = await invokePut({ body: { key: 'note-1', content: 'x'.repeat(50001) } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Content must be 50000 characters or fewer' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('accepts content of exactly 50000 characters (the cap is inclusive)', async () => {
    // The boundary: 50000 > 50000 is false, so a 50000 character content clears
    // the cap and the handler persists once with that content intact.
    const content = 'x'.repeat(50000);
    const { captured, loadCalls, saveCalls, savedPayload } = await invokePut({ body: { key: 'note-1', content } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(loadCalls, 1);
    assert.equal(saveCalls, 1);
    assert.equal(savedPayload['note-1'].content, content);
  });
});
