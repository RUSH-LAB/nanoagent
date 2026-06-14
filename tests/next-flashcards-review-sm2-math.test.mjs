import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the REAL route module the way the sibling
// tests/next-studyknow-review-input-guards.test.mjs and
// tests/next-studyknow-write-ownprop-guard.test.mjs do. This file adds no export
// and edits no source: it only drives the existing POST /api/flashcards/review
// handler over a fully mocked ctx and pins the SM-2 spaced-repetition card
// mutation on the 200 success path (server/routes/study-knowledge.js, the math at
// lines 115 to 133), which no test currently asserts by value.
//
// Distinct from the GET /api/flashcards/review handler in misc-tools.js that
// tests/next-flashcards-review-protokey-guard.test.mjs covers; the goldens below
// were captured from THIS handler, not hand-computed.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// Drive POST /api/flashcards/review with a minimal mocked ctx. Every helper is a
// stub, so no real filesystem, network, or randomness is touched; only Date is
// real (the handler derives nextReview and lastReviewed from it), so those two
// clock fields are checked for type and presence only, never by value. loadJSON
// returns the supplied in-memory store and the load/save counters pin that a
// successful review reads once and writes once. Mirrors the sibling ctx shape
// (rateLimit, readBody, loadJSON, saveJSON, sanitizeText, json).
async function review({ body, store }) {
  const pathname = '/api/flashcards/review';
  const url = new URL('http://localhost/api/flashcards/review');
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const data = store;
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp',
    FLASHCARDS_FILE: '/tmp/study-knowledge-flashcards.json',
    MAX_TEXT_LENGTH: 100000,
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => { loadCalls++; return data; },
    saveJSON: () => { saveCalls++; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, data, loadCalls, saveCalls };
}

// Each fixture seeds a fresh card in the store so the in-place mutation starts
// from a known state, then reviews it at one in-range integer quality (the
// line-112 guard rejects quality outside 0 to 5). `golden` is the exact card the
// real handler produced for that input, captured by a throwaway probe and spliced
// in verbatim; the easeFactor literals are the shortest round-trippable forms
// (e.g. the lapse value 2.1799999999999997 is kept exact, never rounded to 2.18).
const FIXTURES = [
  {
    desc: 'repetitions 0, q 5: interval stays 1, repetitions becomes 1, easeFactor rises 2.5 to 2.6',
    card: { id: 'c1', front: 'F1', back: 'B1', interval: 1, easeFactor: 2.5, repetitions: 0 },
    quality: 5,
    golden: { id: 'c1', front: 'F1', back: 'B1', interval: 1, easeFactor: 2.6, repetitions: 1 },
  },
  {
    desc: 'repetitions 0, q 3: interval stays 1, repetitions becomes 1, easeFactor falls 2.5 to 2.36',
    card: { id: 'c2', front: 'F2', back: 'B2', interval: 1, easeFactor: 2.5, repetitions: 0 },
    quality: 3,
    golden: { id: 'c2', front: 'F2', back: 'B2', interval: 1, easeFactor: 2.36, repetitions: 1 },
  },
  {
    desc: 'repetitions 1, q 4: interval jumps to 6, repetitions becomes 2, easeFactor unchanged at q 4',
    card: { id: 'c3', front: 'F3', back: 'B3', interval: 1, easeFactor: 2.5, repetitions: 1 },
    quality: 4,
    golden: { id: 'c3', front: 'F3', back: 'B3', interval: 6, easeFactor: 2.5, repetitions: 2 },
  },
  {
    desc: 'repetitions 2, q 4: interval becomes round(6 * 2.5) = 15, repetitions becomes 3',
    card: { id: 'c4', front: 'F4', back: 'B4', interval: 6, easeFactor: 2.5, repetitions: 2 },
    quality: 4,
    golden: { id: 'c4', front: 'F4', back: 'B4', interval: 15, easeFactor: 2.5, repetitions: 3 },
  },
  {
    desc: 'repetitions 5, q 5: interval becomes round(100 * 2.6) = 260, repetitions becomes 6, easeFactor 2.6 to 2.7',
    card: { id: 'c5', front: 'F5', back: 'B5', interval: 100, easeFactor: 2.6, repetitions: 5 },
    quality: 5,
    golden: { id: 'c5', front: 'F5', back: 'B5', interval: 260, easeFactor: 2.7, repetitions: 6 },
  },
  {
    desc: 'q 2 lapse: repetitions resets to 0 and interval resets to 1 from a large prior interval',
    card: { id: 'c6', front: 'F6', back: 'B6', interval: 100, easeFactor: 2.5, repetitions: 5 },
    quality: 2,
    golden: { id: 'c6', front: 'F6', back: 'B6', interval: 1, easeFactor: 2.1799999999999997, repetitions: 0 },
  },
  {
    desc: 'q 0 lapse with low easeFactor: reset plus easeFactor clamped to the 1.3 floor',
    card: { id: 'c7', front: 'F7', back: 'B7', interval: 50, easeFactor: 1.32, repetitions: 3 },
    quality: 0,
    golden: { id: 'c7', front: 'F7', back: 'B7', interval: 1, easeFactor: 1.3, repetitions: 0 },
  },
];

// Pin one fixture: 200 with success true, exactly one read and one write, the
// deterministic card fields equal to the golden (clock fields excluded), and the
// persisted store holding the same mutated card. nextReview and lastReviewed are
// derived from new Date(), so they are asserted as present strings only.
async function assertReview(fx) {
  const r = await review({
    body: { cardId: fx.card.id, quality: fx.quality },
    store: { default: [{ ...fx.card }] },
  });

  assert.equal(r.captured.status, 200);
  assert.equal(r.captured.payload.success, true);
  assert.equal(r.loadCalls, 1);
  assert.equal(r.saveCalls, 1);

  const card = r.captured.payload.card;
  assert.equal(typeof card.nextReview, 'string');
  assert.equal(typeof card.lastReviewed, 'string');

  // Strip the clock-derived fields, then deep-equal the rest against the golden:
  // this pins interval, easeFactor, repetitions, and the untouched id/front/back
  // pass-through, and proves no unexpected field was added.
  const { nextReview, lastReviewed, ...deterministic } = card;
  assert.deepEqual(deterministic, fx.golden);

  // The handler mutates the loaded card in place and persists it, so the store it
  // hands to saveJSON holds the same deterministic fields.
  const stored = r.data.default[0];
  const { nextReview: _sn, lastReviewed: _sl, ...storedDeterministic } = stored;
  assert.deepEqual(storedDeterministic, fx.golden);
}

describe('POST /api/flashcards/review SM-2 math (200 success path)', () => {
  for (const fx of FIXTURES) {
    it(fx.desc, async () => {
      await assertReview(fx);
    });
  }
});
