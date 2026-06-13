import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// Distinct sentinel paths so the mocked loadJSON can tell the two stores apart.
const COMMENTS_FILE = 'comments.json';
const USERS_FILE = 'users.json';
const PAGE = 'docs/intro';
const COMMENT_ID = 'c1';

// An owned comment authored by "alice". Built fresh per test because the handler
// splices the store in place on a successful delete.
const ownedComment = () => ({ id: COMMENT_ID, userId: 'alice', author: 'Alice', text: 'hi' });

// Drive the real DELETE /api/comments handler over a mocked ctx. `comments` is the
// page->array store; `users` is the role map keyed by userId. The result exposes
// the captured json() response, whether saveJSON ran, the data it persisted, and
// the live store, so we can confirm the cached `pageComments` is spliced in place.
async function invokeDelete({ body, comments, users = {} }) {
  const pathname = '/api/comments';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saveCalls = 0;
  let saved = null;
  const ctx = {
    COMMENTS_FILE,
    USERS_FILE,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    readBody: async () => body,
    loadJSON: (file) => (file === USERS_FILE ? users : comments),
    saveJSON: (_file, data) => { saveCalls += 1; saved = data; },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { ...captured, saveCalls, saved, comments };
}

// These lock in that caching `comments[page]` into a local `pageComments` keeps the
// delete behavior byte-identical: the same stored array is read for findIndex/index
// and spliced in place, so the persisted store reflects the removal.
describe('DELETE /api/comments pageComments cache', () => {
  it('deletes an existing comment (200) and removes it from the stored array', async () => {
    const comments = { [PAGE]: [ownedComment()] };
    const pageArray = comments[PAGE];
    const r = await invokeDelete({
      body: { page: PAGE, commentId: COMMENT_ID, userId: 'alice' },
      comments,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { success: true });
    assert.equal(r.saveCalls, 1, 'persists the deletion');
    assert.equal(r.comments[PAGE].length, 0, 'comment removed from the stored array');
    // The cached `pageComments` must be the same array reference that gets spliced,
    // so the persisted store and the live store reflect the in-place removal.
    assert.equal(r.saved, comments, 'persists the same mutated store object');
    assert.equal(r.saved[PAGE], pageArray, 'spliced the original array in place');
  });

  it('returns 404 when the commentId is not present on the page', async () => {
    const comments = { [PAGE]: [ownedComment()] };
    const r = await invokeDelete({
      body: { page: PAGE, commentId: 'does-not-exist', userId: 'alice' },
      comments,
    });
    assert.equal(r.status, 404);
    assert.deepEqual(r.payload, { error: 'Comment not found' });
    assert.equal(r.saveCalls, 0, 'must not persist when nothing was deleted');
    assert.equal(r.comments[PAGE].length, 1, 'comment is still present');
  });

  it('rejects a non-author, non-owner user (403)', async () => {
    const comments = { [PAGE]: [ownedComment()] };
    const r = await invokeDelete({
      body: { page: PAGE, commentId: COMMENT_ID, userId: 'bob' },
      comments,
      users: { bob: { role: 'editor' } },
    });
    assert.equal(r.status, 403);
    assert.deepEqual(r.payload, { error: 'Only the comment author or an admin can delete this comment' });
    assert.equal(r.saveCalls, 0, 'must not persist when unauthorized');
    assert.equal(r.comments[PAGE].length, 1, 'comment is still present');
  });
});
