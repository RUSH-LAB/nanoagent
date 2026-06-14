import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load the REAL shipped route module the way the
// sibling tests/next-comments-create-guards.test.mjs and the other server route
// tests do, so these cases exercise the actual POST /api/comments create handler
// (server/routes/comments-notes.js: the comment built at lines 58-65 and returned
// via json(res, 200, {comment}) at line 68) instead of a reimplementation.
//
// This file adds no export and edits no source: it only drives the existing handler
// over a fully mocked ctx and pins the COMPUTED comment body on the 200 success
// path, which no current test asserts by value. next-comments-create-guards reaches
// this same 200 path but asserts only the DEFAULT arms (author 'Anonymous',
// parentId/userId null), text, and the presence/type of id/createdAt, never the
// POPULATED author/parentId/userId echo nor the full comment shape;
// next-comments-write-ownprop-guard asserts only comment.text; and
// next-comments-dedup-protokeys asserts only the error/success payloads. So the
// populated echo arms, the per-field sanitizeText routing, and the exact key set are
// all unpinned today.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// Drive the real POST /api/comments handler over a minimal mocked ctx and capture
// the (status, payload) handed to json(res, status, payload). loadJSON returns the
// supplied in-memory comments store and saveCount records the single persist, so no
// real filesystem, network, or randomness is touched; only Date.now / Math.random /
// Date drive id and createdAt, which are asserted for shape only and stripped before
// any deep-equal. A fresh store is built per call (the default parameter evaluates on
// each invocation), so no case can pollute another through shared mutable state.
async function invoke({ body = {}, comments = {}, sanitizeText } = {}) {
  const pathname = '/api/comments';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saveCount = 0;
  const ctx = {
    COMMENTS_FILE: '/tmp/comments-create-body-test.json',
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => comments,
    saveJSON: () => { saveCount += 1; },
    sanitizeText: sanitizeText || ((s) => s),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { captured, saveCount, store: comments };
}

// A tagged sanitizeText spy: it marks every value it processes with a visible prefix
// so the comment transform's per-field sanitizeText routing is provably exercised,
// while preserving the real server-utils sanitizeText falsy contract
// (str => typeof str !== 'string' ? '' : str.slice(0, 10000)) — it returns '' for an
// empty string or any non-string. The validated create guards (author <= 100,
// parentId/userId <= 200, text <= 5000, each rejected before the body is built when
// non-string) keep every value well under the 10000 slice, so the only observable
// sanitizeText effect on this path is that falsy contract, which the tag faithfully
// preserves: an empty-string author still sanitizes to '' (driving the `|| 'Anonymous'`
// default), and an empty-string parentId/userId is falsy in the `parentId ? : null` /
// `userId ? : null` ternaries (driving the null arms).
const SANITIZE_TAG = 'S:';
const taggedSanitize = (s) => (typeof s === 'string' && s ? SANITIZE_TAG + s : '');

describe('POST /api/comments create body (200 success path)', () => {
  it('pins the full populated comment body against the golden, asserts the key set, then persists it (id/createdAt stripped)', async () => {
    // Golden captured from the real handler via a throwaway probe under the tagged
    // sanitizeText: author/text/parentId/userId each route through the spy and so
    // carry the 'S:' prefix, proving every field is sanitized rather than echoed raw.
    // (The null default for an omitted/empty parentId/userId is pinned by the two
    // cases below; here all four arms are populated.)
    const GOLDEN = {
      author: 'S:alice',
      text: 'S:hello world',
      parentId: 'S:c_parent_1',
      userId: 'S:u_42',
    };

    const { captured, saveCount, store } = await invoke({
      body: { page: 'docs/intro', author: 'alice', text: 'hello world', parentId: 'c_parent_1', userId: 'u_42' },
      sanitizeText: taggedSanitize,
    });

    assert.equal(captured.status, 200);
    const { comment } = captured.payload;

    // The clock/random fields are non-deterministic: assert only their shape, then
    // strip them so the deep-equal pins the reproducible body.
    assert.equal(typeof comment.id, 'string');
    assert.match(comment.id, /^c_\d+_[a-z0-9]*$/);
    assert.equal(typeof comment.createdAt, 'string');
    assert.match(comment.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // ...and round-trips as an ISO timestamp.
    assert.equal(new Date(comment.createdAt).toISOString(), comment.createdAt);

    // Full key set: an added or removed field is caught here.
    assert.deepEqual(
      Object.keys(comment).sort(),
      ['author', 'createdAt', 'id', 'parentId', 'text', 'userId'],
    );

    const { id, createdAt, ...deterministic } = comment;
    assert.deepEqual(deterministic, GOLDEN);

    // Control: the handler pushes the very comment it returns into the store under
    // the requested page, then saves exactly once.
    assert.equal(saveCount, 1);
    assert.equal(store['docs/intro'].length, 1);
    assert.equal(store['docs/intro'][0], comment);
  });

  it('applies the default arms when author/parentId/userId are omitted (author -> Anonymous, parentId/userId -> null)', async () => {
    const { captured, saveCount, store } = await invoke({
      body: { page: 'docs/intro', text: 'hello' },
      sanitizeText: taggedSanitize,
    });

    assert.equal(captured.status, 200);
    const { comment } = captured.payload;

    assert.match(comment.id, /^c_\d+_[a-z0-9]*$/);
    assert.equal(new Date(comment.createdAt).toISOString(), comment.createdAt);
    assert.deepEqual(
      Object.keys(comment).sort(),
      ['author', 'createdAt', 'id', 'parentId', 'text', 'userId'],
    );

    // author is the untagged constant default (sanitizeText(undefined) === '' is
    // falsy, so `|| 'Anonymous'` wins), while text still carries the 'S:' tag, which
    // proves the spy ran on this path rather than the author simply being echoed.
    const { id, createdAt, ...deterministic } = comment;
    assert.deepEqual(deterministic, {
      author: 'Anonymous',
      text: 'S:hello',
      parentId: null,
      userId: null,
    });

    // Control: still a single persist, and the returned comment is the stored one.
    assert.equal(saveCount, 1);
    assert.equal(store['docs/intro'][0], comment);
  });

  it('treats empty-string author/parentId/userId as the falsy arms (author -> Anonymous, parentId/userId -> null), distinct from a populated value', async () => {
    const { captured } = await invoke({
      body: { page: 'docs/intro', text: 'hello', author: '', parentId: '', userId: '' },
      sanitizeText: taggedSanitize,
    });

    assert.equal(captured.status, 200);
    const { comment } = captured.payload;

    // sanitizeText('') === '' is falsy, so `sanitizeText(author) || 'Anonymous'` -> 'Anonymous'.
    assert.equal(comment.author, 'Anonymous');
    // The `parentId ? : null` / `userId ? : null` ternaries test the RAW body value,
    // and '' is falsy, so both collapse to null rather than the tagged sanitize of ''.
    // (Contrast the populated case above, where they echo the 'S:'-tagged value.)
    assert.equal(comment.parentId, null);
    assert.equal(comment.userId, null);
    // text is always a validated non-empty string, so it routes through sanitizeText.
    assert.equal(comment.text, 'S:hello');
  });
});
