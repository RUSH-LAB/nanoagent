import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// comments-notes.js is CommonJS; load it the way the other server tests do.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// Build `n` comments with predictable ids (c0, c1, ...) so a slice is easy to
// assert against.
function makeComments(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, text: `comment ${i}` }));
}

// Invoke the GET /api/comments handler directly. Only the fields the handler
// touches on that path are stubbed (json, loadJSON, COMMENTS_FILE); the rest of
// `ctx` is irrelevant to pagination. Returns the captured json() response.
async function listComments(query, commentsForPage) {
  let captured = null;
  const ctx = {
    COMMENTS_FILE: 'comments.json',
    loadJSON: () => ({ p: commentsForPage }),
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/comments?page=p${query}`);
  await commentsNotesRoutes({ method: 'GET' }, {}, url, '/api/comments', ctx);
  return captured;
}

describe('comments pagination NaN guard', () => {
  it('serves the default page when no limit/offset is given', async () => {
    const res = await listComments('', makeComments(5));
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 5);
    assert.deepEqual(res.body.comments.map(c => c.id), ['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('falls back to the default page for a non-numeric limit and offset', async () => {
    const data = makeComments(5);
    const baseline = await listComments('', data);
    const nonNumeric = await listComments('&limit=abc&offset=xyz', data);
    // Before the guard, NaN propagated into slice() and returned an empty page.
    assert.deepEqual(nonNumeric.body, baseline.body);
    assert.equal(nonNumeric.body.comments.length, 5);
  });

  it('falls back independently when only the limit is non-numeric', async () => {
    const data = makeComments(5);
    const res = await listComments('&limit=notanumber', data);
    assert.deepEqual(res.body.comments.map(c => c.id), ['c0', 'c1', 'c2', 'c3', 'c4']);
    assert.equal(res.body.total, 5);
  });

  it('falls back independently when only the offset is non-numeric', async () => {
    const data = makeComments(5);
    const res = await listComments('&offset=notanumber', data);
    assert.deepEqual(res.body.comments.map(c => c.id), ['c0', 'c1', 'c2', 'c3', 'c4']);
    assert.equal(res.body.total, 5);
  });

  it('applies the default limit of 100 (not unbounded) on a non-numeric limit', async () => {
    const res = await listComments('&limit=abc', makeComments(120));
    assert.equal(res.body.comments.length, 100);
    assert.equal(res.body.comments[0].id, 'c0');
    assert.equal(res.body.comments[99].id, 'c99');
    assert.equal(res.body.total, 120);
  });

  it('honors valid numeric limit and offset unchanged', async () => {
    const res = await listComments('&limit=2&offset=1', makeComments(5));
    assert.deepEqual(res.body.comments.map(c => c.id), ['c1', 'c2']);
    assert.equal(res.body.total, 5);
  });

  it('preserves parseInt semantics for a numeric prefix (e.g. "2abc")', async () => {
    const res = await listComments('&limit=2abc&offset=1xyz', makeComments(5));
    assert.deepEqual(res.body.comments.map(c => c.id), ['c1', 'c2']);
  });

  it('keeps the existing upper clamp of 500 for large valid limits', async () => {
    const res = await listComments('&limit=600', makeComments(600));
    assert.equal(res.body.comments.length, 500);
    assert.equal(res.body.total, 600);
  });

  it('keeps clamping a negative offset to 0 (numeric, so unchanged)', async () => {
    const data = makeComments(5);
    const res = await listComments('&offset=-5', data);
    assert.deepEqual(res.body.comments.map(c => c.id), ['c0', 'c1', 'c2', 'c3', 'c4']);
  });
});
