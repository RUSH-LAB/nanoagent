import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load the real module the way the
// sibling server route tests do (see tests/next-react-write-ownprop-guard.test.mjs
// and tests/next-glossary-create-guards.test.mjs), so these cases drive the
// shipped POST /api/comments/react handler rather than a reimplementation.
const require = createRequire(import.meta.url);
const bookmarksReadingListsRoutes = require('../server/routes/bookmarks-reading-lists.js');

// WHY EVERY BRANCH PINNED HERE IS DETERMINISTIC
// ──────────────────────────────────────────────────────────────────────────
// POST /api/comments/react runs a rate-limit check and then five input guards
// before it ever calls loadJSON(COMMENTS_FILE). The 429 throttle returns before
// readBody is even called, and each 400 guard returns before loadJSON and before
// any saveJSON, sanitizeText, or success-path work. So no branch pinned here
// touches the clock, randomness, the network, or the filesystem. The 404 page
// and comment paths and the 200 success path are already covered by
// tests/next-react-write-ownprop-guard.test.mjs, so this file fills only the 429
// throttle and the five 400 validation branches, which had no assertions before.

// Drive the real handler with a minimal mocked ctx and capture the response
// handed to json(res, status, payload). loadJSON, saveJSON, and readBody each
// count their calls so a rejected request can assert it never read the body (on
// the 429 path) and never read or persisted the store (on every reject). The
// rateLimitOk knob toggles the throttle, the same pattern
// tests/next-glossary-create-guards.test.mjs uses. sanitizeText is identity,
// though no rejected branch reaches it.
async function invokeReact({ body, rateLimitOk = true }) {
  const pathname = '/api/comments/react';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  let readBodyCalls = 0;
  const ctx = {
    COMMENTS_FILE: '/tmp/react-input-validation-guards.json',
    rateLimit: () => rateLimitOk,
    readBody: async () => { readBodyCalls += 1; return body; },
    loadJSON: () => { loadCalls += 1; return {}; },
    saveJSON: () => { saveCalls += 1; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await bookmarksReadingListsRoutes(req, res, url, pathname, ctx);
  return { captured, loadCalls, saveCalls, readBodyCalls };
}

// A body whose four fields all pass every guard. Each case below clones this and
// overrides exactly the one field under test, so the asserted guard is
// unambiguously the one that trips.
const VALID = { page: 'docs/intro', commentId: 'c1', emoji: 'heart', userId: 'u1' };

describe('POST /api/comments/react input-validation guards (429 throttle and the five 400 guards)', () => {
  it('a rate-limited POST returns 429 before the body is read and never touches the store', async () => {
    // The throttle returns before readBody, so even an otherwise valid body is
    // rejected without the body being read or the store touched.
    const { captured, loadCalls, saveCalls, readBodyCalls } = await invokeReact({
      rateLimitOk: false,
      body: { ...VALID },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(readBodyCalls, 0);
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('an omitted page, commentId, emoji, or userId returns 400 (Missing ...) and never touches the store', async () => {
    // `!page || !commentId || !emoji || !userId` rejects an absent field; the
    // other three stay valid so the missing one is unambiguously what trips.
    for (const field of ['page', 'commentId', 'emoji', 'userId']) {
      const body = { ...VALID };
      delete body[field];
      const { captured, loadCalls, saveCalls } = await invokeReact({ body });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Missing page, commentId, emoji, or userId' });
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    }
  });

  it('an empty-string page, commentId, emoji, or userId returns 400 (Missing ...) and never touches the store', async () => {
    // An empty string is falsy, so the same presence guard rejects it.
    for (const field of ['page', 'commentId', 'emoji', 'userId']) {
      const { captured, loadCalls, saveCalls } = await invokeReact({
        body: { ...VALID, [field]: '' },
      });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Missing page, commentId, emoji, or userId' });
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    }
  });

  it('a non-string page returns 400 (page must be a string of 500 characters or fewer) and never touches the store', async () => {
    // Each value is truthy (so it clears the presence guard) but not a string,
    // so `typeof page !== 'string'` trips before the length check is reached.
    for (const page of [42, true, { k: 'v' }, ['x']]) {
      const { captured, loadCalls, saveCalls } = await invokeReact({ body: { ...VALID, page } });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'page must be a string of 500 characters or fewer' });
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    }
  });

  it('a page longer than 500 characters returns 400 (page must be a string of 500 characters or fewer) and never touches the store', async () => {
    // 501 characters is the first length the guard rejects; the other fields are
    // valid so the page length is unambiguously what trips the 400.
    const { captured, loadCalls, saveCalls } = await invokeReact({
      body: { ...VALID, page: 'a'.repeat(501) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'page must be a string of 500 characters or fewer' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('a non-string commentId returns 400 (commentId must be a string of 200 characters or fewer) and never touches the store', async () => {
    // page is a valid string, so the page guard clears and a truthy non-string
    // commentId trips `typeof commentId !== 'string'`.
    for (const commentId of [42, true, { k: 'v' }, ['x']]) {
      const { captured, loadCalls, saveCalls } = await invokeReact({ body: { ...VALID, commentId } });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'commentId must be a string of 200 characters or fewer' });
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    }
  });

  it('a commentId longer than 200 characters returns 400 (commentId must be a string of 200 characters or fewer) and never touches the store', async () => {
    // 201 characters is the first length the guard rejects; page is valid so the
    // commentId length is unambiguously what trips the 400.
    const { captured, loadCalls, saveCalls } = await invokeReact({
      body: { ...VALID, commentId: 'c'.repeat(201) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'commentId must be a string of 200 characters or fewer' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('a non-string userId returns 400 (userId must be a string of 200 characters or fewer) and never touches the store', async () => {
    // page and commentId are valid strings, so their guards clear and a truthy
    // non-string userId trips `typeof userId !== 'string'`.
    for (const userId of [42, true, { k: 'v' }, ['x']]) {
      const { captured, loadCalls, saveCalls } = await invokeReact({ body: { ...VALID, userId } });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'userId must be a string of 200 characters or fewer' });
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    }
  });

  it('a userId longer than 200 characters returns 400 (userId must be a string of 200 characters or fewer) and never touches the store', async () => {
    // 201 characters is the first length the guard rejects; page and commentId
    // are valid so the userId length is unambiguously what trips the 400.
    const { captured, loadCalls, saveCalls } = await invokeReact({
      body: { ...VALID, userId: 'u'.repeat(201) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'userId must be a string of 200 characters or fewer' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('an emoji outside the allowed set returns 400 (Invalid emoji ...) and never touches the store', async () => {
    // page, commentId, and userId are valid, so the emoji guard is the last one
    // left. Only thumbsup/heart/laugh/thinking/celebrate pass, and the check is
    // case-sensitive, so each of these (including a near miss and a glyph) trips.
    for (const emoji of ['fire', 'smile', 'thumbsupp', 'Heart', '👍']) {
      const { captured, loadCalls, saveCalls } = await invokeReact({ body: { ...VALID, emoji } });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, {
        error: 'Invalid emoji. Must be one of: thumbsup, heart, laugh, thinking, celebrate',
      });
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    }
  });
});
