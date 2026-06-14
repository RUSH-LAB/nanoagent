import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the REAL shipped route module the way the
// sibling tests/next-flashcards-create-guards.test.mjs and
// tests/next-flashcards-review-sm2-math.test.mjs do, so these cases exercise the
// actual POST /api/flashcards create handler rather than a reimplementation.
//
// This file adds no export and edits no source: it only drives the existing
// handler over a fully mocked ctx and pins the COMPUTED card body on the 200
// success path (server/routes/study-knowledge.js, the card built at lines 69-80
// and returned at line 83), which no test currently asserts by value. The
// sibling next-studyknow-write-ownprop-guard.test.mjs hits this same 200 path but
// asserts only payload.success, the presence of payload.card, the persisted id,
// and saveCalls, leaving the card FIELDS unpinned; next-flashcards-create-guards
// is reject-only; next-flashcards-review-sm2-math pins the DIFFERENT review
// handler's post-mutation card, not this create seed.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// Drive the real POST /api/flashcards handler over a minimal mocked ctx and
// capture the (status, payload) handed to json(res, status, payload). loadJSON
// returns the supplied in-memory store and saveCalls records the single persist,
// so no real filesystem, network, or randomness is touched. Only Date.now,
// Math.random, and Date drive the id / nextReview / createdAt fields, which are
// asserted for shape only and stripped before any deep-equal. sanitizeText
// defaults to identity (the shape the sibling harnesses use, and faithful here:
// the real server-utils sanitizeText only slices at MAX_TEXT_LENGTH = 10000, and
// the validated 5000/500 caps on front/back/sourcePath keep those three well under
// it; tag elements carry no per-element length cap, but the captured golden passes
// only short tags, so identity is a no-op on every value this test actually sends);
// a case may override it with a tagged spy to make the tags map
// and the sourcePath slice observable.
async function invoke({ body, store, sanitizeText }) {
  const pathname = '/api/flashcards';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const data = store || {};
  let captured = null;
  let saveCalls = 0;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp',
    FLASHCARDS_FILE: '/tmp/study-knowledge-flashcards.json',
    // Inert on this path (the handler never reads ctx.MAX_TEXT_LENGTH here, and
    // sanitizeText is injected above); kept only to mirror the sibling
    // study-knowledge harness, hence the mock value rather than the real 10000.
    MAX_TEXT_LENGTH: 100000,
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => data,
    saveJSON: () => { saveCalls++; },
    sanitizeText: sanitizeText || ((s) => s),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, data, saveCalls };
}

// A tagged sanitizeText spy: it marks every value it processes with a visible
// prefix so the card transform's map / slice are provably exercised, while
// preserving the real sanitizeText falsy contract (it returns '' for an empty
// string or any non-string input).
const SANITIZE_TAG = 'S:';
const taggedSanitize = (s) => (typeof s === 'string' && s ? SANITIZE_TAG + s : '');

describe('POST /api/flashcards create card body (200 success path)', () => {
  // The deterministic golden, captured from the real handler via a throwaway
  // probe under the identity sanitizeText above. front/back/tags/sourcePath pass
  // through unchanged (identity), and interval/easeFactor/repetitions are the
  // hard-coded SM-2 seed constants from lines 75-77. id, nextReview, and createdAt
  // are clock/random derived, so they are stripped before this deep-equal and
  // checked for shape separately below.
  const GOLDEN = {
    front: 'What is the capital of France?',
    back: 'Paris',
    tags: ['geography', 'capitals'],
    sourcePath: 'content/notes/europe.md',
    interval: 1,
    easeFactor: 2.5,
    repetitions: 0,
  };

  it('pins the full card body against the golden, then persists it (id/nextReview/createdAt stripped)', async () => {
    const { captured, data, saveCalls } = await invoke({
      body: {
        userId: 'alice',
        front: 'What is the capital of France?',
        back: 'Paris',
        tags: ['geography', 'capitals'],
        sourcePath: 'content/notes/europe.md',
      },
    });

    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    const card = captured.payload.card;

    // The clock/random fields are non-deterministic: assert only their shape, then
    // strip them so the deep-equal pins the reproducible body and proves no
    // unexpected field was added.
    assert.equal(typeof card.id, 'string');
    assert.match(card.id, /^fc_\d+_[a-z0-9]*$/);
    assert.equal(typeof card.nextReview, 'string');
    assert.match(card.nextReview, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof card.createdAt, 'string');
    assert.match(card.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const { id, nextReview, createdAt, ...deterministic } = card;
    assert.deepEqual(deterministic, GOLDEN);

    // The handler pushes the very card it returns into the store under the
    // requested userId, then saves exactly once.
    assert.equal(saveCalls, 1);
    assert.equal(data.alice.length, 1);
    assert.equal(data.alice[0], card);
  });

  describe('tags arm', () => {
    it('caps tags at the first 10 and runs sanitizeText over each (tagged spy, 12 tags in)', async () => {
      const { captured } = await invoke({
        body: { front: 'Q', back: 'A', tags: Array.from({ length: 12 }, (_, i) => 't' + i) },
        sanitizeText: taggedSanitize,
      });

      assert.equal(captured.status, 200);
      // Exactly the first 10, each carrying the spy prefix: this is non-vacuous on
      // both the slice(0, 10) cap (t10 and t11 are dropped) and the per-element map
      // (every survivor is tagged).
      assert.deepEqual(captured.payload.card.tags, [
        'S:t0', 'S:t1', 'S:t2', 'S:t3', 'S:t4',
        'S:t5', 'S:t6', 'S:t7', 'S:t8', 'S:t9',
      ]);
    });

    it('sets tags to [] when tags is absent (the Array.isArray(tags) false branch)', async () => {
      // Absent tags is the only non-array value that reaches this branch: a
      // non-array, non-undefined tags (e.g. a string) is rejected by the line-63
      // guard with a 400 before the card is built, so it never produces []. (That
      // reject path is pinned by next-flashcards-create-guards.test.mjs.)
      const { captured } = await invoke({ body: { front: 'Q', back: 'A' } });
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.payload.card.tags, []);
    });
  });

  describe('sourcePath arm', () => {
    it('sanitizes then slices sourcePath to 500 chars (tagged spy forces post-sanitize > 500)', async () => {
      // The line-65 guard rejects a raw sourcePath longer than 500 chars, so the
      // slice(0, 500) only bites when sanitizeText itself grows the value past 500.
      // A 500-char raw input clears the guard, and the spy prefix pushes the
      // sanitized value to 502 chars, so the slice provably truncates.
      const raw = 'a'.repeat(500);
      const expected = (SANITIZE_TAG + raw).slice(0, 500);
      const { captured } = await invoke({
        body: { front: 'Q', back: 'A', sourcePath: raw },
        sanitizeText: taggedSanitize,
      });

      assert.equal(captured.status, 200);
      const sourcePath = captured.payload.card.sourcePath;
      assert.equal(sourcePath, expected);
      assert.equal(sourcePath.length, 500);
      assert.ok(sourcePath.startsWith(SANITIZE_TAG)); // sanitizeText ran
      assert.equal((SANITIZE_TAG + raw).length, 502);  // pre-slice length...
      assert.notEqual(sourcePath, SANITIZE_TAG + raw); // ...so the slice dropped the tail
    });

    it('sets sourcePath to null when absent', async () => {
      const { captured } = await invoke({ body: { front: 'Q', back: 'A' } });
      assert.equal(captured.status, 200);
      assert.equal(captured.payload.card.sourcePath, null);
    });
  });

  it('seeds the SM-2 spaced-repetition constants interval 1, easeFactor 2.5, repetitions 0', async () => {
    const { captured } = await invoke({ body: { front: 'Q', back: 'A' } });
    assert.equal(captured.status, 200);
    const card = captured.payload.card;
    assert.equal(card.interval, 1);
    assert.equal(card.easeFactor, 2.5);
    assert.equal(card.repetitions, 0);
  });
});
