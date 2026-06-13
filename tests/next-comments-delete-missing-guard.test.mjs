import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// Sentinel path; if a stray loadJSON/saveJSON ever fired it would be visibly
// mis-routed here, but on this guard's path neither is reached at all.
const COMMENTS_FILE = 'comments.json';
const PAGE = 'docs/intro';
const COMMENT_ID = 'c1';

// Drive the real DELETE /api/comments handler over a mocked ctx whose loadJSON and
// saveJSON are tripwire counters. The handler's first guard,
//   if (!page || !commentId) return json(res, 400, {error: 'Missing page or commentId'});
// returns BEFORE `const comments = loadJSON(COMMENTS_FILE)`, so on every reject case
// below both counters must stay at 0. The result exposes the captured json()
// response plus the two call counts.
async function invokeDelete(body) {
  const pathname = '/api/comments';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  const ctx = {
    COMMENTS_FILE,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    readBody: async () => body,
    // Counters that also return a benign empty store, so that if the guard ever
    // regressed and execution fell through, the test would still observe a non-zero
    // count rather than crashing on `undefined`.
    loadJSON: () => { loadCalls += 1; return {}; },
    saveJSON: () => { saveCalls += 1; },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { ...captured, loadCalls, saveCalls };
}

// Every case asserts the same contract: DELETE /api/comments with a missing/falsy
// page or commentId short-circuits to 400 {error: 'Missing page or commentId'}
// without ever touching the comments store.
function assertMissingGuard(r) {
  assert.equal(r.status, 400);
  assert.deepEqual(r.payload, { error: 'Missing page or commentId' });
  assert.equal(r.loadCalls, 0, 'must not read the comments store on the reject path');
  assert.equal(r.saveCalls, 0, 'must not persist on the reject path');
}

describe('DELETE /api/comments missing page-or-commentId guard', () => {
  it('rejects a body missing page (only commentId present) with 400 before the store read', async () => {
    const r = await invokeDelete({ commentId: COMMENT_ID });
    assertMissingGuard(r);
  });

  it('rejects a body missing commentId (only page present) with 400 before the store read', async () => {
    const r = await invokeDelete({ page: PAGE });
    assertMissingGuard(r);
  });

  it('rejects a body with both page and commentId absent with 400', async () => {
    const r = await invokeDelete({ userId: 'alice' });
    assertMissingGuard(r);
  });

  it('rejects an empty-string page (falsy short-circuit) with 400', async () => {
    const r = await invokeDelete({ page: '', commentId: COMMENT_ID });
    assertMissingGuard(r);
  });

  it('rejects an empty-string commentId (falsy short-circuit) with 400', async () => {
    const r = await invokeDelete({ page: PAGE, commentId: '' });
    assertMissingGuard(r);
  });
});
