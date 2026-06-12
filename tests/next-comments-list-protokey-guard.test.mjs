import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// Invoke GET /api/comments with a minimal mocked ctx and capture the response
// handed to json(res, status, payload). loadJSON returns the supplied comments
// map verbatim: a plain object literal, so inherited keys like constructor and
// toString resolve to truthy values exactly as they would on the real loadJSON
// result. The read path never writes, so saveJSON is unneeded.
async function invokeList({ page, limit, offset, comments }) {
  const pathname = '/api/comments';
  const params = new URLSearchParams();
  if (page !== undefined) params.set('page', page);
  if (limit !== undefined) params.set('limit', String(limit));
  if (offset !== undefined) params.set('offset', String(offset));
  const qs = params.toString();
  const url = new URL(`http://localhost${pathname}${qs ? `?${qs}` : ''}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    COMMENTS_FILE: 'comments.json',
    loadJSON: () => comments,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return captured;
}

const COMMENTS = {
  'guide/intro': [
    { id: 'c1', text: 'first' },
    { id: 'c2', text: 'second' },
    { id: 'c3', text: 'third' },
  ],
};

describe('GET /api/comments own-property page guard', () => {
  // constructor and toString resolve to truthy inherited values on a plain
  // object, so without the Object.hasOwn guard `all` would be a function and
  // `all.slice` would throw an unhandled TypeError, hanging the request.
  for (const page of ['__proto__', 'constructor', 'toString']) {
    it(`returns the empty default for the inherited key "${page}"`, async () => {
      const r = await invokeList({ page, comments: COMMENTS });
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload, { comments: [], total: 0 });
    });
  }

  it('returns the comments and total for a real own-key page', async () => {
    const r = await invokeList({ page: 'guide/intro', comments: COMMENTS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { comments: COMMENTS['guide/intro'], total: 3 });
  });

  it('applies limit and offset on a real page without changing total', async () => {
    const r = await invokeList({ page: 'guide/intro', limit: 1, offset: 1, comments: COMMENTS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { comments: [{ id: 'c2', text: 'second' }], total: 3 });
  });

  it('returns the empty default for an absent ordinary page', async () => {
    const r = await invokeList({ page: 'no/such/page', comments: COMMENTS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { comments: [], total: 0 });
  });

  it('returns 400 when page is missing', async () => {
    const r = await invokeList({ comments: COMMENTS });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Missing page param' });
  });
});
