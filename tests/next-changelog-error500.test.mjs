import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Characterization test for the outer catch behind GET /api/changelog in
// server/routes/misc-tools.js. The whole handler body runs inside one try
// (opens at line 109); the first failable store read is loadJSON(COMMENTS_FILE)
// at line 112 (the numericParam limit clamp at line 110 is pure and never
// throws). When that load throws, control falls to the bare catch at lines 130
// and 131, which answers json(res, 500, {error: 'Changelog failed'}) and never
// reaches the success projection json(res, 200, {events, total}). This file pins
// that failure path only; the 200 projection shape and sort are owned by
// tests/next-changelog-projection-shape.test.mjs. The source stays untouched.

// misc-tools.js is CommonJS; load the real module the way the sibling server
// route tests do, so this drives the genuine handler, not a reimplementation.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../server/routes/misc-tools.js');

// File tokens the changelog handler reads through loadJSON. COMMENTS_FILE is the
// first of the two loads, so a loadJSON that throws on its first call models an
// unreadable comments store and trips the outer catch before anything else runs.
const COMMENTS_FILE = '/tmp/next-changelog-comments.json';
const DISCUSSIONS_FILE = '/tmp/next-changelog-discussions.json';

// Drive GET /api/changelog with a mocked ctx, recording every reply the handler
// hands to json(res, status, payload). Mirrors the invoke helper in the
// projection-shape success test, with loadJSON flipped to throw. Recording all
// replies (not just the last) lets the test prove the 200 projection is never
// emitted. Fully in process: no network, no server, no disk.
async function getChangelogReplies(ctx) {
  const pathname = '/api/changelog';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const replies = [];
  const fullCtx = {
    json(_res, status, payload) {
      const reply = { status, payload };
      replies.push(reply);
      res.writableEnded = true;
      return reply;
    },
    ...ctx,
  };
  await miscToolsRoutes(req, res, url, pathname, fullCtx);
  return replies;
}

// A ctx whose loadJSON throws on its first call (the COMMENTS_FILE read) and
// records each call, so the test can prove the catch fired at the first failable
// load: before the DISCUSSIONS_FILE read and before any success reply. Mirrors
// the throwOnLoad plus calls.loadJSON pattern in next-analytics-export-csv.test.mjs,
// reusing the changelogCtx shape from next-changelog-projection-shape.test.mjs.
function throwingCtx() {
  const calls = { loadJSON: [] };
  const ctx = {
    loadJSON(file) {
      calls.loadJSON.push(file);
      throw new Error('comments store unreadable');
    },
    COMMENTS_FILE,
    DISCUSSIONS_FILE,
  };
  return { ctx, calls };
}

describe('GET /api/changelog outer catch', () => {
  it('returns 500 Changelog failed when the first loadJSON throws, never emitting the 200 projection', async () => {
    const { ctx, calls } = throwingCtx();
    const replies = await getChangelogReplies(ctx);

    // Exactly one reply, and it is the outer-catch 500 envelope verbatim. The
    // single-element array is itself proof that the success json(res, 200,
    // {events, total}) call never ran; it would have pushed a second reply.
    assert.deepStrictEqual(replies, [{ status: 500, payload: { error: 'Changelog failed' } }]);

    // State the never-200 guarantee the GOAL asks for explicitly: no reply ever
    // carries the success status or the {events, total} projection payload.
    assert.ok(!replies.some(r => r.status === 200), 'the success 200 projection is never emitted');

    // The throw lands on the very first load, so loadJSON is called exactly once
    // with COMMENTS_FILE; the DISCUSSIONS_FILE read and the sort/slice never run.
    assert.deepStrictEqual(calls.loadJSON, [COMMENTS_FILE]);
  });
});
