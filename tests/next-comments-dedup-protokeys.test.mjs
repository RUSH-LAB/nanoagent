import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// The three dangerous keys the shared PROTO_KEYS guard must reject at every
// write handler. Hoisting the list into one frozen const must not change which
// keys are blocked, so the table is asserted in full at each call site.
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

// Invoke a comments-notes route handler with a minimal mocked ctx and capture
// the response handed to json(res, status, payload). readBody returns the test
// body verbatim; rateLimit allows the request so POST reaches its validators.
async function invoke({ method, pathname, body, ctx = {} }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    readBody: async () => body,
    rateLimit: () => true,
    ...ctx,
  };
  await commentsNotesRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('POST /api/comments proto-key guard', () => {
  for (const page of DANGEROUS_KEYS) {
    it(`rejects a dangerous page "${page}" with 400 Invalid page`, async () => {
      // A valid text is supplied so the request clears the earlier validators
      // and the proto-key guard is what produces the rejection.
      const r = await invoke({
        method: 'POST',
        pathname: '/api/comments',
        body: { page, text: 'hello' },
      });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: 'Invalid page' });
    });
  }

  it('still accepts a normal page (the guard does not over-reject)', async () => {
    let saved = null;
    const r = await invoke({
      method: 'POST',
      pathname: '/api/comments',
      body: { page: 'docs/intro', text: 'hello' },
      ctx: {
        COMMENTS_FILE: 'comments.json',
        loadJSON: () => ({}),
        saveJSON: (_file, data) => { saved = data; },
        sanitizeText: (s) => s,
      },
    });
    assert.equal(r.status, 200);
    assert.ok(r.payload.comment, 'returns the created comment');
    assert.ok(saved && Array.isArray(saved['docs/intro']), 'persists under the page key');
  });
});

describe('PUT /api/notes proto-key guard', () => {
  for (const key of DANGEROUS_KEYS) {
    it(`rejects a dangerous key "${key}" with 400 Invalid key`, async () => {
      // A valid content string clears the earlier validators so the proto-key
      // guard is what rejects the request.
      const r = await invoke({
        method: 'PUT',
        pathname: '/api/notes',
        body: { key, content: 'hi' },
      });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: 'Invalid key' });
    });
  }

  it('still accepts a normal key (the guard does not over-reject)', async () => {
    let saved = null;
    const r = await invoke({
      method: 'PUT',
      pathname: '/api/notes',
      body: { key: 'my-note', content: 'hi', title: 'Title' },
      ctx: {
        NOTES_FILE: 'notes.json',
        loadJSON: () => ({}),
        saveJSON: (_file, data) => { saved = data; },
        sanitizeText: (s) => s,
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { success: true });
    assert.ok(saved && saved['my-note'], 'persists under the note key');
  });
});

describe('DELETE /api/notes proto-key guard', () => {
  for (const key of DANGEROUS_KEYS) {
    it(`rejects a dangerous key "${key}" with 400 Invalid key`, async () => {
      const r = await invoke({
        method: 'DELETE',
        pathname: '/api/notes',
        body: { key },
      });
      assert.equal(r.status, 400);
      assert.deepEqual(r.payload, { error: 'Invalid key' });
    });
  }

  it('still deletes a normal key (the guard does not over-reject)', async () => {
    let saved = null;
    const r = await invoke({
      method: 'DELETE',
      pathname: '/api/notes',
      body: { key: 'my-note' },
      ctx: {
        NOTES_FILE: 'notes.json',
        loadJSON: () => ({ 'my-note': { content: 'x' } }),
        saveJSON: (_file, data) => { saved = data; },
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { success: true });
    assert.ok(saved && !('my-note' in saved), 'removes the note key');
  });
});
