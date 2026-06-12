import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load it the way the other server
// route tests do.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

// Invoke a /api/comments/react request with a minimal mocked ctx and capture the
// response handed to json(res, status, payload). loadJSON returns the supplied
// comments map verbatim, so an inherited key like `toString` resolves to a truthy
// inherited function exactly as it would on the real loadJSON result. We
// deliberately do NOT inject Object into ctx, so the handler exercises the real
// global Object.hasOwn.
async function invokeReact(method, { body, comments = {} }) {
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

// An inherited Object.prototype member resolves to a truthy value on a plain
// object, so the old `if (!comments[page])` guard was skipped and the following
// `comments[page].find(...)` threw a TypeError that the try/catch turned into a
// misleading 400 "Invalid request". With Object.hasOwn the handler now returns a
// clean 404 "Page not found" and persists nothing.
describe('POST /api/comments/react own-property page guard', () => {
  for (const page of ['toString', 'valueOf', 'hasOwnProperty']) {
    it(`returns 404 for the inherited key "${page}" on an absent page`, async () => {
      const { captured, saveCalls } = await invokeReact('POST', {
        body: { page, commentId: 'c1', emoji: 'heart', userId: 'u1' },
        comments: {},
      });
      assert.equal(captured.status, 404);
      assert.deepEqual(captured.payload, { error: 'Page not found' });
      assert.equal(saveCalls, 0);
    });
  }

  it('adds a reaction on a real page', async () => {
    const comments = { 'docs/intro': [{ id: 'c1', reactions: [] }] };
    const { captured, store, saveCalls } = await invokeReact('POST', {
      body: { page: 'docs/intro', commentId: 'c1', emoji: 'heart', userId: 'u1' },
      comments,
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.deepEqual(captured.payload.reactions, [{ emoji: 'heart', userId: 'u1' }]);
    assert.equal(saveCalls, 1);
    assert.deepEqual(store['docs/intro'][0].reactions, [{ emoji: 'heart', userId: 'u1' }]);
  });
});

describe('DELETE /api/comments/react own-property page guard', () => {
  for (const page of ['toString', 'valueOf', 'hasOwnProperty']) {
    it(`returns 404 for the inherited key "${page}" on an absent page`, async () => {
      const { captured, saveCalls } = await invokeReact('DELETE', {
        body: { page, commentId: 'c1', emoji: 'heart', userId: 'u1' },
        comments: {},
      });
      assert.equal(captured.status, 404);
      assert.deepEqual(captured.payload, { error: 'Page not found' });
      assert.equal(saveCalls, 0);
    });
  }

  it('removes a reaction on a real page', async () => {
    const comments = {
      'docs/intro': [{ id: 'c1', reactions: [{ emoji: 'heart', userId: 'u1' }] }],
    };
    const { captured, store, saveCalls } = await invokeReact('DELETE', {
      body: { page: 'docs/intro', commentId: 'c1', emoji: 'heart', userId: 'u1' },
      comments,
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.deepEqual(captured.payload.reactions, []);
    assert.equal(saveCalls, 1);
    assert.deepEqual(store['docs/intro'][0].reactions, []);
  });
});
