import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// Invoke POST /api/comments with a minimal mocked ctx and capture the response
// handed to json(res, status, payload). loadJSON returns the supplied comments
// map verbatim, so inherited keys like toString resolve to truthy values exactly
// as they would on the real loadJSON result. We deliberately do NOT inject Object
// into ctx, so the handler exercises the real global Object.hasOwn.
async function invokePost({ body, comments = {} }) {
  const pathname = '/api/comments';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
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
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { captured, saveCalls, store: comments };
}

// Invoke DELETE /api/comments with the same style of mocked ctx.
async function invokeDelete({ body, comments = {} }) {
  const pathname = '/api/comments';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saveCalls = 0;
  const ctx = {
    COMMENTS_FILE: 'comments.json',
    USERS_FILE: 'users.json',
    readBody: async () => body,
    loadJSON: () => comments,
    saveJSON: () => { saveCalls += 1; },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { captured, saveCalls, store: comments };
}

describe('POST /api/comments own-property page guard', () => {
  // Inherited Object.prototype members resolve to truthy values on a plain
  // object, so the old `if (!comments[page])` guard skipped array creation and
  // the following `.push` threw a TypeError that surfaced as a misleading 400.
  // With Object.hasOwn the handler now creates a fresh own array and succeeds.
  for (const page of ['toString', 'valueOf', 'hasOwnProperty']) {
    it(`creates a comment under the inherited key "${page}"`, async () => {
      const { captured, store, saveCalls } = await invokePost({ body: { page, text: 'hi' } });
      assert.equal(captured.status, 200);
      assert.equal(captured.payload.comment.text, 'hi');
      assert.equal(saveCalls, 1);
      assert.ok(Object.hasOwn(store, page));
      assert.equal(store[page].length, 1);
      assert.equal(store[page][0].text, 'hi');
    });
  }

  // The PROTO_KEYS denylist still rejects the true pollution keys with a 400
  // before the own-property guard is reached, and nothing is persisted.
  for (const page of ['__proto__', 'constructor', 'prototype']) {
    it(`rejects the pollution key "${page}" with 400`, async () => {
      const { captured, saveCalls } = await invokePost({ body: { page, text: 'hi' } });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Invalid page' });
      assert.equal(saveCalls, 0);
    });
  }

  it('creates a comment under a normal page', async () => {
    const { captured, store, saveCalls } = await invokePost({ body: { page: 'docs/intro', text: 'hello' } });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.comment.text, 'hello');
    assert.equal(saveCalls, 1);
    assert.equal(store['docs/intro'].length, 1);
    assert.equal(store['docs/intro'][0].text, 'hello');
  });
});

describe('DELETE /api/comments own-property page guard', () => {
  // For an absent page whose name is an inherited member, the old guard fell
  // through to `.findIndex` on a function and threw; the own-property guard now
  // returns a clean 404 without persisting anything.
  for (const page of ['toString', 'valueOf']) {
    it(`returns 404 for the inherited key "${page}" on an absent page`, async () => {
      const { captured, saveCalls } = await invokeDelete({ body: { page, commentId: 'c1' }, comments: {} });
      assert.equal(captured.status, 404);
      assert.deepEqual(captured.payload, { error: 'Page not found' });
      assert.equal(saveCalls, 0);
    });
  }

  it('deletes a comment that lives on a normal page', async () => {
    const comments = { 'docs/intro': [{ id: 'c1', text: 'a', userId: null }] };
    const { captured, store, saveCalls } = await invokeDelete({ body: { page: 'docs/intro', commentId: 'c1' }, comments });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCalls, 1);
    assert.equal(store['docs/intro'].length, 0);
  });
});
