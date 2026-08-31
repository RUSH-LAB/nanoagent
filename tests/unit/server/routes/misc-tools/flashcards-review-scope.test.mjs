/**
 * GET /api/flashcards/review: whose cards it returns, and in what order.
 *
 * This suite began as a guard on an own-property check. The deck was a plain
 * object keyed by user id, so a caller whose id was `toString` or `constructor`
 * read back an inherited function instead of an array, defeated the `|| []`
 * fallback, and hung the request on `.filter`. There is no such object now: the
 * deck is rows in one person's scope and the id is a bound SQL parameter, which
 * has no inherited members to resolve to.
 *
 * What is still worth pinning is what that guard was standing in for. An
 * awkwardly named account gets its own cards and nobody else's, an account with
 * no cards gets an empty list rather than an error, and the due filter and its
 * sort behave. Those are properties of the endpoint; the own-key check was an
 * implementation detail of one way of storing it.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke, TEST_IDENTITY} from '../../../_harness.mjs';

const routes = loadRoute('misc-tools');
const asUser = userId => ({...TEST_IDENTITY, userId});

/** Cards that straddle the due cutoff, seeded out of order so the sort shows. */
const CARDS = [
  {id: 'fc1', front: 'Q1', back: 'A1', nextReview: '2001-06-15'},
  {id: 'fc2', front: 'Q2', back: 'A2', nextReview: '2999-12-31'},
  {id: 'fc3', front: 'Q3', back: 'A3', nextReview: '2000-01-01'},
];

/** Alice's deck, in a ctx backed by the real store. */
function withAlicesDeck() {
  const ctx = makeCtx();
  const scope = ctx.scopeFor({auth: asUser('alice')});
  for (const card of CARDS) ctx.scoped.collection('flashcards').put(scope, card.id, card);
  return ctx;
}

const due = (ctx, userId) =>
  invoke(routes, {path: '/api/flashcards/review', ctx, auth: asUser(userId)});

describe('GET /api/flashcards/review', () => {
  it('returns the past-due cards, soonest review first', async () => {
    const r = await due(withAlicesDeck(), 'alice');
    assert.equal(r.status, 200);
    assert.equal(r.payload.count, 2, 'fc2 is not due until 2999');
    assert.deepEqual(r.payload.cards.map(c => c.id), ['fc3', 'fc1'], '2000 sorts ahead of 2001');
  });

  // server/auth.js refuses a session subject named __proto__, constructor or
  // prototype outright, so the ones that can still reach a handler are the
  // merely inherited names. Each used to be the failure case; each is now just
  // an account with no cards.
  for (const userId of ['constructor', 'toString', 'valueOf', 'nobody']) {
    it(`returns an empty result for ${JSON.stringify(userId)}, who has no cards`, async () => {
      const r = await due(withAlicesDeck(), userId);
      assert.deepEqual([r.status, r.payload], [200, {cards: [], count: 0}]);
    });
  }

  it('does not show one member another member\'s due cards', async () => {
    const ctx = withAlicesDeck();
    const hers = await due(ctx, 'alice');
    const his = await due(ctx, 'bob');
    assert.equal(hers.payload.count, 2);
    assert.equal(his.payload.count, 0);
  });
});
