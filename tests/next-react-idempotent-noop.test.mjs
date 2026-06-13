import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load the real module the way the sibling
// server route tests do (see tests/next-react-write-ownprop-guard.test.mjs and
// tests/next-react-input-validation-guards.test.mjs), so these cases drive the
// shipped /api/comments/react handler rather than a reimplementation.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

// WHY THESE TWO BRANCHES ARE IDEMPOTENT NO-OPS
// ─────────────────────────────────────────────────────────────────────────────
// Both methods of /api/comments/react clear their guards, load the comments map,
// resolve the target comment, then check whether the requested reaction is already
// in the desired state and return 200 WITHOUT persisting:
//   • POST   returns at `if (existing)`   when the {emoji, userId} reaction is
//            ALREADY present, before the push and the saveJSON.
//   • DELETE returns at `if (idx === -1)` when the {emoji, userId} reaction is
//            ABSENT, before the splice and the saveJSON.
// On both paths the handler echoes the live `comment.reactions` array untouched and
// never calls saveJSON, so the persisted store is never written. The existing react
// suites cover only the input-validation guards, the own-property page guard, and
// the two write success paths (the new-reaction push and the existing-reaction
// splice); these two no-op returns had no assertions before.
//
// sanitizeText is identity here, so the POST lookup userId (safeUserId) equals the
// request userId, and the DELETE lookup already compares the raw request userId.

// Drive the real handler with a minimal mocked ctx and capture the response handed
// to json(res, status, payload). loadJSON returns the supplied comments map by
// reference, so `store` exposes any mutation the handler makes; saveJSON is a
// tripwire that counts persistence attempts, which must stay 0 on the no-op paths.
async function invokeReact(method, { body, comments }) {
  const pathname = '/api/comments/react';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saveCalls = 0;
  const ctx = {
    COMMENTS_FILE: 'comments.json',
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => comments,
    saveJSON: () => { saveCalls += 1; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await bookmarksReadingListsRoutes(req, res, url, pathname, ctx);
  return { captured, saveCalls, store: comments };
}

describe('comments/react idempotent no-op branches', () => {
  describe('POST /api/comments/react existing-reaction no-op', () => {
    it('returns the unchanged reactions and never saves when the reaction already exists', async () => {
      const comments = { 'docs/intro': [{ id: 'c1', reactions: [{ emoji: 'heart', userId: 'u1' }] }] };
      const { captured, saveCalls, store } = await invokeReact('POST', {
        body: { page: 'docs/intro', commentId: 'c1', emoji: 'heart', userId: 'u1' },
        comments,
      });
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.payload, { success: true, reactions: [{ emoji: 'heart', userId: 'u1' }] });
      // No duplicate appended: the stored array still holds exactly the one reaction.
      assert.deepEqual(store['docs/intro'][0].reactions, [{ emoji: 'heart', userId: 'u1' }]);
      assert.equal(store['docs/intro'][0].reactions.length, 1);
      // The no-op echoes the live array rather than building a new one.
      assert.strictEqual(captured.payload.reactions, store['docs/intro'][0].reactions);
      assert.equal(saveCalls, 0);
    });

    it('returns the full reactions list unchanged when the duplicate sits among other reactions', async () => {
      const comments = {
        'docs/intro': [{ id: 'c1', reactions: [{ emoji: 'thumbsup', userId: 'u2' }, { emoji: 'heart', userId: 'u1' }] }],
      };
      const { captured, saveCalls, store } = await invokeReact('POST', {
        body: { page: 'docs/intro', commentId: 'c1', emoji: 'heart', userId: 'u1' },
        comments,
      });
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.payload, {
        success: true,
        reactions: [{ emoji: 'thumbsup', userId: 'u2' }, { emoji: 'heart', userId: 'u1' }],
      });
      // Both reactions survive, in order: nothing pushed, nothing reordered.
      assert.deepEqual(store['docs/intro'][0].reactions, [{ emoji: 'thumbsup', userId: 'u2' }, { emoji: 'heart', userId: 'u1' }]);
      assert.equal(store['docs/intro'][0].reactions.length, 2);
      assert.equal(saveCalls, 0);
    });
  });

  describe('DELETE /api/comments/react absent-reaction no-op', () => {
    it('returns the unchanged reactions and never saves when the reaction is absent among others', async () => {
      const comments = { 'docs/intro': [{ id: 'c1', reactions: [{ emoji: 'thumbsup', userId: 'u2' }] }] };
      const { captured, saveCalls, store } = await invokeReact('DELETE', {
        body: { page: 'docs/intro', commentId: 'c1', emoji: 'heart', userId: 'u1' },
        comments,
      });
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.payload, { success: true, reactions: [{ emoji: 'thumbsup', userId: 'u2' }] });
      // The non-matching reaction is left in place: nothing spliced out.
      assert.deepEqual(store['docs/intro'][0].reactions, [{ emoji: 'thumbsup', userId: 'u2' }]);
      assert.equal(store['docs/intro'][0].reactions.length, 1);
      // The no-op echoes the live array rather than building a new one.
      assert.strictEqual(captured.payload.reactions, store['docs/intro'][0].reactions);
      assert.equal(saveCalls, 0);
    });

    it('returns 200 with the empty array and never saves when findIndex runs on an empty reactions list', async () => {
      const comments = { 'docs/intro': [{ id: 'c1', reactions: [] }] };
      const { captured, saveCalls, store } = await invokeReact('DELETE', {
        body: { page: 'docs/intro', commentId: 'c1', emoji: 'heart', userId: 'u1' },
        comments,
      });
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.payload, { success: true, reactions: [] });
      // findIndex on [] is -1, so the empty array returns untouched.
      assert.deepEqual(store['docs/intro'][0].reactions, []);
      assert.equal(saveCalls, 0);
    });
  });
});
