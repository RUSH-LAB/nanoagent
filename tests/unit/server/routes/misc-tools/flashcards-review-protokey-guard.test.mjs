import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// misc-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../src/server/routes/misc-tools.js');

// Drive the GET /api/flashcards/review handler with a minimal mocked ctx and
// capture the response handed to json(res, status, payload). loadJSON returns
// the supplied deck verbatim: a plain object literal, so inherited keys like
// constructor and toString resolve to truthy values exactly as they would on
// the real loadJSON result. The read path never writes, so saveJSON is unneeded.
async function invoke({ userId, data }) {
  const url = new URL('http://localhost/api/flashcards/review');
  // The deck is keyed on the session subject, which server/index.js resolves
  // from the Clerk token and attaches as req.auth before any handler runs.
  const auth = { userId, orgId: null, orgRole: null, sessionId: null };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, auth };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    FLASHCARDS_FILE: '/tmp/misc-tools-flashcards-review.json',
    loadJSON: () => data,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await miscToolsRoutes(req, res, url, '/api/flashcards/review', ctx);
  return captured;
}

// One real user whose cards straddle the due cutoff, listed out of order so the
// handler's nextReview sort is observable: two long-past reviews are always due,
// a far-future one never is. The literal defines no own constructor, toString,
// or __proto__ key, so each resolves to its inherited Object.prototype member
// when read without the Object.hasOwn guard, turning the `|| []` fallback into a
// truthy non-array that throws on .filter and hangs the request.
const FLASHCARDS = {
  alice: [
    { id: 'fc1', front: 'Q1', back: 'A1', nextReview: '2001-06-15' },
    { id: 'fc2', front: 'Q2', back: 'A2', nextReview: '2999-12-31' },
    { id: 'fc3', front: 'Q3', back: 'A3', nextReview: '2000-01-01' },
  ],
};

// server/auth.js rejects a token whose subject is one of the three prototype
// names outright, so only the inherited-but-legal members can still reach the
// handler. They are the ones that make the missing-guard failure mode real: each
// resolves to a truthy inherited function, defeating the `|| []` fallback.
const PROTO_KEYS = ['constructor', 'toString'];

describe('GET /api/flashcards/review own-property userId guard', () => {
  for (const userId of PROTO_KEYS) {
    it(`returns no due cards for the inherited key "${userId}"`, async () => {
      const r = await invoke({ userId, data: FLASHCARDS });
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload, { cards: [], count: 0 });
    });
  }

  it('returns the past-due cards sorted by nextReview for a real own-key user', async () => {
    const r = await invoke({ userId: 'alice', data: FLASHCARDS });
    assert.equal(r.status, 200);
    assert.equal(r.payload.count, 2);
    // fc2 is filtered out as not yet due; fc3 (2000) sorts ahead of fc1 (2001).
    assert.deepEqual(r.payload.cards, [FLASHCARDS.alice[2], FLASHCARDS.alice[0]]);
  });

  it('returns an empty result for an absent ordinary userId', async () => {
    const r = await invoke({ userId: 'nobody', data: FLASHCARDS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { cards: [], count: 0 });
  });
});
