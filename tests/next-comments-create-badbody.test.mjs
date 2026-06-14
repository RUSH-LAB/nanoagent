import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// comments-notes.js is CommonJS; load the REAL shipped route module the way the
// sibling tests (tests/next-comments-create-guards.test.mjs and
// tests/next-comments-create-body.test.mjs) and the other server route tests do,
// so these cases exercise the actual POST /api/comments create handler
// (server/routes/comments-notes.js, the outer try/catch spanning lines 42 to 71)
// instead of a reimplementation.
//
// This file adds no export and edits no source: it only drives the existing handler
// over a fully mocked ctx and pins the OUTER CATCH error contract on the create path,
// which no current test asserts. Both sibling create tests ALWAYS resolve readBody to
// a valid object (next-comments-create-body literally `readBody: async () => body`),
// so the catch at line 70 is never entered there, and the FIXED 400 body it returns is
// unpinned today. Grep-proven on the live HEAD:
// `grep -rlF 'Failed to create comment: request body' tests/` returns 0.
const require = createRequire(import.meta.url);
const commentsNotesRoutes = require('../server/routes/comments-notes.js');

// The exact, fixed error body the outer catch returns (comments-notes.js line 70). It
// is a constant string literal, NOT err.message, so it is byte-identical for every
// failure cause routed through the catch. Copied verbatim from the source so a reworded
// message is caught by the deep-equal below.
const BADBODY_ERROR =
  'Failed to create comment: request body must be JSON with "page" (string) and "text" (string) fields';

// Drive the real POST /api/comments handler over a minimal mocked ctx whose readBody is
// the only knob: each case supplies a readBody that forces the failure routed into the
// outer catch. rateLimit returns true so the 429 gate at line 41 is passed and the try
// block is entered.
//
// loadJSON and saveJSON are zero-call TRIPWIRES: they count their calls AND throw if the
// handler ever reaches them. The count is the authoritative proof here, because both
// store calls sit INSIDE the same try (loadJSON at line 56, saveJSON at line 67), so a
// tripwire throw would be swallowed by the very catch under test and still surface as the
// fixed 400 body; the loadCount / saveCount === 0 assertions are what actually prove the
// catch fires BEFORE any store IO. The throw is a secondary guard for any future case
// that reaches the store outside the try.
//
// sanitizeText and COMMENTS_FILE round out the success-path ctx but the catch path
// reaches neither. (PROTO_KEYS, despite being named in the route's ctx destructure, is a
// frozen MODULE-LEVEL constant in comments-notes.js at line 9, not ctx-derived, so it is
// deliberately not supplied here; it is unreached on the catch path regardless.)
//
// A fresh recorder set is built per call, so no case can bleed into another.
async function invoke({ readBody } = {}) {
  const pathname = '/api/comments';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCount = 0;
  let saveCount = 0;
  const ctx = {
    COMMENTS_FILE: '/tmp/comments-create-badbody-test.json',
    rateLimit: () => true,
    readBody,
    loadJSON: () => { loadCount += 1; throw new Error('loadJSON must not run on the catch path'); },
    saveJSON: () => { saveCount += 1; throw new Error('saveJSON must not run on the catch path'); },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await commentsNotesRoutes(req, res, url, pathname, ctx);
  return { captured, loadCount, saveCount };
}

describe('POST /api/comments create badbody (outer catch error contract)', () => {
  it('returns the fixed 400 body when readBody REJECTS, without touching the store', async () => {
    // The `await readBody(req)` rejection throws straight into the outer catch.
    const { captured, loadCount, saveCount } = await invoke({
      readBody: async () => { throw new Error('bad json'); },
    });

    assert.equal(captured.status, 400);
    // Full body object pinned by value: a reworded or err.message-derived error fails here.
    assert.deepEqual(captured.payload, { error: BADBODY_ERROR });
    // Pre-IO: neither store function ran (the catch sits above both).
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns the same fixed 400 body when readBody RESOLVES null (destructure throws), beating the validation ladder', async () => {
    // `const {page, ...} = null` throws a TypeError into the same catch.
    const { captured, loadCount, saveCount } = await invoke({
      readBody: async () => null,
    });

    assert.equal(captured.status, 400);
    // Identical fixed string to the reject case: the catch ignores the failure cause.
    assert.deepEqual(captured.payload, { error: BADBODY_ERROR });
    // Precedence: the destructure throws BEFORE the first validation guard can return its
    // own 400, so the catch body wins over 'Missing or invalid page'. (The deep-equal
    // above already enforces this; asserted explicitly to document the precedence intent.)
    assert.notEqual(captured.payload.error, 'Missing or invalid page');
    // And it beats the store IO too: still zero loads and zero saves.
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });
});
