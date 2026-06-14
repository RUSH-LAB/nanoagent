import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load the REAL module via createRequire,
// the way the sibling badbody test (tests/next-bookmarks-crud-guards.test.mjs)
// does, so these cases exercise the shipped DELETE /api/bookmarks handler rather
// than a reimplementation. This is an ADD-ONLY characterization test: it pins the
// current, correct behavior of the DELETE outer catch so a future refactor cannot
// silently change it. It edits no source.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

const BOOKMARKS_FILE = '/fake/data/bookmarks.json';

// Drive the real DELETE /api/bookmarks handler over a minimal mocked ctx aimed at
// its pre-IO bad-body path. The handler reads the body FIRST inside its try
// (`const body = await readBody(req)`), then runs `const {path: pagePath} = body;`.
// Any throw raised BEFORE the first store read (`loadJSON(BOOKMARKS_FILE)`) lands
// in the fixed `catch { return json(res, 400, {error: 'Invalid request'}); }`.
//
// loadJSON and saveJSON are 0-call TRIPWIRES: each bumps a counter AND throws on
// contact. The returned body alone cannot prove the short-circuit, because a
// tripwire throw is itself swallowed by the same outer catch and would still
// surface the golden 400; so the call COUNT (=== 0), not the body, is the
// never-reached proof of zero store IO.
//
// rateLimit is recorded but never expected to fire: unlike POST /api/bookmarks,
// this DELETE handler has NO rate-limit gate, so rateLimitCalls must stay empty.
async function invokeDelete({ readBodyResult, readBodyThrows = false }) {
  let loadJSONCount = 0;
  let saveJSONCount = 0;
  let readBodyCount = 0;
  const rateLimitCalls = [];
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return true; },
    readBody: async () => {
      readBodyCount += 1;
      if (readBodyThrows) throw new Error('bad body');
      return readBodyResult;
    },
    loadJSON: () => {
      loadJSONCount += 1;
      throw new Error('tripwire: loadJSON must not run on the bad-body path');
    },
    saveJSON: () => {
      saveJSONCount += 1;
      throw new Error('tripwire: saveJSON must not run on the bad-body path');
    },
    json: (_res, status, b) => { captured = { status, body: b }; },
    BOOKMARKS_FILE,
  };
  const pathname = '/api/bookmarks';
  const url = new URL('http://localhost' + pathname);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await bookmarksReadingListsRoutes(req, res, url, pathname, ctx);
  return { captured, loadJSONCount, saveJSONCount, readBodyCount, rateLimitCalls };
}

describe('DELETE /api/bookmarks outer-catch bad body (characterization)', () => {
  it('returns the fixed 400 Invalid request when readBody rejects, before any store IO', async () => {
    const r = await invokeDelete({ readBodyThrows: true });
    assert.deepEqual(r.captured, { status: 400, body: { error: 'Invalid request' } });
    // The throw originates in the body read, so readBody ran exactly once.
    assert.equal(r.readBodyCount, 1);
    // The short-circuit precedes every store touch: the tripwires never fire.
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saveJSONCount, 0);
    // The DELETE handler has no rate-limit gate, so rateLimit is never consulted.
    assert.equal(r.rateLimitCalls.length, 0);
  });

  it('returns the fixed 400 Invalid request when readBody resolves null, the null destructure throwing past the Missing path guard', async () => {
    const r = await invokeDelete({ readBodyResult: null });
    // `const {path: pagePath} = null` throws a TypeError that the outer catch
    // converts to the fixed 400.
    assert.deepEqual(r.captured, { status: 400, body: { error: 'Invalid request' } });
    // PRECEDENCE: the outer catch beats the first inner guard, so a null body
    // surfaces 'Invalid request', NOT the '{error: "Missing path"}' that a plain
    // `body && body.path` falsy check would have produced.
    assert.notDeepEqual(r.captured.body, { error: 'Missing path' });
    // readBody resolved once (returning null); the throw is the destructure of
    // that null, not the read itself.
    assert.equal(r.readBodyCount, 1);
    // Still zero store IO: the destructure throws before loadJSON or saveJSON.
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saveJSONCount, 0);
    assert.equal(r.rateLimitCalls.length, 0);
  });
});
