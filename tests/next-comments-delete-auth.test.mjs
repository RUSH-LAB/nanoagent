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

// Drive the real DELETE /api/comments handler over a mocked ctx. `comment` is the
// single stored comment under PAGE; `users` is the role map keyed by userId. The
// result exposes the captured json() response plus whether saveJSON ran, since an
// authorized delete must persist and a rejected request must not write.
async function invokeDelete({ body, comment, users = {} }) {
  const pathname = '/api/comments';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const store = { [PAGE]: [comment] };
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
    loadJSON: (file) => (file === USERS_FILE ? users : store),
    saveJSON: (_file, data) => { saveCalls += 1; saved = data; },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { ...captured, saveCalls, saved, store };
}

describe('DELETE /api/comments authorization', () => {
  it('rejects deletion of an owned comment when userId is omitted (the bypass)', async () => {
    // Before the fix this request slipped past the guard and deleted the comment;
    // anyone could remove any owned comment simply by sending no userId.
    const r = await invokeDelete({
      body: { page: PAGE, commentId: COMMENT_ID },
      comment: ownedComment(),
      users: {},
    });
    assert.equal(r.status, 403);
    assert.deepEqual(r.payload, { error: 'Only the comment author or an admin can delete this comment' });
    assert.equal(r.saveCalls, 0, 'must not persist when unauthorized');
    assert.equal(r.store[PAGE].length, 1, 'comment is still present');
  });

  it('lets the author delete their own comment (200)', async () => {
    const r = await invokeDelete({
      body: { page: PAGE, commentId: COMMENT_ID, userId: 'alice' },
      comment: ownedComment(),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { success: true });
    assert.equal(r.saveCalls, 1, 'persists the deletion');
    assert.equal(r.store[PAGE].length, 0, 'comment removed');
  });

  it('rejects a non-author, non-owner user (403)', async () => {
    const r = await invokeDelete({
      body: { page: PAGE, commentId: COMMENT_ID, userId: 'bob' },
      comment: ownedComment(),
      users: { bob: { role: 'editor' } },
    });
    assert.equal(r.status, 403);
    assert.deepEqual(r.payload, { error: 'Only the comment author or an admin can delete this comment' });
    assert.equal(r.saveCalls, 0, 'must not persist when unauthorized');
    assert.equal(r.store[PAGE].length, 1, 'comment is still present');
  });

  it('lets an owner-role user delete a comment they do not own (200)', async () => {
    const r = await invokeDelete({
      body: { page: PAGE, commentId: COMMENT_ID, userId: 'carol' },
      comment: ownedComment(),
      users: { carol: { role: 'owner' } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { success: true });
    assert.equal(r.saveCalls, 1, 'persists the deletion');
    assert.equal(r.store[PAGE].length, 0, 'comment removed');
  });

  it('still freely deletes an unowned comment with no userId (no over-rejection)', async () => {
    const r = await invokeDelete({
      body: { page: PAGE, commentId: COMMENT_ID },
      comment: { id: COMMENT_ID, userId: null, author: 'Anonymous', text: 'hi' },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { success: true });
    assert.equal(r.saveCalls, 1, 'persists the deletion');
    assert.equal(r.store[PAGE].length, 0, 'comment removed');
  });
});
