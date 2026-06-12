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

// Invoke the GET /api/comments handler directly, stubbing only the ctx fields
// the list path touches (json, loadJSON, COMMENTS_FILE). Returns the captured
// json() response.
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

// Each negative-limit case below is chosen so the PRE-FIX handler
// (`Math.min(intParam('limit', 100), 500)`, no lower clamp) would have returned
// a NON-empty, wrong page through `slice(offset, offset + negativeLimit)`. With
// the lower clamp the limit floors to 0, so the page is empty while `total`
// still reports the full count. That makes every case a real regression guard
// rather than a tautology that passes against the buggy code too.
describe('comments pagination negative-limit clamp', () => {
  it('clamps limit=-1 to 0 instead of dropping the last comment off the end', async () => {
    const data = makeComments(5);
    const res = await listComments('&limit=-1', data);
    // Pre-fix: slice(0, -1) returned [c0..c3] (the last comment dropped).
    // Post-fix: slice(0, 0) returns an empty page.
    assert.equal(res.status, 200);
    assert.equal(res.body.comments.length, 0);
    assert.equal(res.body.total, 5);
  });

  it('clamps a more negative limit that would have dropped several off the end', async () => {
    const data = makeComments(12);
    const res = await listComments('&limit=-5', data);
    // Pre-fix: slice(0, -5) returned the first 7 comments; post-fix it is empty.
    assert.deepEqual(res.body.comments, []);
    assert.equal(res.body.total, 12);
  });

  it('clamps a negative limit combined with an offset (no slice wraparound)', async () => {
    const data = makeComments(10);
    const res = await listComments('&limit=-2&offset=1', data);
    // Pre-fix: slice(1, -1) wrapped the negative end index and over-returned
    // [c1..c8]; post-fix slice(1, 1) is empty.
    assert.equal(res.body.comments.length, 0);
    assert.equal(res.body.total, 10);
  });

  it('leaves a valid positive limit and offset unchanged', async () => {
    const res = await listComments('&limit=2&offset=1', makeComments(5));
    assert.deepEqual(res.body.comments.map(c => c.id), ['c1', 'c2']);
    assert.equal(res.body.total, 5);
  });

  it('leaves the default (absent) limit unchanged', async () => {
    const res = await listComments('', makeComments(5));
    assert.deepEqual(res.body.comments.map(c => c.id), ['c0', 'c1', 'c2', 'c3', 'c4']);
    assert.equal(res.body.total, 5);
  });
});
