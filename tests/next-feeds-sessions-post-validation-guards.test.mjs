import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load the REAL route module the way the sibling server
// route tests do. This pins the POST /api/sessions input-validation guards: the
// six 400 branches that run before the success path persists a session. The
// sibling tests/next-feeds-write-ownprop-guard.test.mjs drives the same handler
// but asserts only the own-property / PROTO_KEYS behavior, so these field
// validation branches have zero direct assertions today.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

// Drive POST /api/sessions with a mocked ctx and capture the response handed to
// json(res, status, payload). readBody resolves to the supplied body; loadJSON
// returns the supplied store verbatim; saveJSON records whether the success path
// persisted anything; sanitizeText is identity so the success path stays
// deterministic for the fields we assert. Each rejection guard returns before
// loadJSON or saveJSON runs, so a rejected request never touches the store and
// never reaches a clock, randomness, or the filesystem.
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
    PROJECT_ROOT: '/tmp/next-feeds-sessions-post-validation-test',
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

// A valid ISO startTime so every guard after the userId check is reachable.
const VALID_START = '2024-01-01T00:00:00.000Z';

describe('POST /api/sessions input-validation guards', () => {
  // Guard 1: userId falsy. An empty body leaves userId undefined.
  it('rejects a missing userId with 400 and persists nothing', async () => {
    const { captured, saveCalls } = await invokePost({ body: {} });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid userId' });
    assert.equal(saveCalls, 0);
  });

  // Guard 1: userId present but the wrong type.
  it('rejects a non-string userId with 400 and persists nothing', async () => {
    const { captured, saveCalls } = await invokePost({ body: { userId: 123, startTime: VALID_START } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid userId' });
    assert.equal(saveCalls, 0);
  });

  // Guard 2: startTime falsy. A valid string userId clears guard 1 first.
  it('rejects a missing startTime with 400 and persists nothing', async () => {
    const { captured, saveCalls } = await invokePost({ body: { userId: 'alice' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid startTime' });
    assert.equal(saveCalls, 0);
  });

  // Guard 2: startTime present but the wrong type.
  it('rejects a non-string startTime with 400 and persists nothing', async () => {
    const { captured, saveCalls } = await invokePost({ body: { userId: 'alice', startTime: 123 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid startTime' });
    assert.equal(saveCalls, 0);
  });

  // Guard 4: endTime present but not a string (guard 3, the PROTO_KEYS check on
  // userId, is exercised by the sibling own-property test and stays untouched).
  it('rejects a non-string endTime with 400 and persists nothing', async () => {
    const { captured, saveCalls } = await invokePost({ body: { userId: 'alice', startTime: VALID_START, endTime: 123 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'endTime must be a string' });
    assert.equal(saveCalls, 0);
  });

  // Guard 5: wordsWritten present but not a number.
  it('rejects a non-number wordsWritten with 400 and persists nothing', async () => {
    const { captured, saveCalls } = await invokePost({ body: { userId: 'alice', startTime: VALID_START, wordsWritten: 'lots' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'wordsWritten must be a number' });
    assert.equal(saveCalls, 0);
  });

  // Guard 6: filesEdited present but not an array.
  it('rejects a non-array filesEdited with 400 and persists nothing', async () => {
    const { captured, saveCalls } = await invokePost({ body: { userId: 'alice', startTime: VALID_START, filesEdited: 'nope' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'filesEdited must be an array' });
    assert.equal(saveCalls, 0);
  });

  // Guard 7: filesEdited is an array but longer than the 100-entry cap.
  it('rejects a filesEdited array longer than 100 with 400 and persists nothing', async () => {
    const filesEdited = Array.from({ length: 101 }, (_entry, i) => `file-${i}.md`);
    const { captured, saveCalls } = await invokePost({ body: { userId: 'alice', startTime: VALID_START, filesEdited } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'filesEdited exceeds maximum length of 100' });
    assert.equal(saveCalls, 0);
  });

  // Happy-path control: a valid body with every optional field present clears
  // all guards, reaches the success path, and persists exactly one session.
  it('accepts a valid body with every optional field present (200) and persists one session', async () => {
    const body = {
      userId: 'alice',
      startTime: VALID_START,
      endTime: '2024-01-01T01:00:00.000Z',
      wordsWritten: 500,
      filesEdited: ['a.md', 'b.md', 'c.md'],
    };
    const { captured, saveCalls, store } = await invokePost({ body });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.ok(captured.payload.session);
    assert.equal(saveCalls, 1);
    // The success path created one own-key array for the user and appended the
    // built session, so the persisted store mirrors the returned session.
    assert.equal(store['alice'].length, 1);
    assert.equal(store['alice'][0].id, captured.payload.session.id);
    // Optional fields flow through unchanged (sanitizeText is identity here),
    // and duration is the whole-minute gap between startTime and endTime.
    assert.equal(captured.payload.session.startTime, VALID_START);
    assert.equal(captured.payload.session.endTime, '2024-01-01T01:00:00.000Z');
    assert.equal(captured.payload.session.wordsWritten, 500);
    assert.deepEqual(captured.payload.session.filesEdited, ['a.md', 'b.md', 'c.md']);
    assert.equal(captured.payload.session.duration, 60);
  });
});
