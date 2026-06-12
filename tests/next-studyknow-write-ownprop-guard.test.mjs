import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// Drive a study-knowledge write/mutate handler with a minimal mocked ctx and
// capture the response handed to json(res, status, payload). loadJSON returns the
// supplied store verbatim (a plain object literal), so inherited names like
// toString, valueOf, and hasOwnProperty resolve to truthy values exactly as they
// would on the real loadJSON result. The own-property guard is what stops those
// inherited names from skipping the init/404 guard and crashing the following
// .push/.findIndex/.find into a swallowed 400. `Object` is never injected, so the
// handler relies on the real global Object.hasOwn.
async function invoke({ method, pathname, body, store }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const data = store || {};
  let captured = null;
  let saveCalls = 0;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp',
    FLASHCARDS_FILE: '/tmp/study-knowledge-flashcards.json',
    MAX_TEXT_LENGTH: 100000,
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => data,
    saveJSON: () => { saveCalls++; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, data, saveCalls };
}

// Inherited Object.prototype member names. On a plain object literal each resolves
// to a truthy inherited function, so the pre-fix bare `data[uid]` truthiness test
// skipped the own-key init / 404 guard and let the next array call throw.
const INHERITED = ['toString', 'valueOf', 'hasOwnProperty'];

const fcPost = (userId) => ({ userId, front: 'Q', back: 'A' });
const qnPost = (userId) => ({ userId, text: 'a quick note' });

describe('POST /api/flashcards own-property userId guard', () => {
  // Before the fix, an inherited-name uid made `if (!data[uid])` skip the array
  // init, so `data[uid].push` threw a TypeError that the try/catch turned into a
  // misleading 400. The own-property guard creates the array under the requested
  // key and the card persists.
  for (const userId of INHERITED) {
    it(`persists a card under the inherited userId "${userId}" (200, own key created)`, async () => {
      const { captured, data, saveCalls } = await invoke({
        method: 'POST', pathname: '/api/flashcards', body: fcPost(userId),
      });
      assert.equal(captured.status, 200);
      assert.equal(captured.payload.success, true);
      assert.ok(captured.payload.card);
      assert.ok(Object.hasOwn(data, userId));
      assert.equal(data[userId].length, 1);
      assert.equal(data[userId][0].id, captured.payload.card.id);
      assert.equal(saveCalls, 1);
    });
  }

  it('persists a card for the default userId when none is supplied (200)', async () => {
    const { captured, data, saveCalls } = await invoke({
      method: 'POST', pathname: '/api/flashcards', body: { front: 'Q', back: 'A' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(data.default.length, 1);
    assert.equal(saveCalls, 1);
  });

  it('appends to an existing own-key user, leaving the prior card in place (200)', async () => {
    const store = { alice: [{ id: 'fc_existing' }] };
    const { captured, data, saveCalls } = await invoke({
      method: 'POST', pathname: '/api/flashcards', body: fcPost('alice'), store,
    });
    assert.equal(captured.status, 200);
    assert.equal(data.alice.length, 2);
    assert.equal(data.alice[0].id, 'fc_existing');
    assert.equal(saveCalls, 1);
  });
});

describe('POST /api/flashcards/review own-property userId guard', () => {
  // Before the fix, `(data[uid] || []).find(...)` ran .find on the inherited
  // function value and threw, swallowed into a 400. The own-property form falls
  // back to an empty array, so an inherited-name user yields a clean 404.
  for (const userId of INHERITED) {
    it(`returns 404 (not a swallowed 400) for the inherited userId "${userId}"`, async () => {
      const { captured, saveCalls } = await invoke({
        method: 'POST', pathname: '/api/flashcards/review',
        body: { userId, cardId: 'fc_missing', quality: 4 },
      });
      assert.equal(captured.status, 404);
      assert.deepEqual(captured.payload, { error: 'Card not found' });
      assert.equal(saveCalls, 0);
    });
  }

  it('reviews a card an own-key user owns (200)', async () => {
    const store = {
      alice: [{ id: 'fc1', front: 'Q', back: 'A', interval: 1, easeFactor: 2.5, repetitions: 0, nextReview: '2000-01-01' }],
    };
    const { captured, saveCalls } = await invoke({
      method: 'POST', pathname: '/api/flashcards/review',
      body: { userId: 'alice', cardId: 'fc1', quality: 4 }, store,
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(captured.payload.card.id, 'fc1');
    assert.equal(saveCalls, 1);
  });

  it('returns 404 for an absent ordinary userId', async () => {
    const { captured, saveCalls } = await invoke({
      method: 'POST', pathname: '/api/flashcards/review',
      body: { userId: 'nobody', cardId: 'fc1', quality: 4 },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.payload, { error: 'Card not found' });
    assert.equal(saveCalls, 0);
  });
});

describe('DELETE /api/flashcards own-property userId guard', () => {
  // For an absent inherited-name user the own-property guard returns a clean 404
  // instead of letting .findIndex throw on the inherited function (previously
  // swallowed into a 400). No write happens on the not-found path.
  for (const userId of INHERITED) {
    it(`returns 404 (not a swallowed 400) for the absent inherited userId "${userId}"`, async () => {
      const { captured, saveCalls } = await invoke({
        method: 'DELETE', pathname: '/api/flashcards',
        body: { userId, cardId: 'fc_missing' },
      });
      assert.equal(captured.status, 404);
      assert.deepEqual(captured.payload, { error: 'Card not found' });
      assert.equal(saveCalls, 0);
    });
  }

  it('deletes a card an own-key user owns (200)', async () => {
    const store = { alice: [{ id: 'fc1' }, { id: 'fc2' }] };
    const { captured, data, saveCalls } = await invoke({
      method: 'DELETE', pathname: '/api/flashcards',
      body: { userId: 'alice', cardId: 'fc1' }, store,
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(data.alice.length, 1);
    assert.equal(data.alice[0].id, 'fc2');
    assert.equal(saveCalls, 1);
  });

  it('returns 404 for an absent ordinary userId', async () => {
    const { captured, saveCalls } = await invoke({
      method: 'DELETE', pathname: '/api/flashcards',
      body: { userId: 'nobody', cardId: 'fc1' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.payload, { error: 'Card not found' });
    assert.equal(saveCalls, 0);
  });
});

describe('POST /api/quicknotes own-property userId guard', () => {
  // Same hazard as the flashcards POST: the inherited-name init guard now creates
  // the array under the requested key and the note persists.
  for (const userId of INHERITED) {
    it(`persists a note under the inherited userId "${userId}" (200, own key created)`, async () => {
      const { captured, data, saveCalls } = await invoke({
        method: 'POST', pathname: '/api/quicknotes', body: qnPost(userId),
      });
      assert.equal(captured.status, 200);
      assert.equal(captured.payload.success, true);
      assert.ok(captured.payload.note);
      assert.ok(Object.hasOwn(data, userId));
      assert.equal(data[userId].length, 1);
      assert.equal(data[userId][0].id, captured.payload.note.id);
      assert.equal(saveCalls, 1);
    });
  }

  it('persists a note for the default userId when none is supplied (200)', async () => {
    const { captured, data, saveCalls } = await invoke({
      method: 'POST', pathname: '/api/quicknotes', body: { text: 'note' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(data.default.length, 1);
    assert.equal(saveCalls, 1);
  });
});

describe('DELETE /api/quicknotes own-property userId guard', () => {
  // For an absent inherited-name user the own-property guard returns a clean 404
  // instead of letting .findIndex throw (previously swallowed into a 400).
  for (const userId of INHERITED) {
    it(`returns 404 (not a swallowed 400) for the absent inherited userId "${userId}"`, async () => {
      const { captured, saveCalls } = await invoke({
        method: 'DELETE', pathname: '/api/quicknotes',
        body: { userId, id: 'qn_missing' },
      });
      assert.equal(captured.status, 404);
      assert.deepEqual(captured.payload, { error: 'Note not found' });
      assert.equal(saveCalls, 0);
    });
  }

  it('deletes a note an own-key user owns (200)', async () => {
    const store = { alice: [{ id: 'qn1' }, { id: 'qn2' }] };
    const { captured, data, saveCalls } = await invoke({
      method: 'DELETE', pathname: '/api/quicknotes',
      body: { userId: 'alice', id: 'qn1' }, store,
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(data.alice.length, 1);
    assert.equal(data.alice[0].id, 'qn2');
    assert.equal(saveCalls, 1);
  });

  it('returns 404 for an absent ordinary userId', async () => {
    const { captured, saveCalls } = await invoke({
      method: 'DELETE', pathname: '/api/quicknotes',
      body: { userId: 'nobody', id: 'qn1' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.payload, { error: 'Note not found' });
    assert.equal(saveCalls, 0);
  });
});
