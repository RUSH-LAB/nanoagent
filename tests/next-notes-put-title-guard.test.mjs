import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load the real module the way the sibling
// server route tests do so this characterization test drives the genuine
// PUT /api/notes save handler in server/routes/comments-notes.js.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// sanitizeText is mocked as a tagged function: it prefixes real strings and
// passes falsy or non-string inputs through untouched. The 'S:' tag makes the
// handler's `sanitizeText(title) || key` fallback observable. A defaulted
// title surfaces as the raw key (no prefix), while a sanitized title surfaces
// with the prefix, so the two cannot be confused.
const SANITIZE_TAG = 'S:';
const sanitizeText = (s) => (typeof s === 'string' ? SANITIZE_TAG + s : s);

// Drive a single PUT /api/notes request over a fully mocked ctx (no real
// filesystem, network, or git). loadJSON hands back a fresh empty map per
// call, saveJSON records both how many writes happened and the exact payload
// persisted, and json captures the response so each assertion can read the
// status and body. Passing readBodyThrows exercises the outer catch.
async function invokePut({ body, readBodyThrows = false } = {}) {
  const pathname = '/api/notes';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'PUT', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saveCalls = 0;
  let savedPayload = null;
  const ctx = {
    NOTES_FILE: 'notes.json',
    readBody: async () => {
      if (readBodyThrows) throw new Error('forced readBody failure');
      return body || {};
    },
    loadJSON: () => ({}),
    saveJSON: (_file, payload) => {
      saveCalls += 1;
      savedPayload = payload;
    },
    sanitizeText,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { captured, saveCalls, savedPayload };
}

describe('PUT /api/notes title must be a string guard', () => {
  // The title guard sits after the key, length, content, and proto-key guards,
  // so reaching it with a valid non-proto key and a string content also
  // confirms those earlier guards passed. A non-undefined, non-string title is
  // rejected before loadJSON or saveJSON runs, so nothing is persisted.
  it('rejects a numeric title with 400 title must be a string and no save', async () => {
    const { captured, saveCalls } = await invokePut({ body: { key: 'note-1', content: 'hello', title: 42 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'title must be a string' });
    assert.equal(saveCalls, 0);
  });

  it('rejects an object title with 400 title must be a string and no save', async () => {
    const { captured, saveCalls } = await invokePut({ body: { key: 'note-1', content: 'hello', title: {} } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'title must be a string' });
    assert.equal(saveCalls, 0);
  });
});

describe('PUT /api/notes title success branches', () => {
  // The disambiguating, notes-only behavior: an omitted title flows through
  // `sanitizeText(undefined) || key` and persists as the raw key. The 'S:' tag
  // on content (but not title) proves the fallback took the key, not a
  // sanitized title. updatedAt is `new Date().toISOString()`, so the test pins
  // its type only and never the clock.
  it('defaults an omitted title to the key on a successful save', async () => {
    const { captured, saveCalls, savedPayload } = await invokePut({ body: { key: 'note-1', content: 'hello' } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCalls, 1);
    const stored = savedPayload['note-1'];
    assert.equal(stored.title, 'note-1');
    assert.equal(stored.content, sanitizeText('hello'));
    assert.equal(typeof stored.updatedAt, 'string');
  });

  // An explicit string title is stored as the sanitizeText output: the tagged
  // value is truthy, so the `|| key` fallback is not taken.
  it('stores an explicit string title through sanitizeText on a successful save', async () => {
    const { captured, saveCalls, savedPayload } = await invokePut({ body: { key: 'note-1', content: 'hello', title: 'My Note' } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCalls, 1);
    assert.equal(savedPayload['note-1'].title, sanitizeText('My Note'));
  });
});

describe('PUT /api/notes title length cap', () => {
  // A string title clears the type guard, so it is the length cap that rejects
  // a 501 character title, again before any write.
  it('rejects a title longer than 500 characters with no save', async () => {
    const { captured, saveCalls } = await invokePut({ body: { key: 'note-1', content: 'hello', title: 'x'.repeat(501) } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Title must be 500 characters or fewer' });
    assert.equal(saveCalls, 0);
  });

  // The boundary: a title of exactly 500 characters clears the cap and saves.
  it('accepts a title of exactly 500 characters', async () => {
    const title = 'x'.repeat(500);
    const { captured, saveCalls, savedPayload } = await invokePut({ body: { key: 'note-1', content: 'hello', title } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCalls, 1);
    assert.equal(savedPayload['note-1'].title, sanitizeText(title));
  });
});

describe('PUT /api/notes outer catch', () => {
  // A throw anywhere in the try (here from readBody) maps to the fixed
  // save-note 400 message, and nothing is persisted.
  it('maps a readBody failure to the save-note 400 error', async () => {
    const { captured, saveCalls } = await invokePut({ readBodyThrows: true });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, {
      error: 'Failed to save note: request body must be JSON with "key" (string) and "content" (string) fields',
    });
    assert.equal(saveCalls, 0);
  });
});
