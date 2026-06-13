import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

// bookmarks-reading-lists.js is CommonJS; load it the way the other route tests do.
// This suite guards the single-trim refactor of POST /api/reading-lists: the name
// is trimmed once into `const trimmedName`, reused by both the empty-name guard and
// the sanitized list name, instead of calling `name.trim()` twice. The change is
// behavior-preserving (byte-identical responses), so the assertions below pin the
// exact status/body for every input class the original single guard covered.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

const SOURCE_PATH = new URL('../server/routes/bookmarks-reading-lists.js', import.meta.url);
const READING_LISTS_FILE = '/fake/reading-lists.json';

// Drive the real POST /api/reading-lists handler over a mocked ctx and capture
// both the json() response and the object handed to saveJSON. A fresh empty store
// per call (loadJSON returns `{}`) exercises the `if (!data.lists) data.lists = []`
// path and keeps cases independent. `sanitizeText` records each argument and tags
// its output with an `S:` prefix, so we can prove the value it received was already
// trimmed and that the tag survives onto the persisted list name.
async function createReadingList(body) {
  const sanitizeArgs = [];
  let captured = null;
  let saved = null;
  const ctx = {
    crypto,
    READING_LISTS_FILE,
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => ({}),
    saveJSON: (_file, data) => { saved = data; },
    sanitizeText: (str) => {
      const safe = typeof str === 'string' ? str : '';
      sanitizeArgs.push(safe);
      return `S:${safe}`;
    },
    json: (_res, status, payload) => { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  const url = new URL('http://localhost/api/reading-lists');
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await bookmarksReadingListsRoutes(req, res, url, '/api/reading-lists', ctx);
  return { captured, saved, sanitizeArgs };
}

describe('POST /api/reading-lists — trim name once into trimmedName', () => {
  it('creates a list with the trimmed, sanitized name and returns the created list', async () => {
    const { captured, saved, sanitizeArgs } = await createReadingList({ name: '  My Reading List  ' });

    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);

    const list = captured.payload.list;
    assert.ok(list, 'the created list is returned');
    // sanitizeText received the already-trimmed name (no surrounding whitespace),
    // and its tagged output is what lands on the persisted name.
    assert.equal(sanitizeArgs[0], 'My Reading List');
    assert.equal(list.name, 'S:My Reading List');
    assert.equal(typeof list.id, 'string');
    assert.deepEqual(list.items, []);
    assert.equal(typeof list.createdAt, 'string');
    assert.equal(typeof list.updatedAt, 'string');

    // The same list was persisted via saveJSON.
    assert.equal(saved.lists.length, 1);
    assert.equal(saved.lists[0], list);
  });

  it('keeps the description handling untouched (still trimmed and sanitized)', async () => {
    const { captured } = await createReadingList({ name: 'Papers', description: '  to read  ' });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.list.name, 'S:Papers');
    assert.equal(captured.payload.list.description, 'S:to read');
  });

  it('returns 400 Missing name for a missing name', async () => {
    const { captured, saved } = await createReadingList({});
    assert.deepEqual(captured, { status: 400, payload: { error: 'Missing name' } });
    assert.equal(saved, null, 'nothing is persisted on a rejected create');
  });

  it('returns 400 Missing name for a non-string name (trim is never called on it)', async () => {
    // The typeof guard short-circuits before `.trim()`, so a number name cannot throw.
    const { captured } = await createReadingList({ name: 123 });
    assert.deepEqual(captured, { status: 400, payload: { error: 'Missing name' } });
  });

  it('returns 400 Missing name for a whitespace-only name', async () => {
    const { captured } = await createReadingList({ name: '   ' });
    assert.deepEqual(captured, { status: 400, payload: { error: 'Missing name' } });
  });

  it('returns the 200-char 400 for a name longer than 200 characters', async () => {
    // A 201-char non-whitespace name clears the typeof and empty-name guards, then
    // trips the length check on the raw name.
    const { captured } = await createReadingList({ name: 'a'.repeat(201) });
    assert.deepEqual(captured, { status: 400, payload: { error: 'Name must be 200 characters or fewer' } });
  });

  it('allows a name of exactly 200 characters', async () => {
    const { captured } = await createReadingList({ name: 'a'.repeat(200) });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.list.name, `S:${'a'.repeat(200)}`);
  });

  it('source trims the name once and drops both old double-trim sites', () => {
    // Lock the refactor: the single trimmedName const is present and neither the
    // old combined guard nor the inline sanitizeText(name.trim()) survive.
    const src = readFileSync(SOURCE_PATH, 'utf8');
    assert.ok(src.includes('const trimmedName = name.trim()'), 'declares const trimmedName = name.trim()');
    assert.ok(src.includes('sanitizeText(trimmedName)'), 'uses sanitizeText(trimmedName)');
    assert.ok(!src.includes('sanitizeText(name.trim())'), 'old sanitizeText(name.trim()) is gone');
    assert.ok(!src.includes('|| !name.trim())'), 'old combined guard is gone');
  });
});
