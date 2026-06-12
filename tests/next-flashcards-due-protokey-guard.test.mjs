import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// Invoke a flashcards GET handler with a minimal mocked ctx and capture the
// response handed to json(res, status, payload). loadJSON returns the supplied
// deck verbatim: a plain object literal, so inherited keys like constructor and
// toString resolve to truthy values exactly as they would on the real loadJSON
// result. The read paths never write, so saveJSON is unneeded.
async function invoke({ pathname, userId, data }) {
  const query = userId === undefined ? '' : `?userId=${encodeURIComponent(userId)}`;
  const url = new URL(`http://localhost${pathname}${query}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp',
    loadJSON: () => data,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return captured;
}

// One real user whose cards straddle the due cutoff: a long-past review date is
// always due, a far-future one never is. The literal defines no own
// constructor, toString, or __proto__ key, so each resolves to its inherited
// Object.prototype member when read without the Object.hasOwn guard, turning the
// `|| []` fallback into a truthy non-array that throws on .filter / leaks length.
const FLASHCARDS = {
  alice: [
    { id: 'fc1', front: 'Q1', back: 'A1', nextReview: '2000-01-01' },
    { id: 'fc2', front: 'Q2', back: 'A2', nextReview: '2999-12-31' },
  ],
};

const PROTO_KEYS = ['constructor', 'toString', '__proto__'];

describe('GET /api/flashcards own-property userId guard', () => {
  for (const userId of PROTO_KEYS) {
    it(`returns an empty deck for the inherited key "${userId}"`, async () => {
      const r = await invoke({ pathname: '/api/flashcards', userId, data: FLASHCARDS });
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload, { cards: [], total: 0 });
    });
  }

  it('returns the stored deck for a real own-key user', async () => {
    const r = await invoke({ pathname: '/api/flashcards', userId: 'alice', data: FLASHCARDS });
    assert.equal(r.status, 200);
    assert.equal(r.payload.total, 2);
    assert.deepEqual(r.payload.cards, FLASHCARDS.alice);
  });

  it('returns an empty deck for an absent ordinary userId', async () => {
    const r = await invoke({ pathname: '/api/flashcards', userId: 'nobody', data: FLASHCARDS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { cards: [], total: 0 });
  });
});

describe('GET /api/flashcards/due own-property userId guard', () => {
  for (const userId of PROTO_KEYS) {
    it(`returns no due cards for the inherited key "${userId}"`, async () => {
      const r = await invoke({ pathname: '/api/flashcards/due', userId, data: FLASHCARDS });
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload, { cards: [], dueCount: 0 });
    });
  }

  it('returns only the past-due cards for a real own-key user', async () => {
    const r = await invoke({ pathname: '/api/flashcards/due', userId: 'alice', data: FLASHCARDS });
    assert.equal(r.status, 200);
    assert.equal(r.payload.dueCount, 1);
    assert.deepEqual(r.payload.cards, [FLASHCARDS.alice[0]]);
  });
});
