import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load the real module the way the other
// route tests do. This suite characterizes the `description` length cap in the
// POST /api/reading-lists create handler: an over-cap description is rejected with
// 400 {error: 'Description must be 5000 characters or fewer'} BEFORE the store is
// read or written, while a description at exactly the 5000-character cap clears the
// guard and creates the list. The existing reading-lists suite pins the name
// presence, trim, and 200-cap guards; this rung (the description cap) was uncovered.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

const READING_LISTS_FILE = '/fake/reading-lists.json';

// Drive the real POST /api/reading-lists handler over a mocked ctx. loadJSON is a
// counter that returns a fresh empty store; saveJSON is a tripwire counter that
// records the persisted payload. The two counters let the over-cap case prove the
// guard returns *before* any read or write. sanitizeText is identity and
// crypto.randomUUID is fixed so the created list is deterministic.
async function createReadingList(body) {
  let loadCalls = 0;
  let saveCalls = 0;
  let savedPayload = null;
  let captured = null;
  const res = { writableEnded: false };
  const ctx = {
    crypto: { randomUUID: () => 'fixed-id' },
    READING_LISTS_FILE,
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => { loadCalls++; return {}; },
    saveJSON: (_file, data) => { saveCalls++; savedPayload = data; },
    sanitizeText: (str) => str,
    json: (_res, status, payload) => { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  const url = new URL('http://localhost/api/reading-lists');
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  await bookmarksReadingListsRoutes(req, res, url, '/api/reading-lists', ctx);
  return { captured, savedPayload, loadCalls, saveCalls };
}

describe('POST /api/reading-lists — description length cap', () => {
  it('rejects a 5001-character description with 400 before reading or writing the store', async () => {
    const { captured, loadCalls, saveCalls } = await createReadingList({
      name: 'My Reading List',
      description: 'a'.repeat(5001),
    });
    // The cap guard fires on the over-length description and short-circuits with the
    // globally unique cap message.
    assert.deepEqual(captured, { status: 400, payload: { error: 'Description must be 5000 characters or fewer' } });
    // It returns before `const data = loadJSON(...)`, so neither the read nor the
    // subsequent write ever runs.
    assert.equal(loadCalls, 0, 'loadJSON is never called when the cap guard rejects');
    assert.equal(saveCalls, 0, 'saveJSON is never called when the cap guard rejects');
  });

  it('accepts a description of exactly 5000 characters and creates the list', async () => {
    const description = 'a'.repeat(5000);
    const { captured, savedPayload, loadCalls, saveCalls } = await createReadingList({
      name: 'My Reading List',
      description,
    });
    // 5000 is inclusive (`length > 5000` is false at the boundary), so the guard is
    // cleared: the status is 200 and NOT the cap message.
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    const list = captured.payload.list;
    assert.ok(list, 'the created list is returned');
    assert.equal(list.description.length, 5000, 'the 5000-character description survives onto the created list');
    assert.equal(list.description, description);
    // The boundary description passed the cap: the store is read once and the created
    // list is persisted exactly once.
    assert.equal(loadCalls, 1, 'the store is read once past the cap guard');
    assert.equal(saveCalls, 1, 'the created list is persisted exactly once');
    assert.equal(savedPayload.lists[0], list, 'the same list object is persisted');
  });
});
