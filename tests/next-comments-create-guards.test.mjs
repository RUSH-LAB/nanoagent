import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load the REAL route module the way the other
// server route tests do, so these cases exercise the shipped POST /api/comments
// create handler instead of a reimplementation.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// Drive the POST /api/comments create handler with a minimal mocked ctx. Every
// create guard returns before the single saveJSON, so an in-memory comments map
// plus a few recorders are enough and no real filesystem write happens. The ctx
// mirrors what server.js passes on the create path: json, rateLimit, readBody,
// loadJSON, saveJSON, sanitizeText, and COMMENTS_FILE. A fresh comments store is
// built per call (default parameters evaluate on each invocation), so no case can
// pollute another through shared mutable state. sanitizeText is the identity used
// by the sibling guard tests, so a created comment echoes its text verbatim.
async function invoke({ body = {}, comments = {}, rateLimitOk = true } = {}) {
  const pathname = '/api/comments';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saveCount = 0;
  let readBodyCount = 0;
  const ctx = {
    COMMENTS_FILE: '/tmp/comments-create-guards-test.json',
    rateLimit: () => rateLimitOk,
    readBody: async () => { readBodyCount += 1; return body; },
    loadJSON: () => comments,
    saveJSON: () => { saveCount += 1; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { captured, saveCount, readBodyCount, store: comments };
}

describe('POST /api/comments create guards (current behavior)', () => {
  it('returns 429 and never reads the body or saves when rate limited', async () => {
    const { captured, saveCount, readBodyCount } = await invoke({
      body: { page: 'docs/intro', text: 'hi' },
      rateLimitOk: false,
    });
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.error, 'Too many requests. Try again in a minute.');
    assert.equal(saveCount, 0);
    assert.equal(readBodyCount, 0);
  });

  it('returns 400 when page is omitted', async () => {
    const { captured, saveCount } = await invoke({ body: { text: 'hi' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid page');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when page is a non-string (numeric)', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 42, text: 'hi' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid page');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when page exceeds 500 characters', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'a'.repeat(501), text: 'hi' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Page must be 500 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when text is omitted', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'docs/intro' } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid text');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when text is a non-string', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'docs/intro', text: 42 } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Missing or invalid text');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when text exceeds 5000 characters', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'docs/intro', text: 'a'.repeat(5001) } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Text must be 5000 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when author is present but not a string', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'docs/intro', text: 'hi', author: 42 } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'author must be a string');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when author exceeds 100 characters', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'docs/intro', text: 'hi', author: 'a'.repeat(101) } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Author must be 100 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when parentId is present but not a string', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'docs/intro', text: 'hi', parentId: 42 } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'parentId must be a string');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when parentId exceeds 200 characters', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'docs/intro', text: 'hi', parentId: 'a'.repeat(201) } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'parentId must be 200 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when userId is present but not a string', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'docs/intro', text: 'hi', userId: 42 } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'userId must be a string');
    assert.equal(saveCount, 0);
  });

  it('returns 400 when userId exceeds 200 characters', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'docs/intro', text: 'hi', userId: 'a'.repeat(201) } });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'userId must be 200 characters or fewer');
    assert.equal(saveCount, 0);
  });

  it('creates a comment with defaults when author, parentId, and userId are omitted', async () => {
    const { captured, saveCount, store } = await invoke({ body: { page: 'docs/intro', text: 'hello' } });
    assert.equal(captured.status, 200);
    const { comment } = captured.payload;
    assert.equal(comment.author, 'Anonymous');
    assert.equal(comment.parentId, null);
    assert.equal(comment.userId, null);
    assert.equal(comment.text, 'hello');
    // id and createdAt come from the clock and the RNG; pin only presence and type.
    assert.equal(typeof comment.id, 'string');
    assert.equal(typeof comment.createdAt, 'string');
    assert.equal(saveCount, 1);
    // Lazy init: an empty comments doc gains the page bucket before the push.
    assert.equal(store['docs/intro'].length, 1);
    assert.equal(store['docs/intro'][0].text, 'hello');
  });

  it('defaults an empty-string author to Anonymous', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'docs/intro', text: 'hi', author: '' } });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.comment.author, 'Anonymous');
    assert.equal(saveCount, 1);
  });
});
